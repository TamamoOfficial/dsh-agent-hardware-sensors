// ============================================================================
// dsh-agent-hardware-sensors 挂件 —— 浏览器半边（纯 DOM，零依赖）
// ============================================================================
// 加载方式：宿主 index-inject 的内联 script 行 → GET /dsh-hw/widget.js。
//
// 为什么不用 React、也不 require 任何 @deepseek-ai/dsh-client-ui-*：
//   插件开发规范明确禁止第三方引用宿主客户端包（"它们会随时变动……一个抛错的组件
//   会让你的槽位整个空白"）。纯 DOM 最坏情况只是我们自己不显示，绝不会连累宿主渲染树。
//
// 与桌面端渲染树隔离的要点（鲸鱼挂件在 issue #154 之后总结的）：
//   · 脚本被注入到**每一个** index 页面（含插件市场等 SPA 视图）。市场页用
//     createPortal 渲染到 body，若我们在那里插节点/加全局捕获，会干扰 React 的
//     removeChild ⇒ 页面空白。所以必须先做页面自检，只在主聊天界面挂载。
//   · 一切失败都静默：路由 404（插件被关掉）、fetch 被拒、DOM 找不到 —— 不抛错、
//     不刷屏重试。
//
// 三档显示：完整 → 精简 → 隐藏（循环）。隐藏档留一个 8px 小圆点做退路，
// 免得用户关掉后再也没有找回的入口。位置可拖动，两处都记进 localStorage。
// ============================================================================
;(function () {
  if (window.__dshHwSensorsWidget) return
  window.__dshHwSensorsWidget = true

  // ── 单例守卫 ──────────────────────────────────────────────────────────────
  // 需求：整个 DSH 最多只显示一个硬件读数悬浮提示。
  // 上面的 window 标记挡住"同一页面重复执行脚本"；这里再兜一层——若宿主重载插件、
  // HMR 后旧 DOM 节点还留在页面上（window 标记已被重置换新），脚本一加载就把
  // 遗留节点清掉，保证任何时刻页面上只有一个挂件和一个标题栏入口。
  try {
    var orphans = document.querySelectorAll('[data-dshhw]')
    for (var oi = 0; oi < orphans.length; oi++) { try { orphans[oi].remove() } catch (e) {} }
  } catch (e) {}
  try {
    var orphanBtns = document.querySelectorAll('[id="dshhw-title-entry"]')
    for (var bi = 0; bi < orphanBtns.length; bi++) { try { orphanBtns[bi].remove() } catch (e) {} }
  } catch (e) {}

  var BASE = '/dsh-hw'
  var POS_KEY = 'dshhw-pos'
  var MODE_KEY = 'dshhw-mode'
  // 只有 full / mini 两个可循环档位；dismissed 是"彻底收起"。
  // 'off' 只作旧版存储值保留，读到就迁移成 dismissed（见 readMode）。
  var MODES = ['full', 'mini', 'dismissed']
  var POLL_MS = 2000        // HWiNFO 自身 ~2s、AIDA64 1s：再快没有意义，只多耗 CPU

  function readMode() {
    try {
      var v = window.localStorage.getItem(MODE_KEY)
      return MODES.indexOf(v) >= 0 ? v : 'full'
    } catch (e) { return 'full' }
  }
  function writeMode(m) { try { window.localStorage.setItem(MODE_KEY, m) } catch (e) {} }

  // —— 页面自检：只在主聊天界面挂载（见文件头）——
  function isChatView() {
    if (document.querySelector('textarea')) return true
    if (document.querySelector('[contenteditable="true"]')) return true
    if (document.querySelector('[class*="composer" i]')) return true
    return false
  }

  var host = null
  // 坐标模型（两份，别混用）：
  //   state.posUser  = **用户想要的位置**：拖动时写入、存进 localStorage，
  //                    窗口变大后要还原到这个位置。
  //   state.posShown = **当前实际显示的位置**：= clamp(posUser, 当前视口)。
  //                    缩窗时它被收进可视区，但**不改 posUser** —— 放大回去就还原。
  // 早先只有一份 pos，缩窗时把钳制结果写回存储，导致"回全屏也停在缩过的位置"。
  var state = { posUser: null, posShown: null, sensors: [], sources: [], live: false, expand: false, timer: null, failing: 0 }

  /**
   * 把坐标钳制到当前可视区内。
   *
   * ⚠ 修的是个**真实缺陷**：坐标按旧窗口尺寸保存，窗口缩小（如退出全屏）后会留在
   *   屏幕外 —— 用户完全看不到挂件，且它永远不会自愈。
   *   真机实测：1920 窗口里存 (1700,900)，缩到 1200x700 后超出右侧 714px、底部 301px。
   *
   * 元素尺寸未知时（首次渲染、还没布局）用保守估算，宁可多留边距也不要放出去。
   */
  function clampPos(pos, pad) {
    if (!pos) return null
    var vw = window.innerWidth || 800
    var vh = window.innerHeight || 600
    var w = (host && host.offsetWidth) || 140
    var h = (host && host.offsetHeight) || 44
    var margin = (pad === undefined ? 4 : pad)
    var maxX = Math.max(margin, vw - w - margin)
    var maxY = Math.max(margin, vh - h - margin)
    return {
      x: Math.round(Math.max(margin, Math.min(maxX, pos.x))),
      y: Math.round(Math.max(margin, Math.min(maxY, pos.y))),
    }
  }

  /** 依据 posUser + 当前视口，算出该显示在哪里（幂等，可反复调用）。 */
  function syncShownPos() {
    if (!state.posUser) { state.posShown = null; return null }
    state.posShown = clampPos(state.posUser)
    return state.posShown
  }

  function loadPos() {
    try {
      var raw = window.localStorage.getItem(POS_KEY)
      if (!raw) return null
      var p = JSON.parse(raw)
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return { x: p.x, y: p.y }
    } catch (e) {}
    return null
  }
  /** 只保存**用户想要的位置**（posUser）；钳制后的展示位置绝不写盘。 */
  function savePos() {
    try {
      if (state.posUser) window.localStorage.setItem(POS_KEY, JSON.stringify(state.posUser))
    } catch (e) {}
  }

  /** 注入一段样式表（按 id 幂等）。 */
  function css(id, text) {
    if (document.getElementById(id)) return
    var s = document.createElement('style')
    s.id = id
    s.textContent = text
    ;(document.head || document.documentElement).appendChild(s)
  }

  function installStyles() {
    if (document.getElementById('dshhw-style')) return
    var s = document.createElement('style')
    s.id = 'dshhw-style'
    s.textContent = [
      '.dshhw{position:fixed;z-index:2147483000;right:14px;bottom:88px;',      '  font:12px/1.45 ui-sans-serif,system-ui,"Segoe UI",sans-serif;',
      '  color:var(--dsw-alias-text-secondary,rgba(235,235,235,.82));',
      '  background:var(--dsw-alias-surface,rgba(24,24,28,.86));',
      '  border:1px solid var(--dsw-alias-border,rgba(255,255,255,.12));',
      '  border-radius:10px;padding:5px 9px;min-width:104px;max-width:340px;',
      '  backdrop-filter:blur(7px);box-shadow:0 4px 18px rgba(0,0,0,.35);',
      '  user-select:none;touch-action:none;}',
      // 彻底收起：节点还在（保留状态与轮询），但完全不可见、不占位、不挡点击
      '.dshhw.dshhw-dismissed{display:none}',
      '.dshhw.dshhw-mini{min-width:0}',
      '.dshhw-row{display:flex;justify-content:space-between;gap:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshhw-row b{font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-text-primary,#f2f2f2)}',
      '.dshhw-h{display:flex;align-items:center;gap:6px;cursor:grab;margin:-1px 0 3px;font-weight:600;color:var(--dsw-alias-text-primary,#f2f2f2)}',
      '.dshhw-dot{width:7px;height:7px;border-radius:50%;background:#3fb950;flex:0 0 auto}',
      '.dshhw-dot.warn{background:#d29922}.dshhw-dot.off{background:#8b8b8b}',
      '.dshhw-all{display:none;margin-top:4px;padding-top:4px;max-height:200px;overflow:auto;border-top:1px solid var(--dsw-alias-border,rgba(255,255,255,.1))}',
      '.dshhw.dshhw-open .dshhw-all{display:block}',
      '.dshhw-hint{opacity:.62;font-size:11px;margin-top:2px}',
    ].join('\n')
    ;(document.head || document.documentElement).appendChild(s)
  }

  function isKey(s) {
    return s.category === 'temperature' || s.category === 'fan' || s.category === 'usage' || s.category === 'power'
  }

  /** 读数是否可用来排进收起态（接口字段是 value，不是内部字段 num —— 曾经混用导致一条都挑不出来）。 */
  function hasNumber(s) {
    return typeof s.value === 'number' && Number.isFinite(s.value)
  }

  /** 收起态只摊最要紧的几条：优先 CPU/GPU 温度、占用、功率、风扇。 */
  function pickKey(sensors) {
    var wants = [/cpu.*(tctl|tdie|package|封装|温度)/i, /cpu/i, /gpu.*(温度|temperature|hot|temp)/i, /gpu/i,
      /使用率|utilization/i, /(封装|package).*功率|power|功耗/i, /fan|转速|rpm/i]
    var picked = [], used = {}
    for (var i = 0; i < wants.length && picked.length < 4; i++) {
      for (var j = 0; j < sensors.length; j++) {
        var s = sensors[j]
        if (used[s.id]) continue
        if (!hasNumber(s)) continue
        if (!wants[i].test((s.group || '') + ' ' + (s.label || ''))) continue
        picked.push(s); used[s.id] = 1; break
      }
    }
    for (var k = 0; k < sensors.length && picked.length < 4; k++) {
      var x = sensors[k]
      if (used[x.id] || !hasNumber(x) || !isKey(x)) continue
      picked.push(x); used[x.id] = 1
    }
    return picked
  }

  function fmt(s) {
    var v = hasNumber(s) ? s.value : (s.value === null || s.value === undefined ? '-' : s.value)
    if (typeof v === 'number') {
      var d = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2
      v = v.toFixed(d)
    }
    return v + (s.unit || '')
  }

  function shortGroup(g) {
    var m = /CPU ?\[#?\d*\]:?\s*(.*)|GPU ?\[#?\d*\]:?\s*(.*)/.exec(String(g || ''))
    if (m) return (m[1] ? 'CPU ' : 'GPU ') + String(m[1] || m[2] || '').split(' ')[0]
    return String(g || '').slice(0, 14)
  }

  function rowEl(s) {
    var d = document.createElement('div')
    d.className = 'dshhw-row'
    var a = document.createElement('span')
    a.textContent = ((s.group ? shortGroup(s.group) + ' ' : '') + (s.label || s.id || '')).slice(0, 42)
    var b = document.createElement('b')
    b.textContent = fmt(s)
    d.appendChild(a); d.appendChild(b)
    return d
  }

  function appNames() {
    return state.sources.filter(function (s) { return s.available })
      .map(function (s) { return s.app === 'hwinfo' ? 'HWiNFO' : 'AIDA64' }).join('+')
  }

  function render() {
    if (!host) return
    var mode = readMode()
    // `dismissed`（Shift+点击 ◦ 后写入）= 用户彻底收起悬浮提示：
    // 连"可点回的小圆点"也不留，恢复入口只在详细信息面板里。
    if (mode === 'dismissed') {
      host.className = 'dshhw dshhw-dismissed'
      try { while (host.firstChild) host.removeChild(host.firstChild) } catch (e) {}
      return
    }
    // 只有两档：full / mini。
    // 早先还有一个 `off` 档（只渲染一个小圆点），但它把 ◦ 按钮也一起藏了，
    // 导致"完整 → 精简 → 隐藏 → 完整"这条循环**走不到第三步**（真机实测：
    // off 档时 hasCycDot=false，◦ 不存在）。既然 `dismissed` 已经承担"彻底收起"，
    // 就把 `off` 并入它，档位模型简化为两档，循环永远可逆。
    // （readMode 已把旧的 'off' 存储值迁移成 dismissed；这里再判一次是防御
    //   有人手改 localStorage 的情况。）
    if (mode === 'off' || mode === 'dismissed') {
      host.className = 'dshhw dshhw-dismissed'
      try { while (host.firstChild) host.removeChild(host.firstChild) } catch (e) {}
      return
    }
    host.className = 'dshhw' + (mode === 'mini' ? ' dshhw-mini' : '')
      + (state.expand && mode === 'full' ? ' dshhw-open' : '')
      + (state.live || state.sensors.length ? '' : ' dshhw-empty')

    host.innerHTML = ''

    var h = document.createElement('div')
    h.className = 'dshhw-h'
    var dot = document.createElement('span')
    dot.className = 'dshhw-dot' + (state.live ? '' : state.sensors.length ? ' warn' : ' off')
    dot.title = state.live ? '数据在更新'
      : (state.sources.map(function (s) { return s.app + ': ' + (s.reason || '不可用') }).join(' / ') || '未探测')
    h.appendChild(dot)

    {
      var t = document.createElement('span')
      t.textContent = appNames() || '硬件读数'
      h.appendChild(t)

      // 右上角 ◦：普通点击在 **完整 ⇄ 精简** 之间切换（可逆）；
      // **Shift+点击** = 彻底收起（进 `dismissed`，连 ◦ 都不留，恢复入口在面板里）。
      // 这里不再有 `off` 档：它会把 ◦ 一起藏起来，使循环单向死锁（真机实测证实）。
      var cyc = document.createElement('span')
      cyc.textContent = '◦'
      cyc.title = '点击切换：完整 ⇄ 精简 · Shift+点击：彻底收起（可在详细面板恢复）'
      cyc.style.cssText = 'margin-left:auto;padding:0 2px;cursor:pointer;opacity:.55;font-weight:700'
      cyc.onclick = function (ev) {
        ev.stopPropagation()
        // Shift+点击：彻底收起（写入 dismissed，不再渲染卡片）
        if (ev.shiftKey) {
          writeMode('dismissed')
          hideToast()
          render()
          return
        }
        var cur = readMode()
        var next = cur === 'mini' ? 'full' : 'mini'
        if (next !== 'full') state.expand = false
        writeMode(next)
        render()
      }
      h.appendChild(cyc)
    }
    // 标题区点击：展开/收起完整读数列表
    h.onclick = function () {
      if (readMode() === 'mini') { writeMode('full'); state.expand = true; render(); return }
      state.expand = !state.expand
      render()
    }
    h.title = '拖动移动 · 点击展开/收起 · ◦ 切换完整/精简 · Shift+点击 ◦ 彻底收起'
    host.appendChild(h)


    var key = pickKey(state.sensors)
    if (key.length) {
      for (var i = 0; i < (mode === 'mini' ? Math.min(1, key.length) : key.length); i++) host.appendChild(rowEl(key[i]))
    } else {
      var e = document.createElement('div')
      e.className = 'dshhw-hint'
      e.textContent = state.live ? '暂无常用读数' : '未检测到 AIDA64 / HWiNFO 导出'
      host.appendChild(e)
    }

    if (state.expand && mode === 'full') {
      var all = document.createElement('div')
      all.className = 'dshhw-all'
      if (!state.sensors.length) {
        var tip = document.createElement('div')
        tip.className = 'dshhw-hint'
        tip.textContent = '启动 AIDA64 或 HWiNFO 并在其设置里开启传感器导出即可；两者都不要求必须开启。'
        all.appendChild(tip)
      } else {
        for (var j = 0; j < state.sensors.length; j++) all.appendChild(rowEl(state.sensors[j]))
      }
      host.appendChild(all)
    }

    // 显示位置 = 钳制后的 posUser。**每帧重算、绝不写回存储**：
    // 缩窗时临时收进可视区，窗口放大回去后自动还原到用户原来的位置。
    if (state.posUser) {
      var shown = syncShownPos()
      if (shown) {
        host.style.left = shown.x + 'px'
        host.style.top = shown.y + 'px'
        host.style.right = 'auto'
        host.style.bottom = 'auto'
      }
    }
  }

  function attachDrag() {
    var drag = null, moved = false, capturing = false
    host.addEventListener('pointerdown', function (ev) {
      if (!ev.target || !ev.target.closest || !ev.target.closest('.dshhw-h')) return
      var r = host.getBoundingClientRect()
      // sx/sy 是**本次按下**的指针位置：用它判断是否移动过。
      drag = { dx: ev.clientX - r.left, dy: ev.clientY - r.top, sx: ev.clientX, sy: ev.clientY, pid: ev.pointerId }
      moved = false
      capturing = false
      // ⚠ **不要**在这里 setPointerCapture。
      // pointerdown 一捕获，指针就归 host 所有，浏览器随后合成的 click 会落在
      // host 而不是原来的 ◦/标题上 —— 结果就是"点不动"（真机实测：clicksSeen 为空）。
      // 改为只在**确认开始拖动**（超过阈值）后才捕获。
    })
    host.addEventListener('pointermove', function (ev) {
      if (!drag) return
      if (Math.abs(ev.clientX - drag.sx) > 3 || Math.abs(ev.clientY - drag.sy) > 3) {
        moved = true
        if (!capturing) {
          capturing = true
          try { host.setPointerCapture(drag.pid || ev.pointerId) } catch (e) {}
        }
      }
      if (!moved) return   // 未超过阈值时不移动，避免"手抖"导致位置跳动
      // 拖动写的是 **posUser**（用户想要的位置），并同步算出显示位置。
      // 这里不再单独 clamp 坐标：clampPos 会在 render 里统一应用，
      // 分两处各自钳制容易出现"拖出边界后松手位置跳一下"。
      var w = host.offsetWidth || 120, hh = host.offsetHeight || 40
      var x = Math.max(4, Math.min(window.innerWidth - w - 4, ev.clientX - drag.dx))
      var y = Math.max(4, Math.min(window.innerHeight - hh - 4, ev.clientY - drag.dy))
      state.posUser = { x: Math.round(x), y: Math.round(y) }
      var shown = syncShownPos()
      if (shown) {
        host.style.left = shown.x + 'px'; host.style.top = shown.y + 'px'
        host.style.right = 'auto'; host.style.bottom = 'auto'
      }
    })
    var end = function () {
      if (!drag) return
      var wasMoved = moved
      drag = null
      if (capturing) {
        capturing = false
        try { host.releasePointerCapture(1) } catch (e) {}
      }
      if (wasMoved) savePos()
    }
    host.addEventListener('pointerup', end)
    host.addEventListener('pointercancel', end)
    // 拖动过的那一次点击不要触发"展开/收起/切档"，用一次性标记拦一下。
    // 注意这里必须**总是**把 moved 复位，否则一次拖动会永久吞掉后续点击。
    host.addEventListener('click', function (ev) {
      if (moved) {
        moved = false
        ev.stopPropagation()
        ev.preventDefault()
        return
      }
      moved = false
    }, true)
  }

  // ==========================================================================
  // 标题栏入口：贴在桌面端"应用 / 编辑"菜单右侧
  // ==========================================================================
  // 事实依据（app.asar 4024220 起）：那块是 `installWindowsMenu()` 用
  // attachShadow({mode:"open"}) 建的原生菜单，host 带 `data-windows-menu`，
  // 定位 `position:fixed; top:0; left:var(--dsh-windows-menu-start,48px);
  // height:var(--dsh-windows-titlebar-height)`，z-index 1100。
  // 它**不是 React 槽位**，插件无法往里插子节点；但它是 open shadow + 固定定位，
  // 所以我们能测量它的实际右边缘，把按钮贴在同一条水平线上，视觉上融进窗口区。
  // 兜底：菜单不存在（非桌面端 / 菜单未装）时，入口退回到挂件卡片标题上。
  var TITLE_BTN_ID = 'dshhw-title-entry'

  function menuHost() {
    try {
      var h = document.querySelector('[data-windows-menu]')
      if (h) return h
      // 极早期：菜单可能还没装好，用 documentElement 上的标记判断"这是桌面端"
      return null
    } catch (e) { return null }
  }

  function isDesktopShell() {
    try { return document.documentElement.hasAttribute('data-windows-titlebar') } catch (e) { return false }
  }

  /** 标题栏入口的落点：菜单右侧 + 8px；读不到菜单时给一个安全的左侧偏移。 */
  function titleEntryRect() {
    var menu = menuHost()
    if (menu) {
      var r = menu.getBoundingClientRect()
      if (r && r.width > 0) return { left: Math.round(r.right + 8), top: Math.round(r.top), height: Math.round(r.height) || 40 }
    }
    return null
  }

  function installTitleEntry() {
    if (!isDesktopShell()) return          // 非桌面端不装（Web profile 没有标题栏）
    var btn = document.getElementById(TITLE_BTN_ID)
    if (btn) { positionTitleEntry(btn); return }
    var rect = titleEntryRect()
    if (!rect) return                      // 菜单还没出现，等 MutationObserver 再装

    // 图标档：只放一个 20px 小方块 + 状态点，宽度约 28px，不挤占"应用/编辑"。
    // 具体读数条数与状态走 tooltip，保持视觉极简。
    btn = document.createElement('button')
    btn.id = TITLE_BTN_ID
    btn.type = 'button'
    btn.title = '硬件传感器数据'
    btn.setAttribute('aria-label', '硬件传感器数据')
    btn.style.cssText = [
      'position:fixed',
      'left:' + rect.left + 'px',
      'top:' + rect.top + 'px',
      'width:28px',
      'height:' + rect.height + 'px',
      'padding:0',
      'border:0',
      'border-radius:6px',
      'background:transparent',
      'color:var(--dsw-alias-label-secondary,#a8a8b3)',
      'font:inherit',
      'line-height:1',
      'cursor:pointer',
      'z-index:1101',            // 比菜单(1100)高 1，紧邻其右，不遮挡
      '-webkit-app-region:no-drag',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'gap:0',
    ].join(';')

    // 图标：竖条状"传感器/柱状图"轮廓，用 SVG 而非 emoji（跨字体稳定、可着色）
    var svgNS = 'http://www.w3.org/2000/svg'
    var svg = document.createElementNS(svgNS, 'svg')
    svg.setAttribute('viewBox', '0 0 16 16')
    svg.setAttribute('width', '15')
    svg.setAttribute('height', '15')
    svg.setAttribute('aria-hidden', 'true')
    svg.style.cssText = 'display:block;flex:0 0 auto;opacity:.9'
    // 三根高度递增的竖条，读作"读数/仪表"
    ;[[2.5, 6, 3], [6.5, 10, 3], [10.5, 4, 3]].forEach(function (b) {
      var bar = document.createElementNS(svgNS, 'rect')
      bar.setAttribute('x', String(b[0])); bar.setAttribute('width', String(b[2]))
      bar.setAttribute('y', String(16 - b[1] - 2)); bar.setAttribute('height', String(b[1]))
      bar.setAttribute('rx', '1'); bar.setAttribute('fill', 'currentColor')
      svg.appendChild(bar)
    })
    btn.appendChild(svg)

    // 状态点的定位基准：按钮已是 position:fixed，fixed 元素本身就能作为
    // absolute 子元素的包含块，无需再设 relative。这里显式声明只为可读。
    var dot = document.createElement('span')
    dot.style.cssText = [
      'position:absolute', 'right:3px', 'bottom:7px',
      'width:5px', 'height:5px', 'border-radius:50%',
      'background:#8b8b8b', 'transition:background .2s',
      'pointer-events:none',
    ].join(';')
    btn.appendChild(dot)
    btn.__dshhwDot = dot

    btn.addEventListener('mouseenter', function () {
      btn.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))'
      btn.style.color = 'var(--dsw-alias-label-primary,#f2f2f2)'
    })
    btn.addEventListener('mouseleave', function () {
      btn.style.background = 'transparent'
      btn.style.color = 'var(--dsw-alias-label-secondary,#a8a8b3)'
    })
    btn.addEventListener('click', function (ev) {
      ev.stopPropagation()
      openPanel()
    })
    document.body.appendChild(btn)

    refreshTitleEntryBadge()
  }

  function positionTitleEntry(btn) {
    var rect = titleEntryRect()
    if (!rect) return
    btn.style.left = rect.left + 'px'
    btn.style.top = rect.top + 'px'
    btn.style.height = rect.height + 'px'
  }

  /**
   * 图标档的状态呈现：**不改文字、不加宽度**，只用状态点颜色 + tooltip 传达信息。
   * 绿=实时更新；橙=有数据但 poll_time 不涨（陈旧）；灰=没有数据源。
   */
  function refreshTitleEntryBadge() {
    var btn = document.getElementById(TITLE_BTN_ID)
    if (!btn) return
    var n = state.sensors.length
    var apps = state.sources.filter(function (a) { return a.available })
      .map(function (a) { return a.app === 'hwinfo' ? 'HWiNFO' : 'AIDA64' })
    var dot = btn.__dshhwDot
    var color = '#8b8b8b'
    if (state.live && n) color = '#3fb950'
    else if (n) color = '#d29922'
    if (dot) dot.style.background = color

    var tip
    if (!n) {
      tip = '硬件传感器：未检测到 AIDA64 / HWiNFO 导出（点击查看）'
    } else {
      tip = (apps.length ? apps.join(' + ') : '传感器') + ' · ' + n + ' 条读数'
        + (state.live ? ' · 实时' : ' · 数据已停止更新')
        + '（点击查看完整数据）'
    }
    btn.title = tip
    btn.setAttribute('aria-label', tip)
  }

  /** 菜单/窗口尺寸变化时重新贴靠（窗口缩放、菜单语言切换都会改变宽度）。 */
  function watchTitleEntry() {
    if (!isDesktopShell()) return
    var reposition = function () {
      var b = document.getElementById(TITLE_BTN_ID)
      if (!b) { installTitleEntry(); return }
      positionTitleEntry(b)
    }
    try {
      var mo = new MutationObserver(function () { reposition() })
      mo.observe(document.body, { childList: true, subtree: true })
      state.titleObserver = mo
      window.addEventListener('resize', reposition)
      // 菜单文字/宽度变化不一定引发 body 变更（shadow 内部），补一个低频兜底
      if (!state.titleTimer) {
        state.titleTimer = setInterval(reposition, 3000)
      }
    } catch (e) {}
    reposition()
  }

  // ==========================================================================
  // 数据源变化提醒
  // ==========================================================================
  // 事实前提（已由 test/hotswap.test.mjs 实测）：本插件**本来就会自动识别**
  // 数据源接入与离线（冷源每 15s 重探一次），所以接入侧不需要"重载插件"。
  // 真正的坑只有两个，都值得提醒用户：
  //   · HWiNFO 退出后注册表 VSB **不清除** ⇒ 数据会一直停在最后一次的快照
  //   · 源静默停更 ⇒ 读数看着正常，其实已经不更新了
  // 所以提示文案区分两种情况：接入 = 信息性提示（自动生效），
  // 离线/停更 = 需要动作（重启软件 / 或按需重载插件来重置内部状态）。
  var toast = null

  var SOURCE_LABEL = { aida64: 'AIDA64', hwinfo: 'HWiNFO' }

  function installToastStyles() {
    css('dshhw-toast-style', [
      '.dshhw-toast{position:fixed;right:14px;bottom:calc(88px + var(--dshhw-toast-offset,0px));z-index:2147483050;',
      '  max-width:340px;padding:10px 12px;border-radius:10px;display:flex;gap:10px;align-items:flex-start;',
      '  background:var(--dsw-alias-surface,#1b1b20);border:1px solid var(--dsw-alias-border,rgba(255,255,255,.16));',
      '  box-shadow:0 8px 28px rgba(0,0,0,.45);color:var(--dsw-alias-text-secondary,#c9c9d1);',
      '  font:12px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif;pointer-events:auto;',
      '  animation:dshhw-toast-in .18s ease-out}',
      '.dshhw-toast.warn{border-color:rgba(210,153,34,.55)}',
      '.dshhw-toast.err{border-color:rgba(248,81,73,.55)}',
      '.dshhw-toast-ico{width:8px;height:8px;border-radius:50%;margin-top:5px;flex:0 0 auto}',
      '.dshhw-toast-body{flex:1;min-width:0}',
      '.dshhw-toast-t{font-weight:600;color:var(--dsw-alias-text-primary,#f2f2f2);margin-bottom:2px}',
      '.dshhw-toast-m{opacity:.8;word-break:break-word}',
      '.dshhw-toast-a{display:flex;gap:6px;margin-top:7px;flex-wrap:wrap}',
      '.dshhw-toast-btn{border:1px solid var(--dsw-alias-border,rgba(255,255,255,.16));background:transparent;',
      '  color:inherit;font:inherit;padding:3px 9px;border-radius:7px;cursor:pointer}',
      '.dshhw-toast-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.dshhw-toast-x{border:0;background:transparent;color:inherit;cursor:pointer;opacity:.6;font-size:14px;line-height:1;padding:0 2px}',
      '.dshhw-toast-x:hover{opacity:1}',
      '@keyframes dshhw-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      '@media (prefers-reduced-motion:reduce){.dshhw-toast{animation:none}}',
    ].join('\n'))
  }

  /**
   * 弹一条提醒。同一条（同 key）正在显示时不重复弹，避免每拍刷屏。
   * @param {{key:string, level:'info'|'warn'|'err', title:string, message:string,
   *          actions?:Array<{label:string, onClick:Function}>}} opt
   */
  function showToast(opt) {
    installToastStyles()
    if (toast && toast.__key === opt.key) return   // 去重：同一提醒不刷屏
    hideToast()
    var level = opt.level || 'info'
    var color = level === 'err' ? '#f85149' : level === 'warn' ? '#d29922' : '#3fb950'
    var el = document.createElement('div')
    el.className = 'dshhw-toast' + (level === 'warn' ? ' warn' : level === 'err' ? ' err' : '')
    el.__key = opt.key

    var ico = document.createElement('span')
    ico.className = 'dshhw-toast-ico'
    ico.style.background = color
    el.appendChild(ico)

    var bodyEl = document.createElement('div')
    bodyEl.className = 'dshhw-toast-body'
    var t = document.createElement('div')
    t.className = 'dshhw-toast-t'
    t.textContent = opt.title
    var m = document.createElement('div')
    m.className = 'dshhw-toast-m'
    m.textContent = opt.message
    bodyEl.appendChild(t); bodyEl.appendChild(m)

    if (opt.actions && opt.actions.length) {
      var acts = document.createElement('div')
      acts.className = 'dshhw-toast-a'
      for (var i = 0; i < opt.actions.length; i++) {
        (function (a) {
          var b = document.createElement('button')
          b.className = 'dshhw-toast-btn'
          b.type = 'button'
          b.textContent = a.label
          b.onclick = function (ev) { ev.stopPropagation(); try { a.onClick() } catch (e) {} }
          acts.appendChild(b)
        })(opt.actions[i])
      }
      bodyEl.appendChild(acts)
    }
    el.appendChild(bodyEl)

    var x = document.createElement('button')
    x.className = 'dshhw-toast-x'
    x.type = 'button'
    x.textContent = '×'
    x.title = '知道了'
    x.onclick = function (ev) { ev.stopPropagation(); hideToast() }
    el.appendChild(x)

    document.body.appendChild(el)
    toast = el

    // 信息性提醒（"已接入"）自动消失；需要动作的提醒保留，直到用户关闭
    if (level === 'info' && !(opt.actions && opt.actions.length)) {
      var ttl = opt.ttlMs === undefined ? 6000 : opt.ttlMs
      toast.__timer = setTimeout(function () { hideToast() }, ttl)
    }
  }

  function hideToast() {
    if (!toast) return
    try { if (toast.__timer) clearTimeout(toast.__timer) } catch (e) {}
    try { toast.remove() } catch (e) {}
    toast = null
    void toast
  }

  /** 把 store 返回的 changes 事件翻译成用户可读的提醒。 */
  function handleChanges(changes) {
    if (!changes || !changes.length) return
    for (var i = 0; i < changes.length; i++) {
      var c = changes[i]
      var name = SOURCE_LABEL[c.source] || c.source
      if (c.to === 'online') {
        showToast({
          key: 'online:' + c.source,
          level: 'info',
          title: name + ' 已接入',
          message: '检测到 ' + c.count + ' 条读数，已自动生效，无需重载插件。',
        })
        continue
      }
      if (c.to === 'offline') {
        showToast({
          key: 'offline:' + c.source,
          level: 'warn',
          title: name + ' 已离线',
          message: (c.from === 'stale')
            ? '该数据源不再提供读数，插件已自动转为"无数据"状态。'
            : '该数据源已停止提供读数。若它仍在运行，请在软件里开启传感器导出。',
          actions: [
            { label: '查看面板', onClick: openPanel },
            { label: '重载插件', onClick: requestReload },
          ],
        })
        continue
      }
      // → stale：数据还在但已停止更新（HWiNFO 退出后注册表残留就属于这类）
      showToast({
        key: 'stale:' + c.source,
        level: 'warn',
        title: name + ' 数据已停止更新',
        message: c.source === 'hwinfo'
          ? 'HWiNFO 退出后会保留最后一次快照（注册表不会自动清除）。现在显示的是旧数据，重启 ' + name + ' 即可恢复实时读数。'
          : '读数不再变化，可能软件已退出或暂停了传感器导出。',
        actions: [
          { label: '查看面板', onClick: openPanel },
          { label: '重载插件', onClick: requestReload },
        ],
      })
    }
  }

  /**
   * 请求热重载：插件是宿主侧 bundle，浏览器页面自己无法重载它；
   * 这里做的是"把插件内部状态重置 + 让页面重新拉取"——对数据源变化已经足够
   * （store 会立刻重探）。若宿主确实需要整体重建，提示用户重启 DSH。
   */
  function requestReload() {
    hideToast()
    try {
      // 立即强制重采样，越过 15s 冷源退避
      poll(true)
      showToast({
        key: 'reloaded',
        level: 'info',
        title: '已重新检测数据源',
        message: '插件会继续自动跟随数据源变化；若界面仍显示旧读数，按 Ctrl+F5 刷新页面。',
        ttlMs: 5000,
      })
    } catch (e) {}
  }

  // ==========================================================================
  // 完整数据面板：按数据源分列、按设备分组、全量读数、可搜索
  // ==========================================================================
  var panel = null

  function installPanelStyles() {
    css('dshhw-panel-style', [
      '.dshhw-panel-mask{position:fixed;inset:0;z-index:2147483100;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center}',
      '.dshhw-panel{width:min(860px,92vw);max-height:82vh;display:flex;flex-direction:column;',
      '  background:var(--dsw-alias-surface,#1b1b20);border:1px solid var(--dsw-alias-border,rgba(255,255,255,.14));',
      '  border-radius:14px;box-shadow:0 18px 50px rgba(0,0,0,.5);overflow:hidden;',
      '  color:var(--dsw-alias-text-secondary,#c9c9d1);font:13px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif}',
      '.dshhw-panel-h{display:flex;align-items:center;gap:10px;padding:12px 16px;',
      '  border-bottom:1px solid var(--dsw-alias-border,rgba(255,255,255,.1))}',
      '.dshhw-panel-t{font-size:15px;font-weight:600;color:var(--dsw-alias-text-primary,#f2f2f2)}',
      '.dshhw-panel-s{opacity:.65;font-size:12px}',
      '.dshhw-panel-x{margin-left:auto;border:0;background:transparent;color:inherit;font-size:18px;',
      '  cursor:pointer;padding:2px 8px;border-radius:6px}',
      '.dshhw-panel-x:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08))}',
      '.dshhw-panel-tools{display:flex;gap:8px;padding:10px 16px;align-items:center;flex-wrap:wrap}',
      '.dshhw-panel-tools input{flex:1;min-width:180px;padding:6px 10px;border-radius:8px;',
      '  border:1px solid var(--dsw-alias-border,rgba(255,255,255,.14));',
      '  background:var(--dsw-alias-surface-raised,rgba(255,255,255,.04));color:inherit;font:inherit}',
      '.dshhw-chip{border:1px solid var(--dsw-alias-border,rgba(255,255,255,.14));background:transparent;',
      '  color:inherit;font:inherit;padding:4px 10px;border-radius:999px;cursor:pointer}',
      '.dshhw-chip.on{background:var(--dsw-alias-state-business-primary,#3b82f6);border-color:transparent;color:#fff}',
      '.dshhw-panel-body{overflow:auto;padding:4px 16px 16px}',
      // 按数据源分列：只有一列时铺满，两列时并排以便逐项对比
      '.dshhw-cols{display:flex;gap:18px;align-items:flex-start}',
      '.dshhw-col{min-width:0;flex:1 1 0}',
      '.dshhw-cols.one .dshhw-col{flex:1 1 100%}',
      '.dshhw-col-h{display:flex;align-items:center;gap:6px;position:sticky;top:0;z-index:2;',
      '  padding:8px 0 6px;font-weight:600;color:var(--dsw-alias-text-primary,#f2f2f2);',
      '  background:var(--dsw-alias-surface,#1b1b20);',
      '  border-bottom:1px solid var(--dsw-alias-border,rgba(255,255,255,.14))}',
      '.dshhw-col-src{font-size:11px;font-weight:500;opacity:.6}',
      '.dshhw-group{margin-top:10px}',
      '.dshhw-group-h{font-weight:600;color:var(--dsw-alias-text-primary,#f2f2f2);',
      '  padding:5px 0;border-bottom:1px solid var(--dsw-alias-border,rgba(255,255,255,.08));',
      '  position:sticky;top:33px;background:var(--dsw-alias-surface,#1b1b20);',
      '  font-size:12px;opacity:.92}',
      // 单源：自适应多列铺满；双源：每列内部单列，行行对齐便于横向比较
      '.dshhw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:2px 14px;padding-top:4px}',
      '.dshhw-cols.two .dshhw-grid{grid-template-columns:1fr}',
      '.dshhw-cell{display:flex;justify-content:space-between;gap:10px;padding:3px 0;overflow:hidden}',
      '.dshhw-cell span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85}',
      '.dshhw-cell b{font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-text-primary,#f2f2f2);flex:0 0 auto}',
      '.dshhw-none{padding:24px 0;text-align:center;opacity:.7}',
    ].join('\n'))
  }

  function openPanel() {
    if (panel) { closePanel(); return }
    installPanelStyles()
    panel = document.createElement('div')
    panel.className = 'dshhw-panel-mask'
    panel.addEventListener('click', function (ev) { if (ev.target === panel) closePanel() })

    var box = document.createElement('div')
    box.className = 'dshhw-panel'
    panel.appendChild(box)

    var head = document.createElement('div')
    head.className = 'dshhw-panel-h'
    var t = document.createElement('div')
    t.className = 'dshhw-panel-t'
    t.textContent = '硬件传感器'
    var s = document.createElement('div')
    s.className = 'dshhw-panel-s'
    var x = document.createElement('button')
    x.className = 'dshhw-panel-x'
    x.type = 'button'
    x.textContent = '×'
    x.title = '关闭（Esc）'
    x.onclick = closePanel
    head.appendChild(t); head.appendChild(s); head.appendChild(x)
    box.appendChild(head)

    var tools = document.createElement('div')
    tools.className = 'dshhw-panel-tools'
    var input = document.createElement('input')
    input.placeholder = '按标签 / 设备过滤，例如 cpu、gpu、温度'
    input.oninput = function () { renderPanelBody(bodyEl, input.value) }
    tools.appendChild(input)
    var refreshBtn = document.createElement('button')
    refreshBtn.className = 'dshhw-chip'
    refreshBtn.textContent = '刷新'
    refreshBtn.onclick = function () { poll(); setTimeout(function () { renderPanelBody(bodyEl, input.value) }, 400) }
    tools.appendChild(refreshBtn)

    // 悬浮提示开关：Shift+点击小点会彻底收起卡片，这里是唯一可靠的恢复入口。
    // 用显式"显示/隐藏"文本而不是纯图标，避免用户找不到回来的路。
    var modeKey = readMode()
    var dockBtn = document.createElement('button')
    dockBtn.className = 'dshhw-chip'
    dockBtn.type = 'button'
    var shown = modeKey !== 'dismissed'
    dockBtn.textContent = shown ? '隐藏悬浮提示' : '显示悬浮提示'
    dockBtn.title = '整个界面最多只显示一个硬件读数悬浮提示'
    dockBtn.onclick = function () {
      var cur = readMode()
      var hidden = cur === 'dismissed'
      writeMode(hidden ? 'full' : 'dismissed')
      dockBtn.textContent = hidden ? '隐藏悬浮提示' : '显示悬浮提示'
      render()
      if (hidden) poll(true)   // 从隐藏恢复时立刻取一次数
    }
    tools.appendChild(dockBtn)
    box.appendChild(tools)

    var bodyEl = document.createElement('div')
    bodyEl.className = 'dshhw-panel-body'
    box.appendChild(bodyEl)

    document.body.appendChild(panel)
    renderPanelBody(bodyEl, '')
    state.panelBody = bodyEl
    state.panelInput = input
    updatePanelHeader(s)
    document.addEventListener('keydown', panelKey)

    // 打开时强制刷一次，确保看到最新
    poll()
  }

  function updatePanelHeader(sub) {
    if (!sub) return
    var live = state.live ? '实时' : '无实时数据'
    var apps = state.sources.filter(function (a) { return a.available }).map(function (a) { return a.app === 'hwinfo' ? 'HWiNFO' : 'AIDA64' })
    sub.textContent = apps.length
      ? (apps.join(' + ') + ' · ' + state.sensors.length + ' 条读数 · ' + live)
      : ('未检测到数据源 · ' + live)
  }

  function closePanel() {
    if (!panel) return
    try { panel.remove() } catch (e) {}
    panel = null
    state.panelBody = null
    document.removeEventListener('keydown', panelKey)
  }

  function panelKey(ev) { if (ev.key === 'Escape') closePanel() }

  /**
   * 面板主体：**按数据源分列**。
   *   · 只有一个源有数据 → 单列铺满整个面板（`one`）；
   *   · 两个源都有数据   → 两列并排，列内单行排布、行行对齐，便于横向对比（`two`）。
   * 分列依据是"这次快照里哪些 app 真的读到了读数"，而不是"装了哪些"——
   * 装了但没开导出、或没在运行时不会出现列（那正是"谁开着读谁"）。
   */
  function renderPanelBody(bodyEl, query) {
    if (!bodyEl) return
    // 不靠 innerHTML 清空（它在某些环境下不联动 children）：显式移除所有子节点，
    // 保证重复调用只保留最后一次结果。
    try {
      while (bodyEl.firstChild) bodyEl.removeChild(bodyEl.firstChild)
      if (bodyEl.children) bodyEl.children.length = 0
    } catch (e) {}

    var q = String(query || '').toLowerCase().trim()
    // ⚠ 正则字面量里必须是 `/\s+/`（单个反斜杠）；早先误写成 `/\\s+/`
    // 等于匹配"反斜杠+s"，导致按空格分词的搜索彻底失效。
    var terms = q ? q.split(/\s+/) : []

    function matches(s) {
      if (!terms.length) return true
      var hay = ((s.group || '') + ' ' + (s.label || '') + ' ' + (s.unit || '') + ' ' + (s.category || '')).toLowerCase()
      return terms.every(function (t2) { return hay.indexOf(t2) >= 0 })
    }

    var all = state.sensors || []
    var rows = all.filter(matches)

    if (!rows.length) {
      var none = document.createElement('div')
      none.className = 'dshhw-none'
      none.textContent = all.length
        ? '没有匹配 “' + query + '” 的读数'
        : '未检测到数据源。启动 AIDA64 或 HWiNFO 并在其设置里开启传感器导出即可（两者都不要求必须开启）。'
      bodyEl.appendChild(none)
      return
    }

    // 按数据源归并；顺序稳定：HWiNFO 在前（更常用），AIDA64 在后
    var APP_ORDER = ['hwinfo', 'aida64']
    var APP_LABEL = { hwinfo: 'HWiNFO', aida64: 'AIDA64' }
    var byApp = {}
    for (var i = 0; i < rows.length; i++) {
      var app = rows[i].sourceApp || rows[i].app || rows[i].source || 'unknown'
      ;(byApp[app] = byApp[app] || []).push(rows[i])
    }
    var apps = APP_ORDER.filter(function (a) { return byApp[a] && byApp[a].length })
      .concat(Object.keys(byApp).filter(function (a) { return APP_ORDER.indexOf(a) < 0 }))

    var cols = document.createElement('div')
    cols.className = 'dshhw-cols' + (apps.length > 1 ? ' two' : ' one')
    bodyEl.appendChild(cols)

    for (var ai = 0; ai < apps.length; ai++) {
      var appName = apps[ai]
      var list = byApp[appName]
      var col = document.createElement('div')
      col.className = 'dshhw-col'
      col.setAttribute('data-source', appName)

      // 列头：源名 + 该源条数 —— 双列时一眼看出左右分别是谁
      var ch = document.createElement('div')
      ch.className = 'dshhw-col-h'
      var ct = document.createElement('span')
      ct.textContent = APP_LABEL[appName] || appName
      var cs = document.createElement('span')
      cs.className = 'dshhw-col-src'
      cs.textContent = list.length + ' 条'
      ch.appendChild(ct); ch.appendChild(cs)
      col.appendChild(ch)

      // 列内按设备组归并（组名即 HWiNFO 的 Sensor 字段）
      var groups = {}, order = []
      for (var li = 0; li < list.length; li++) {
        var g = list[li].group || '未分组'
        if (!groups[g]) { groups[g] = []; order.push(g) }
        groups[g].push(list[li])
      }
      for (var oi = 0; oi < order.length; oi++) {
        var gname = order[oi]
        var wrap = document.createElement('div')
        wrap.className = 'dshhw-group'
        var gh = document.createElement('div')
        gh.className = 'dshhw-group-h'
        gh.textContent = gname + '  (' + groups[gname].length + ')'
        wrap.appendChild(gh)
        var grid = document.createElement('div')
        grid.className = 'dshhw-grid'
        for (var ci = 0; ci < groups[gname].length; ci++) {
          var cell = document.createElement('div')
          cell.className = 'dshhw-cell'
          var a = document.createElement('span')
          a.textContent = groups[gname][ci].label || groups[gname][ci].id
          a.title = a.textContent
          var b = document.createElement('b')
          b.textContent = fmt(groups[gname][ci])
          cell.appendChild(a); cell.appendChild(b)
          grid.appendChild(cell)
        }
        wrap.appendChild(grid)
        col.appendChild(wrap)
      }
      cols.appendChild(col)
    }
  }

  function poll(force) {
    if (!window.fetch) return
    var url = BASE + '/sensors.json?limit=400' + (force ? '&refresh=1' : '')
    window.fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error('http ' + r.status); return r.json() })
      .then(function (j) {
        state.sensors = j.sensors || []
        state.sources = j.sources || []
        state.live = !!j.live
        state.failing = 0
        render()
        afterData()
        // 数据源变化提醒（接入 / 离线 / 停止更新）。去重在 showToast 内部做。
        if (j.changes && j.changes.length) handleChanges(j.changes)
      })
      .catch(function () {
        // 静默降级：插件被关掉 ⇒ 路由 404；宿主重启中 ⇒ 连接失败。
        state.failing++
        if (state.failing === 6) { state.sensors = []; state.live = false; render() }
        if (state.failing > 12) { state.sources = []; render() }
      })
  }

  function startPolling() {
    if (state.timer) clearInterval(state.timer)
    state.timer = setInterval(function () {
      // ⚠ 隐藏档 / 彻底收起都必须停止采样：宿主的缓存只有 ~1.2s，挂件每 2s 拉一次
      // 就意味着每 2s 派生一次 powershell 探测。用户既然把卡片藏了，就不该再为他
      // 看不到的数据付这份进程开销。（变化提醒也随之暂停 —— 这是"藏起来"的应有代价，
      // 从面板恢复时会 poll(true) 立刻补齐。）
      var m = readMode()
      if (m === 'dismissed') return
      if (document.hidden && state.failing > 12) return
      poll()
    }, POLL_MS)
  }

  function mount() {
    if (host) return
    if (!isChatView()) return       // 市场页等非主界面：完全不碰 DOM
    installStyles()
    host = document.createElement('div')
    host.setAttribute('data-dshhw', '1')
    document.body.appendChild(host)
    // 单例：**先建好自己的节点、再清掉其它节点**。
    // 顺序很关键 —— 若先扫描再创建，`host` 此刻还是 null，`stale[si] !== host`
    // 恒为真，会把刚 append 的节点也一起删掉（真机实测踩过这个坑）。
    // 加载期清理由脚本顶部完成，这里覆盖"同一次执行内 mount 被重复调用"的情形。
    try {
      var stale = document.querySelectorAll('[data-dshhw]')
      for (var si = 0; si < stale.length; si++) {
        if (stale[si] !== host) { try { stale[si].remove() } catch (e) {} }
      }
      var staleBtns = document.querySelectorAll('[id="' + TITLE_BTN_ID + '"]')
      for (var bi = 1; bi < staleBtns.length; bi++) { try { staleBtns[bi].remove() } catch (e) {} }
    } catch (e) {}
    state.posUser = loadPos()
    syncShownPos()   // 首次按当前视口算出显示位置（旧坐标可能已越界）
    attachDrag()
    render()
    poll()
    startPolling()
    // 标题栏入口独立于挂件卡片：即使卡片被隐藏(off)，左上角入口仍然可用 ——
    // 那是"查看完整映射数据"的主路径，不该被卡片档位影响。
    installTitleEntry()
    watchTitleEntry()
    document.addEventListener('visibilitychange', function () { poll() })
    // 窗口尺寸变化 / 进出全屏后重新钳制位置。
    // （`resize` 在多数情况下够用；`fullscreenchange` 覆盖"编辑器没触发 resize"
    //   的情形，两者的回调都是幂等的钳制。）
    var onViewportChange = function () {
      try { render() } catch (e) {}
      try {
        var b = document.getElementById(TITLE_BTN_ID)
        if (b) positionTitleEntry(b)
      } catch (e) {}
    }
    window.addEventListener('resize', onViewportChange)
    document.addEventListener('fullscreenchange', onViewportChange)
    try {
      // 有些桌面壳在窗口状态变化时既不触发 resize 也不触发 fullscreenchange，
      // 用 ResizeObserver 兜一层（只观察尺寸，不观察子树变化）。
      if (typeof ResizeObserver === 'function' && document.documentElement) {
        state.viewportObserver = new ResizeObserver(onViewportChange)
        state.viewportObserver.observe(document.documentElement)
      }
    } catch (e) {}
  }

  // 收数后同步刷新两个界面：面板里的全量列表 + 标题栏徽标
  function afterData() {
    if (panel && state.panelBody) {
      renderPanelBody(state.panelBody, state.panelInput ? state.panelInput.value : '')
      updatePanelHeader(panel.querySelector('.dshhw-panel-s'))
    }
    refreshTitleEntryBadge()
  }


  // 首屏可能还没渲染出 composer：有界重试，仍没有就永久放弃（不打扰任何页面）
  var tries = 0
  var iv = setInterval(function () {
    tries++
    if (host || tries > 40) { clearInterval(iv); return }
    mount()
    if (host) clearInterval(iv)
  }, 500)
  if (document.body) mount()
  else document.addEventListener('DOMContentLoaded', mount)
})()
