// 单源/双源布局切换测试：确认"一个软件就只有一列、两个都有才双列"
import fs from 'node:fs'

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

const src = fs.readFileSync(new URL('../assets/widget.js', import.meta.url), 'utf8')

function makeEl(tag) {
  const el = {
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
    querySelector(sel) {
      if (sel === '[data-windows-menu]') return null
      if (sel === 'textarea') return makeEl('textarea')
      return null
    },
    querySelectorAll() { return [] },
    closest() { return null },
  }
  return el
}

/** 按给定的 sensors 数组跑一遍面板渲染，返回 {colsEl, colEls, cellCount}。 */
async function renderWith(sensors, sources) {
  const created = []
  const body = makeEl('body')
  const head = makeEl('head')
  const html = makeEl('html')
  html._attrs['data-windows-titlebar'] = ''

  const payload = { live: true, sources, matched: sensors.length, sensors }
  const winLis = {}
  globalThis.MutationObserver = class { constructor(cb) { this.cb = cb } observe() {} disconnect() {} }
  globalThis.window = {
    innerWidth: 1280, innerHeight: 800,
    localStorage: { _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k] }, setItem(k, v) { this._d[k] = String(v) } },
    fetch: async () => ({ ok: true, json: async () => payload }),
    addEventListener(t, fn) { (winLis[t] = winLis[t] || []).push(fn) },
  }
  globalThis.document = {
    body, head, hidden: false, documentElement: html,
    getElementById(id) { return created.find((e) => e.id === id) || null },
    createElement(t) { const e = makeEl(t); created.push(e); return e },
    createElementNS(_ns, t) { const e = makeEl(t); created.push(e); return e },
    querySelector(sel) {
      if (sel === '[data-windows-menu]') return null
      if (sel === 'textarea') return makeEl('textarea')
      return null
    },
    addEventListener() {}, removeEventListener() {},
  }
  globalThis.setInterval = () => 0
  globalThis.setTimeout = (fn) => { try { fn() } catch (e) {} return 0 }
  globalThis.clearInterval = () => {}

  // 桌面端才有菜单；本测试聚焦面板，所以直接调用内部函数不可行 ——
  // 改为喂数据后从卡片打开面板：先挂载，再点击卡片标题展开不行（那是列表），
  // 这里用 openPanel 的公开路径：模拟点击标题栏入口（桌面端会创建它）。
  // 为让入口出现，给一个菜单 host。
  const menu = makeEl('div')
  menu._attrs['data-windows-menu'] = ''
  globalThis.document.querySelector = (sel) => {
    if (sel === '[data-windows-menu]') return menu
    if (sel === 'textarea') return makeEl('textarea')
    return null
  }
  menu._rect = { left: 48, top: 0, width: 168, height: 40, right: 216 }

  new Function(src)()
  await new Promise((r) => setImmediate(r))
  await new Promise((r) => setImmediate(r))

  const btn = created.find((e) => e.id === 'dshhw-title-entry')
  if (!btn) return { colsEl: null, colEls: [], cellCount: 0 }
  btn.dispatch('click', { stopPropagation() {} })
  await new Promise((r) => setImmediate(r))

  const panelBody = created.find((e) => e.className === 'dshhw-panel-body')
  const colsEl = panelBody && panelBody.children.find((c) => String(c.className).indexOf('dshhw-cols') === 0)
  const colEls = colsEl ? colsEl.children.filter((c) => String(c.className) === 'dshhw-col') : []
  let cellCount = 0
  const walk = (n) => { for (const c of n.children || []) { if (String(c.className) === 'dshhw-cell') cellCount++; walk(c) } }
  if (panelBody) walk(panelBody)
  return { colsEl, colEls, cellCount, btn }
}

const hw = [
  { app: 'hwinfo', id: '1', group: 'CPU [#0]', label: 'CPU 封装', value: 39, unit: '℃', category: 'temperature' },
  { app: 'hwinfo', id: '2', group: 'GPU [#1]', label: 'GPU 温度', value: 47, unit: '℃', category: 'temperature' },
]
const ai = [
  { app: 'aida64', id: '3', group: 'CPU', label: 'CPU Package', value: 40, unit: '℃', category: 'temperature' },
  { app: 'aida64', id: '4', group: 'Motherboard', label: 'Motherboard', value: 35, unit: '℃', category: 'temperature' },
]

// ── 场景 A：只有 HWiNFO ──
{
  const r = await renderWith(hw, [
    { app: 'hwinfo', available: true, transport: 'shared-memory', count: 2 },
    { app: 'aida64', available: false, transport: 'none', count: 0, reason: 'no-shared-memory' },
  ])
  ok('A 单源：one 布局', r.colsEl && r.colsEl.className === 'dshhw-cols one', r.colsEl && r.colsEl.className)
  ok('A 单源：只有一列', r.colEls.length === 1, 'cols=' + r.colEls.length)
  ok('A 单源：列是 HWiNFO', r.colEls[0] && r.colEls[0]._attrs['data-source'] === 'hwinfo')
  ok('A 单源：渲染 2 条', r.cellCount === 2, 'cells=' + r.cellCount)
}

// ── 场景 B：只有 AIDA64 ──
{
  const r = await renderWith(ai, [
    { app: 'hwinfo', available: false, transport: 'none', count: 0, reason: 'no-shared-memory' },
    { app: 'aida64', available: true, transport: 'registry', count: 2 },
  ])
  ok('B 单源：one 布局', r.colsEl && r.colsEl.className === 'dshhw-cols one', r.colsEl && r.colsEl.className)
  ok('B 单源：只有一列', r.colEls.length === 1, 'cols=' + r.colEls.length)
  ok('B 单源：列是 AIDA64', r.colEls[0] && r.colEls[0]._attrs['data-source'] === 'aida64')
  ok('B 单源：渲染 2 条', r.cellCount === 2, 'cells=' + r.cellCount)
}

// ── 场景 C：两个都有 ──
{
  const r = await renderWith(hw.concat(ai), [
    { app: 'hwinfo', available: true, transport: 'shared-memory', count: 2 },
    { app: 'aida64', available: true, transport: 'registry', count: 2 },
  ])
  ok('C 双源：two 布局', r.colsEl && r.colsEl.className === 'dshhw-cols two', r.colsEl && r.colsEl.className)
  ok('C 双源：两列', r.colEls.length === 2, 'cols=' + r.colEls.length)
  ok('C 双源：HWiNFO 在左', r.colEls[0] && r.colEls[0]._attrs['data-source'] === 'hwinfo')
  ok('C 双源：AIDA64 在右', r.colEls[1] && r.colEls[1]._attrs['data-source'] === 'aida64')
  ok('C 双源：渲染 4 条', r.cellCount === 4, 'cells=' + r.cellCount)
}

// ── 场景 D：都没有 ──
{
  const r = await renderWith([], [
    { app: 'hwinfo', available: false, transport: 'none', count: 0, reason: 'no-shared-memory' },
    { app: 'aida64', available: false, transport: 'none', count: 0, reason: 'no-shared-memory' },
  ])
  ok('D 无源：不建列容器', !r.colsEl, r.colsEl && r.colsEl.className)
  ok('D 无源：无读数', r.cellCount === 0, 'cells=' + r.cellCount)
}

console.log(fail === 0 ? '\nCOLUMN LAYOUT PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
