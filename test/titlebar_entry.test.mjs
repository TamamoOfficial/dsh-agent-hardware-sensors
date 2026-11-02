// 标题栏入口 + 完整面板的行为测试（伪 DOM）
// 关键断言：入口按钮贴靠菜单右边缘、缩放后重新贴靠、面板能按设备分组渲染全量数据。
import fs from 'node:fs'

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

const src = fs.readFileSync(new URL('../assets/widget.js', import.meta.url), 'utf8')

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    id: '', className: '', type: '', textContent: '', innerHTML: '', placeholder: '',
    style: { cssText: '', setProperty(k, v) { this[k] = v } },
    children: [], _attrs: {}, _listeners: {}, onclick: null,
    title: '', _rect: { left: 0, top: 0, width: 0, height: 0, right: 0 },
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
    removeEventListener(t, fn) { const a = this._listeners[t]; if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1) } },
    dispatch(t, ev) { for (const fn of this._listeners[t] || []) fn(ev || {}) },
    getBoundingClientRect() { return this._rect },
    querySelector(sel) { return this._find((n) => n._matches(sel)) },
    querySelectorAll(sel) { const out = []; this._walk((n) => { if (n._matches(sel)) out.push(n) }); return out },
    closest(sel) { let n = this; while (n) { if (n._matches && n._matches(sel)) return n; n = n.parentNode } return null },
    _matches(sel) {
      if (sel[0] === '.' && !sel.includes(' ') && !sel.includes(':')) return String(this.className).split(/\s+/).includes(sel.slice(1))
      if (sel[0] === '#') return this.id === sel.slice(1)
      if (sel[0] === '[') { const k = sel.slice(1, -1).split('=')[0]; return this._attrs[k] !== undefined }
      if (sel === 'textarea') return this.tagName === 'TEXTAREA'
      if (sel === '[contenteditable="true"]') return this._attrs.contenteditable === 'true'
      return false
    },
    _walk(fn) { for (const c of this.children) { fn(c); c._walk && c._walk(fn) } },
    _find(pred) { let hit = null; this._walk((n) => { if (!hit && pred(n)) hit = n }); return hit },
  }
  return el
}

// —— 场景：桌面端（有 data-windows-titlebar + 原生菜单 host）——
const created = []
const body = makeEl('body')
const head = makeEl('head')
const html = makeEl('html')
html._attrs['data-windows-titlebar'] = ''

// 模拟原生菜单 host：left 48px, width 150 → right 198, height 40
const menuHost = makeEl('div')
menuHost._attrs['data-windows-menu'] = ''
menuHost._rect = { left: 48, top: 0, width: 150, height: 40, right: 198 }

const payload = {
  live: true,
  sources: [
    { app: 'hwinfo', available: true, transport: 'shared-memory', count: 413 },
    { app: 'aida64', available: true, transport: 'registry', count: 2, reason: '' },
  ],
  matched: 413,
  sensors: [
    { app: 'hwinfo', id: 'a', group: 'CPU [#0]: Xeon', label: 'CPU 封装', value: 39, unit: '℃', category: 'temperature' },
    { app: 'hwinfo', id: 'b', group: 'CPU [#0]: Xeon', label: 'CPU 封装功率', value: 19.593, unit: 'W', category: 'power' },
    { app: 'hwinfo', id: 'c', group: 'GPU [#1]: FirePro', label: 'GPU 温度', value: 47, unit: '℃', category: 'temperature' },
    { app: 'hwinfo', id: 'd', group: '内存时序', label: 'Tcas', value: 30, unit: 'T', category: 'other' },
    { app: 'aida64', id: 'e', group: 'CPU [#0]: Xeon', label: 'CPU Package', value: 40, unit: '℃', category: 'temperature' },
    { app: 'aida64', id: 'f', group: 'Motherboard', label: 'Motherboard', value: 35, unit: '℃', category: 'temperature' },
  ],
}

const observers = []
const listeners = {}
globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb } observe() {} disconnect() {} }
globalThis.MutationObserver = class { constructor(cb) { this.cb = cb; observers.push(this) } observe() {} disconnect() {} }
globalThis.window = {
  innerWidth: 1280, innerHeight: 800,
  localStorage: { _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k] }, setItem(k, v) { this._d[k] = String(v) } },
  fetch: async () => ({ ok: true, json: async () => payload }),
  addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn) },
}
globalThis.document = {
  body, head, hidden: false, documentElement: html,
  getElementById(id) { return created.find((e) => e.id === id) || null },
  createElement(tag) { const e = makeEl(tag); created.push(e); return e },
  createElementNS(_ns, tag) { const e = makeEl(tag); created.push(e); return e },
  querySelector(sel) {
    if (sel === '[data-windows-menu]') return menuHost
    if (sel === 'textarea') return makeEl('textarea')
    return null
  },
  addEventListener() {}, removeEventListener() {},
}
globalThis.setInterval = () => 0
globalThis.setTimeout = (fn) => { try { fn() } catch (e) {} return 0 }
globalThis.clearInterval = () => {}

const fn = new Function(src)
fn.call(globalThis)
await new Promise((r) => setImmediate(r))
await new Promise((r) => setImmediate(r))

// —— 断言 1：标题栏入口已创建并贴靠菜单右侧 ——
const btn = created.filter((e) => e.id === 'dshhw-title-entry')[0]
ok('创建了标题栏入口按钮', !!btn)
if (btn) {
  ok('按钮在 body 里', body.children.indexOf(btn) >= 0)
  ok('left 贴在菜单右边缘 +8px (198→206)', /left:206px/.test(btn.style.cssText), btn.style.cssText.slice(0, 120))
  ok('高度与标题栏一致 (40px)', /height:40px/.test(btn.style.cssText))
  ok('图标档：窄宽度 28px（不挤占菜单）', /width:28px/.test(btn.style.cssText), btn.style.cssText.slice(0, 160))
  ok('图标档：无文字（只放图标）', !btn.textContent || btn.textContent.trim() === '', JSON.stringify(btn.textContent))
  ok('z-index 高于菜单(1101)', /z-index:1101/.test(btn.style.cssText))
  ok('可点击(app-region no-drag)', /-webkit-app-region:no-drag/.test(btn.style.cssText))
  const svgEl = btn.children.find((c) => c.tagName === 'SVG')
  const rects = svgEl ? svgEl.children.filter((c) => c.tagName === 'RECT') : []
  ok('含 SVG 图标（3 根竖条）', !!svgEl && rects.length === 3, 'rects=' + rects.length
     + ' viewBox=' + (svgEl && svgEl._attrs.viewBox))
  ok('含状态点', btn.children.some((c) => c.tagName === 'SPAN'), 'children=' + btn.children.map((c) => c.tagName).join(','))
  ok('tooltip 带读数条数与源名', /6 条读数/.test(btn.title) && /HWiNFO/.test(btn.title), btn.title)
}

// —— 断言 2：点击入口打开完整面板 ——
if (btn) {
  btn.dispatch('click', { stopPropagation() {} })
  await new Promise((r) => setImmediate(r))
  const mask = created.filter((e) => e.className === 'dshhw-panel-mask')[0]
  ok('面板已打开', !!mask)
  if (mask) {
    ok('面板挂到 body', body.children.indexOf(mask) >= 0)
    const title = created.filter((e) => e.className === 'dshhw-panel-t')[0]
    ok('面板标题存在', title && title.textContent === '硬件传感器', title && title.textContent)
    const panelBody = created.filter((e) => e.className === 'dshhw-panel-body')[0]
    // 双列布局：两个源都有数据时 → two + 两个 dshhw-col
    const colsEl = panelBody && panelBody.children.filter((c) => String(c.className).indexOf('dshhw-cols') === 0)[0]
    ok('双源时用 two 双列布局', colsEl && colsEl.className === 'dshhw-cols two', colsEl && colsEl.className)
    const colEls = colsEl ? colsEl.children.filter((c) => String(c.className) === 'dshhw-col') : []
    ok('渲染两个数据源列', colEls.length === 2, 'cols=' + colEls.length)
    if (colEls.length === 2) {
      // 列头由两个子 span 组成（源名 + 条数），伪 DOM 不聚合 textContent
      const headText = (col) => {
        const h = col.children[0]
        return h ? h.children.map((c) => c.textContent).join(' ') : ''
      }
      ok('第1列是 HWiNFO', /HWiNFO/.test(headText(colEls[0])), headText(colEls[0]))
      ok('第2列是 AIDA64', /AIDA64/.test(headText(colEls[1])), headText(colEls[1]))
      ok('列头带条数', /条/.test(headText(colEls[0])), headText(colEls[0]))
      ok('列标记 data-source', colEls[0]._attrs['data-source'] === 'hwinfo' && colEls[1]._attrs['data-source'] === 'aida64',
         colEls.map((c) => c._attrs['data-source']).join('/'))
    }
    let cellCount = 0
    const walkCells = (n) => { for (const c of n.children || []) { if (String(c.className) === 'dshhw-cell') cellCount++; walkCells(c) } }
    if (panelBody) walkCells(panelBody)
    ok('按源拆分后仍渲染全部读数', cellCount === payload.sensors.length, 'cells=' + cellCount + ' expected=' + payload.sensors.length)
    const sub = created.filter((e) => e.className === 'dshhw-panel-s')[0]
    ok('副标题显示数据源与条数', sub && /HWiNFO/.test(sub.textContent) && /4/.test(sub.textContent), sub && sub.textContent)
  }
}

// —— 断言 3：菜单变宽后重新贴靠（触发 resize 监听） ——
menuHost._rect = { left: 48, top: 0, width: 210, height: 40, right: 258 }
if (btn) {
  for (const fn2 of listeners.resize || []) fn2()
  // 真实浏览器里 style.left 与 cssText 同步；伪 DOM 里读 style.left 即可
  ok('菜单变宽后重新贴靠(258→266)', btn.style.left === '266px', 'left=' + btn.style.left)
}

console.log(fail === 0 ? '\nTITLEBAR PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
