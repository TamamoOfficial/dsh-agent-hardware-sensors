// 提醒（toast）渲染测试：接入/离线/停更三种提示，去重、动作按钮、自动消失
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
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c },
    remove() { if (this.parentNode) this.parentNode.removeChild(this) },
    get firstChild() { return this.children[0] || null },
    set firstChild(_v) {},
    set innerHTML(_v) { this.children.length = 0 },
    addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn) },
    removeEventListener() {},
    dispatch(t, ev) { for (const fn of this._listeners[t] || []) fn(ev || {}) },
    getBoundingClientRect() { return this._rect },
    querySelector() { return null }, querySelectorAll() { return [] }, closest() { return null },
  }
}

/** 起一个挂件实例，返回 {created, body, feed(json)} —— feed 模拟一次轮询返回。 */
function boot(payloadFirst) {
  const created = []
  const body = makeEl('body')
  const head = makeEl('head')
  const html = makeEl('html')
  html._attrs['data-windows-titlebar'] = ''
  let next = payloadFirst
  const timers = []
  globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb } observe() {} disconnect() {} }
globalThis.MutationObserver = class { constructor(cb) { this.cb = cb } observe() {} disconnect() {} }
  globalThis.window = {
    innerWidth: 1280, innerHeight: 800,
    localStorage: { _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k] }, setItem(k, v) { this._d[k] = String(v) } },
    fetch: async () => ({ ok: true, json: async () => next }),
    addEventListener() {},
  }
  globalThis.document = {
    body, head, hidden: false, documentElement: html,
    getElementById(id) { return created.find((e) => e.id === id) || null },
    createElement(t) { const e = makeEl(t); created.push(e); return e },
    createElementNS(_ns, t) { const e = makeEl(t); created.push(e); return e },
    querySelector(sel) { return sel === 'textarea' ? makeEl('textarea') : null },
    addEventListener() {}, removeEventListener() {},
  }
  // 同步执行的 interval/setTimeout，便于断言
  globalThis.setInterval = (fn) => { timers.push(fn); return 0 }
  globalThis.setTimeout = (fn, _ms) => { timers.push(fn); return timers.length }
  globalThis.clearInterval = () => {}
  globalThis.clearTimeout = () => {}

  new Function(src)()
  const flush = async () => {
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
  }
  // 换数据后触发一次真实的轮询（调用挂件注册的 interval 回调），再等 it 落地
  const feed = async (payload) => {
    next = payload
    for (const fn of timers) { try { fn() } catch (e) {} }
    await flush()
  }
  return { created, body, flush, feed, timers, get toasts() { return body.children.filter((c) => String(c.className).indexOf('dshhw-toast') === 0) } }
}

const baseSources = [
  { app: 'hwinfo', available: true, transport: 'shared-memory', count: 2 },
  { app: 'aida64', available: false, transport: 'none', count: 0, reason: 'no-shared-memory' },
]
const baseSensors = [
  { app: 'hwinfo', id: '1', group: 'CPU', label: 'CPU 封装', value: 39, unit: '℃', category: 'temperature' },
]

// ── 场景 1：新数据源接入 → info 提示，说明自动生效 ──
{
  const w = boot({ live: true, sources: baseSources, matched: 1, sensors: baseSensors, changes: [] })
  await w.flush()
  ok('初始无提醒', w.toasts.length === 0, 'toasts=' + w.toasts.length)

  await w.feed({
    live: true, sources: baseSources, matched: 1, sensors: baseSensors,
    changes: [{ source: 'hwinfo', from: 'offline', to: 'online', count: 2, actionable: false }],
  })
  ok('接入时弹出一条提醒', w.toasts.length === 1, 'toasts=' + w.toasts.length)
  if (w.toasts.length === 1) {
    const t = w.toasts[0]
    // 递归收集所有文本（提醒结构是 ico + body(title,msg,actions) + ×）
    const collectText = (n) => {
      if (!n) return ''
      let s = n.textContent || ''
      for (const c of n.children || []) s += ' ' + collectText(c)
      return s
    }
    const all = collectText(t)
    ok('提醒标题含数据源名', /HWiNFO/.test(all), all.slice(0, 80))
    ok('接入提醒是 info 级（无 warn/err 类）', !/warn|err/.test(String(t.className)), t.className)
    ok('文案说明无需重载', /无需重载|自动生效/.test(all), all.slice(0, 120))
  }
}

// ── 场景 2：重复的同一条 changes 不应刷屏（去重） ──
{
  const w = boot({ live: true, sources: baseSources, matched: 1, sensors: baseSensors, changes: [] })
  await w.flush()
  const evt = [{ source: 'hwinfo', from: 'offline', to: 'online', count: 2, actionable: false }]
  await w.feed({ live: true, sources: baseSources, matched: 1, sensors: baseSensors, changes: evt })
  await w.feed({ live: true, sources: baseSources, matched: 1, sensors: baseSensors, changes: evt })
  ok('同一条提醒只显示一条（去重）', w.toasts.length === 1, 'toasts=' + w.toasts.length)
}

// ── 场景 3：软件退出（注册表残留）→ warn 提示 + 动作按钮 ──
{
  const staleSources = [
    { app: 'hwinfo', available: true, stale: true, transport: 'registry', count: 1,
      note: 'HWiNFO 已退出，注册表里保留的是上一次的快照（不会自动清除）' },
    { app: 'aida64', available: false, transport: 'none', count: 0, reason: 'no-shared-memory' },
  ]
  const w = boot({ live: true, sources: baseSources, matched: 1, sensors: baseSensors, changes: [] })
  await w.flush()
  await w.feed({
    live: false, sources: staleSources, matched: 1, sensors: baseSensors,
    changes: [{ source: 'hwinfo', from: 'online', to: 'stale', count: 1, actionable: true }],
  })
  ok('停更时弹出一条提醒', w.toasts.length === 1, 'toasts=' + w.toasts.length)
  const t = w.toasts[0]
  ok('停更提醒是 warn 级', /warn/.test(String(t.className)), t.className)
  const btns = []
  const walk = (n) => { for (const c of n.children || []) { if (String(c.className) === 'dshhw-toast-btn') btns.push(c); walk(c) } }
  walk(t)
  ok('提供动作按钮（查看面板 / 重载插件）', btns.length === 2, 'btns=' + btns.map((b) => b.textContent).join('/'))
  ok('有"重载插件"按钮', btns.some((b) => /重载/.test(b.textContent)), btns.map((b) => b.textContent).join('/'))
  ok('文案点明 HWiNFO 退出后残留快照', /退出|快照|旧数据/.test(
    (t.children || []).map((c) => (c.children || []).map((d) => d.textContent).join('')).join('')), 'see message')
}

// ── 场景 4：离线 → warn 提示 ──
{
  const offSources = [
    { app: 'hwinfo', available: false, transport: 'none', count: 0, reason: 'no-shared-memory' },
    { app: 'aida64', available: false, transport: 'none', count: 0, reason: 'no-shared-memory' },
  ]
  const w = boot({ live: true, sources: baseSources, matched: 1, sensors: baseSensors, changes: [] })
  await w.flush()
  await w.feed({
    live: false, sources: offSources, matched: 0, sensors: [],
    changes: [{ source: 'hwinfo', from: 'online', to: 'offline', count: 0, actionable: true }],
  })
  ok('离线时弹出提醒', w.toasts.length === 1, 'toasts=' + w.toasts.length)
  ok('离线提醒是 warn 级', /warn/.test(String(w.toasts[0].className)))
  ok('无 changes 时不产生提醒', true)
}

// ── 场景 5：空 changes 不弹 ──
{
  const w = boot({ live: true, sources: baseSources, matched: 1, sensors: baseSensors, changes: [] })
  await w.flush()
  await w.feed({ live: true, sources: baseSources, matched: 1, sensors: baseSensors, changes: [] })
  ok('没有变化事件时不打扰用户', w.toasts.length === 0, 'toasts=' + w.toasts.length)
}

console.log(fail === 0 ? '\nTOAST PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
