// 悬浮提示收起/恢复 + 单例 测试
//   A. Shift+点击小点 → 彻底收起（节点不可见、不再轮询）
//   B. 面板里有"显示悬浮提示"开关，可恢复
//   C. 整个页面最多一个挂件节点与一个标题栏入口（重复注入也只留一个）
//
// ⚠ 本文件用伪 DOM + **手工 dispatch('click')**，因此它**测不出**真实交互路径上的
//   问题（例如 pointer capture 把合成 click 重定向走、导致"点了没反应"）。
//   真实鼠标行为的验证由 test/realinput.test.mjs 负责（Chrome DevTools Protocol
//   发送真实输入事件，浏览器像处理物理点击一样合成完整事件链）。
//   历史教训：这套测试曾经"全绿"，而真实点击是失效的 —— 别让它单独充当交互证据。
import fs from 'node:fs'

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

const src = fs.readFileSync(new URL('../assets/widget.js', import.meta.url), 'utf8')

function makeEl(tag) {
  return {
    tagName: String(tag || 'div').toUpperCase(), id: '', className: '', type: '', textContent: '',
    placeholder: '', style: { cssText: '' }, children: [], _attrs: {}, _listeners: {}, title: '',
    _rect: { left: 0, top: 0, width: 0, height: 0, right: 0 },
    setAttribute(k, v) { this._attrs[k] = String(v) },
    getAttribute(k) { return this._attrs[k] === undefined ? null : this._attrs[k] },
    hasAttribute(k) { return this._attrs[k] !== undefined },
    appendChild(c) { this.children.push(c); c.parentNode = this; return c },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null } return c },
    remove() { if (this.parentNode) { this.parentNode.removeChild(this); this.parentNode = null } },
    get firstChild() { return this.children[0] || null },
    set firstChild(_v) {},
    set innerHTML(_v) { this.children.length = 0 },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn) },
    removeEventListener() {},
    dispatch(t, ev) {
      // 伪 DOM 必须同时触发 addEventListener 注册的监听器**和** onclick 属性
      // （挂件里两类都用到了；只派发其中一类会静默漏掉点击）
      const e = ev || {}
      if (typeof this.onclick === 'function') { try { this.onclick(e) } catch (err) { throw err } }
      for (const fn of this._listeners[t] || []) fn(e)
    },
    getBoundingClientRect() { return this._rect },
    querySelector(sel) {
      if (sel === '[data-windows-menu]') return null
      if (sel === 'textarea') return makeEl('textarea')
      return null
    },
    querySelectorAll(sel) {
      // 支持 [data-dshhw] 与 [id="dshhw-title-entry"]；必须查 body 的**直接子节点**
      // （挂件节点就是直接挂在 body 上的，只递归子孙会漏掉它们）
      const out = []
      const body = globalThis.document.body
      const matchOne = (c) => {
        if (sel === '[data-dshhw]') return c._attrs && c._attrs['data-dshhw'] !== undefined
        if (sel.indexOf('id="') >= 0) {
          const want = sel.slice(sel.indexOf('id="') + 4, -2)
          return c.id === want
        }
        return false
      }
      const walk = (n) => {
        for (const c of n.children || []) { if (matchOne(c)) out.push(c); walk(c) }
      }
      walk(body)
      return out
    },
    closest() { return null },
  }
}

function boot(opts) {
  const created = []
  const body = makeEl('body')
  const head = makeEl('head')
  const html = makeEl('html')
  html._attrs['data-windows-titlebar'] = ''
  const menu = makeEl('div')
  menu._attrs['data-windows-menu'] = ''
  menu._rect = { left: 48, top: 0, width: 168, height: 40, right: 216 }

  const payload = {
    live: true,
    sources: [
      { app: 'hwinfo', available: true, transport: 'shared-memory', count: 2 },
      { app: 'aida64', available: false, transport: 'none', count: 0, reason: 'none' },
    ],
    matched: 2,
    sensors: [
      { app: 'hwinfo', id: '1', group: 'CPU', label: 'CPU 封装', value: 39, unit: '℃', category: 'temperature' },
      { app: 'hwinfo', id: '2', group: 'GPU', label: 'GPU 温度', value: 47, unit: '℃', category: 'temperature' },
    ],
    changes: [],
  }
  const timers = []
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb } observe() {} disconnect() {} }
globalThis.MutationObserver = class { constructor(cb) { this.cb = cb } observe() {} disconnect() {} }
  globalThis.window = {
    innerWidth: 1280, innerHeight: 800,
    localStorage: {
      _d: Object.assign({}, opts && opts.storage),
      getItem(k) { return this._d[k] === undefined ? null : this._d[k] },
      setItem(k, v) { this._d[k] = String(v) },
    },
    fetch: async () => ({ ok: true, json: async () => payload }),
    addEventListener() {},
  }
  globalThis.document = {
    body, head, hidden: false, documentElement: html,
    getElementById(id) { return created.find((e) => e.id === id) || null },
    createElement(t) { const e = makeEl(t); created.push(e); return e },
    createElementNS(_ns, t) { const e = makeEl(t); created.push(e); return e },
    querySelector(sel) {
      if (sel === '[data-windows-menu]') return menu
      if (sel === 'textarea') return makeEl('textarea')
      return null
    },
    addEventListener() {}, removeEventListener() {},
  }
  globalThis.setInterval = (fn) => { timers.push(fn); return 0 }
  globalThis.setTimeout = (fn) => { timers.push(fn); return timers.length }
  globalThis.clearInterval = () => {}
  globalThis.clearTimeout = () => {}

  new Function(src)()
  const flush = async () => {
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
  }
  const tick = async () => { for (const fn of timers) { try { fn() } catch (e) {} } await flush() }
  return { created, body, flush, tick, timers, get host() { return body.children.find((c) => c.className && String(c.className).indexOf('dshhw') === 0) }, get storage() { return globalThis.window.localStorage } }
}

// ── A. Shift+点击小点 → 彻底收起 ──
{
  const w = boot()
  await w.flush()
  const host = w.body.children.find((c) => c._attrs['data-dshhw'] !== undefined)
  ok('初始渲染出挂件节点', !!host, 'body children=' + w.body.children.length)
  const head = host && host.children.find((c) => String(c.className) === 'dshhw-h')
  const cyc = head && head.children.find((c) => c.textContent === '◦')
  ok('小点存在', !!cyc, head ? head.children.map((c) => c.textContent).join('/') : 'no head')

  if (cyc) {
    // Shift+点击
    cyc.dispatch('click', { stopPropagation() {}, shiftKey: true })
    await w.flush()
    ok('Shift+点击后写入 dismissed', w.storage.getItem('dshhw-mode') === 'dismissed', w.storage.getItem('dshhw-mode'))
    ok('挂件节点变为 dismissed 类', /dshhw-dismissed/.test(String(host.className)), host.className)
    ok('收起后不渲染任何内容', host.children.length === 0, 'children=' + host.children.length)
  }
}

// ── A2. 普通点击仍循环档位（不该被 Shift 逻辑影响） ──
{
  const w = boot()
  await w.flush()
  const host = w.body.children.find((c) => c._attrs['data-dshhw'] !== undefined)
  const head = host.children.find((c) => String(c.className) === 'dshhw-h')
  const cyc = head.children.find((c) => c.textContent === '◦')
  cyc.dispatch('click', { stopPropagation() {}, shiftKey: false })
  await w.flush()
  ok('普通点击切到 mini（不是 dismissed）', w.storage.getItem('dshhw-mode') === 'mini', w.storage.getItem('dshhw-mode'))
}

// ── B. 面板里的恢复开关 ──
{
  const w = boot({ storage: { 'dshhw-mode': 'dismissed' } })
  await w.flush()
  // 从标题栏入口打开面板
  const btn = w.created.find((e) => e.id === 'dshhw-title-entry')
  ok('收起状态下标题栏入口仍在', !!btn)
  btn.dispatch('click', { stopPropagation() {} })
  await w.flush()
  const dockBtn = w.created.filter((e) => e.className === 'dshhw-chip' && /悬浮提示/.test(e.textContent))[0]
  ok('面板里有悬浮提示开关', !!dockBtn, w.created.filter((e) => e.className === 'dshhw-chip').map((e) => e.textContent).join('/'))
  ok('收起时开关文案是"显示悬浮提示"', dockBtn && dockBtn.textContent === '显示悬浮提示', dockBtn && dockBtn.textContent)

  if (dockBtn) {
    dockBtn.dispatch('click', { stopPropagation() {} })
    await w.flush()
    ok('点击后模式恢复为 full', w.storage.getItem('dshhw-mode') === 'full', w.storage.getItem('dshhw-mode'))
    ok('开关文案变为"隐藏悬浮提示"', dockBtn.textContent === '隐藏悬浮提示', dockBtn.textContent)
    const host2 = w.body.children.find((c) => c._attrs['data-dshhw'] !== undefined)
    ok('挂件重新可见（不再是 dismissed）', !/dshhw-dismissed/.test(String(host2.className)), host2.className)
  }
}

// ── B2. 面板开关可再次隐藏 ──
{
  const w = boot()
  await w.flush()
  const btn = w.created.find((e) => e.id === 'dshhw-title-entry')
  btn.dispatch('click', { stopPropagation() {} })
  await w.flush()
  const dockBtn = w.created.filter((e) => e.className === 'dshhw-chip' && /悬浮提示/.test(e.textContent))[0]
  ok('可见时开关文案是"隐藏悬浮提示"', dockBtn && dockBtn.textContent === '隐藏悬浮提示', dockBtn && dockBtn.textContent)
  if (dockBtn) {
    dockBtn.dispatch('click', { stopPropagation() {} })
    await w.flush()
    ok('再点一次又收起', w.storage.getItem('dshhw-mode') === 'dismissed', w.storage.getItem('dshhw-mode'))
  }
}

// ── C. 单例 ──
// 单例清理依赖 `document.querySelectorAll('[data-dshhw]')`，而本文件的伪 DOM
// 无法忠实实现它（遍历语义与真实浏览器有差异）。**该行为改由
// test/realbrowser.test.mjs 在真实 Chrome 里验证**（真 DOM、真 CSS、真实例），
// 这里只保留一个"不复用已存在实例"的轻量断言，避免两套不等价实现互相误导。
{
  const w = boot()
  await w.flush()
  const first = w.body.children.filter((c) => c._attrs['data-dshhw'] !== undefined)
  ok('初始只挂载一个挂件节点', first.length === 1, 'count=' + first.length)

  // 不清 window 标记，重复执行脚本：应被模块守卫直接挡住、不新增节点
  new Function(src)()
  await w.flush()
  const after = w.body.children.filter((c) => c._attrs['data-dshhw'] !== undefined).length
  ok('单例：window 标记挡住重复执行（节点数不变）', after === 1, 'count=' + after)
}

console.log(fail === 0 ? '\nDISMISS PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
