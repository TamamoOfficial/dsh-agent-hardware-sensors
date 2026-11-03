// 详细面板的自动采样测试（伪 DOM + 假 fetch）
//
// 真机缺陷：**收起悬浮提示（dismissed）后再打开详细面板，面板里的读数不再更新**，
// 必须手点「刷新」，或把悬浮提示重新显示出来（那样会 poll(true)）才能活过来。
//
// 根因：startPolling 的定时器只判 `readMode() === 'dismissed'` 就 return，
//       把"用户把卡片藏了"当成"没人要数据"，于是面板开着也照样停采。
//       收起的是**悬浮提示卡片**，不是数据；面板开着就说明用户正在看。
//
// 这里钉住四条语义：
//   1. 收起 + 没有面板 ⇒ 定时器仍然不采样（省进程开销的初衷不能丢）
//   2. 收起 + 面板开着 ⇒ 定时器**继续**采样（本次修复）
//   3. 打开面板会立刻强制采样一次（带 refresh=1，越过宿主 ≤1.2s 缓存）
//   4. 关掉面板后又回到"停采"（收起状态下不残留空转）
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
    onclick: null,
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
    removeEventListener(t, fn) { const a = this._listeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) } },
    dispatch(t, ev) {
      const e = ev || {}
      if (typeof this.onclick === 'function') this.onclick(e)
      for (const fn of this._listeners[t] || []) fn(e)
    },
    getBoundingClientRect() { return this._rect },
    querySelector(sel) {
      if (sel === '[data-windows-menu]') return null
      if (sel === 'textarea') return makeEl('textarea')
      if (sel === '.dshhw-panel-s') return null      // 面板副标题：伪 DOM 不聚合，跳过即可
      return null
    },
    querySelectorAll() { return [] },
    closest() { return null },
  }
}

function boot(opts) {
  const created = []
  const fetches = []
  const timers = []
  const body = makeEl('body')
  const head = makeEl('head')
  const html = makeEl('html')
  html._attrs['data-windows-titlebar'] = ''
  const menu = makeEl('div')
  menu._attrs['data-windows-menu'] = ''
  menu._rect = { left: 48, top: 0, width: 168, height: 40, right: 216 }

  const payload = {
    live: true,
    sources: [{ app: 'hwinfo', available: true, transport: 'shared-memory', count: 2 }],
    matched: 2,
    sensors: [
      { app: 'hwinfo', id: '1', group: 'CPU', label: 'CPU 封装', value: 39, unit: '℃', category: 'temperature' },
      { app: 'hwinfo', id: '2', group: 'GPU', label: 'GPU 温度', value: 47, unit: '℃', category: 'temperature' },
    ],
    changes: [],
  }

  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb } observe() {} disconnect() {} }
  globalThis.MutationObserver = class { constructor(cb) { this.cb = cb } observe() {} disconnect() {} }
  globalThis.window = {
    innerWidth: 1280, innerHeight: 800,
    localStorage: {
      _d: Object.assign({}, opts && opts.storage),
      getItem(k) { return this._d[k] === undefined ? null : this._d[k] },
      setItem(k, v) { this._d[k] = String(v) },
    },
    fetch: async (url) => { fetches.push(String(url)); return { ok: true, json: async () => payload } },
    addEventListener() {}, removeEventListener() {},
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
  // 只跑**定时器**回调（模拟 2s 过去），不碰其它挂载逻辑
  const tick = async () => {
    for (const fn of timers.slice()) { try { fn() } catch (e) {} }
    await flush()
  }
  // 面板是否**还挂在 DOM 上**：closePanel() 只是 panel.remove()，created 里仍留引用，
  // 所以必须查 body 的直接子节点，不能用 created 判断（否则"关掉面板"永远测不出来）。
  const panelOpen = () => body.children.some((e) => e.className === 'dshhw-panel-mask')
  const clickTitleEntry = async () => {
    const btn = created.find((e) => e.id === 'dshhw-title-entry')
    if (!btn) return false
    btn.dispatch('click', { stopPropagation() {} })
    await flush()
    return true
  }
  return {
    created, body, flush, tick, timers, fetches, panelOpen, clickTitleEntry,
    get storage() { return globalThis.window.localStorage },
  }
}

// ── 1. 收起 + 无面板 ⇒ 定时器不采样（原有省资源行为必须保住） ──
{
  const w = boot({ storage: { 'dshhw-mode': 'dismissed' } })
  await w.flush()
  const base = w.fetches.length
  await w.tick()
  ok('收起且无面板：定时器不发起请求', w.fetches.length === base, 'base=' + base + ' now=' + w.fetches.length)
}

// ── 2. 收起 + 打开面板 ⇒ 面板立刻强制采样一次（refresh=1） ──
{
  const w = boot({ storage: { 'dshhw-mode': 'dismissed' } })
  await w.flush()
  const before = w.fetches.length
  ok('面板初始未打开', !w.panelOpen())
  ok('标题栏入口在收起状态下仍可用', await w.clickTitleEntry(), 'no title entry')
  ok('面板已打开', w.panelOpen())
  ok('打开面板立刻发起一次请求',
    w.fetches.length === before + 1, 'before=' + before + ' now=' + w.fetches.length)
  const last = w.fetches[w.fetches.length - 1] || ''
  ok('打开面板的请求带 refresh=1（越过 ≤1.2s 缓存）', /refresh=1/.test(last), last)
}

// ── 3. 收起 + 面板开着 ⇒ 定时器**继续**采样（本次修复的核心） ──
{
  const w = boot({ storage: { 'dshhw-mode': 'dismissed' } })
  await w.flush()
  await w.clickTitleEntry()
  const afterOpen = w.fetches.length
  await w.tick()
  ok('收起且面板开着：定时器继续采样',
    w.fetches.length > afterOpen, 'afterOpen=' + afterOpen + ' now=' + w.fetches.length)
  const n1 = w.fetches.length
  await w.tick()
  ok('再等一拍仍在采样',
    w.fetches.length > n1, 'n1=' + n1 + ' now=' + w.fetches.length)
  const last = w.fetches[w.fetches.length - 1] || ''
  ok('定时采样用普通请求（不每次都强制 refresh）', !/refresh=1/.test(last), last)
}

// ── 4. 关掉面板后回到"停采"（收起状态下不残留空转） ──
{
  const w = boot({ storage: { 'dshhw-mode': 'dismissed' } })
  await w.flush()
  await w.clickTitleEntry()
  await w.tick()                       // 面板开着：有请求
  // 关面板：点遮罩空白处（ev.target === panel）
  const mask = w.created.filter((e) => e.className === 'dshhw-panel-mask')[0]
  ok('拿到面板遮罩', !!mask)
  if (mask) {
    mask.dispatch('click', { target: mask })
    await w.flush()
    ok('面板已关闭', !w.panelOpen())
    const base = w.fetches.length
    await w.tick()
    ok('收起且面板已关：重新停止采样', w.fetches.length === base, 'base=' + base + ' now=' + w.fetches.length)
  }
}

// ── 5. 面板「刷新」按钮强制重采（而不是复用缓存） ──
{
  const w = boot()
  await w.flush()
  await w.clickTitleEntry()
  const btn = w.created.filter((e) => e.className === 'dshhw-chip' && e.textContent === '刷新')[0]
  ok('面板里有「刷新」按钮', !!btn)
  if (btn) {
    const before = w.fetches.length
    btn.dispatch('click', { stopPropagation() {} })
    await w.flush()
    ok('「刷新」发起一次请求', w.fetches.length === before + 1, 'before=' + before + ' now=' + w.fetches.length)
    const last = w.fetches[w.fetches.length - 1] || ''
    ok('「刷新」带 refresh=1（真强制采样）', /refresh=1/.test(last), last)
  }
}

// ── 6. 正常显示档 + 面板开着同样持续采样（回归保护） ──
{
  const w = boot()
  await w.flush()
  await w.clickTitleEntry()
  const base = w.fetches.length
  await w.tick()
  ok('完整档 + 面板开着：定时器持续采样', w.fetches.length > base, 'base=' + base + ' now=' + w.fetches.length)
}

console.log(fail === 0 ? '\nPANEL_POLL PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
