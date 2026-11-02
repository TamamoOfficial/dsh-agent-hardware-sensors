// 挂件字段契约测试：用真实接口 JSON 验证 pickKey/fmt 能挑出并可格式化读数。
// 这个测试专门防"内部字段名(num)与接口字段名(value)不一致"这类静默失败。
// 做法：在伪 DOM 里执行 assets/widget.js，喂入真实结构的 sensors，断言渲染出读数行。
import { startHost } from '../lib/index.js'
import fs from 'node:fs'

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

// —— 1) 取一份真实的接口 JSON ——
const routes = new Map(), tools = new Map()
const ctx = {
  webServer: { register: (r) => { routes.set(r.path, r); return () => {} } },
  tools: { register: (t) => { tools.set(t.name, t); return () => {} } },
  connection: { requestRejection: () => undefined },
  get: (n) => (n === 'connection' ? ctx.connection : undefined),
}
startHost(ctx, { effect() {}, on: () => () => {}, inject: (_n, cb) => { cb(ctx); return () => {} } }, [])

let wireBody = ''
const res = { writeHead: () => {}, end: (b) => { wireBody = String(b || '') }, set statusCode(_c) {} }
await routes.get('/dsh-hw/sensors.json').handler(
  { url: '/dsh-hw/sensors.json?limit=400', method: 'GET', headers: { host: '127.0.0.1:9434' } }, res)

const payload = JSON.parse(wireBody)
console.log('wire payload: live=' + payload.live + ' sensors=' + payload.sensors.length)
if (payload.sensors.length === 0) {
  console.log('SKIP: 本机当前没有传感器数据源，无法做字段契约测试')
  process.exit(0)
}

// —— 2) 断言接口字段形状 ——
const s0 = payload.sensors[0]
ok('接口用 value 字段承载数字', Object.prototype.hasOwnProperty.call(s0, 'value'), JSON.stringify(s0))
ok('接口不暴露内部 num 字段', !Object.prototype.hasOwnProperty.call(s0, 'num'))

// —— 3) 在伪 DOM 里加载挂件，验证它真能渲染出读数 ——
const widgetSrc = fs.readFileSync(new URL('../assets/widget.js', import.meta.url), 'utf8')

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '', textContent: '', innerHTML: '', style: {}, children: [],
    setAttribute() {}, appendChild(c) { this.children.push(c); return c },
    addEventListener() {}, removeEventListener() {}, querySelector() { return null },
    closest() { return null },
  }
  return el
}

const created = []
const body = makeEl('body')
const head = makeEl('head')
globalThis.window = {
  innerWidth: 1280, innerHeight: 800,
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k] },
    setItem(k, v) { this._d[k] = String(v) },
  },
  fetch: async () => ({ ok: true, json: async () => payload }),
  // 挂件在 mount 时会挂 resize / fullscreenchange 监听（视口变化重新钳制位置），
  // 伪 DOM 必须提供它们，否则 mount 直接抛 TypeError。
  addEventListener() {}, removeEventListener() {},
}
globalThis.ResizeObserver = class { constructor(cb) { this.cb = cb } observe() {} disconnect() {} }
globalThis.document = {
  body, head, hidden: false,
  getElementById: () => null,
  createElement(tag) { const e = makeEl(tag); created.push(e); return e },
  querySelector(sel) {
    // 让 isChatView() 通过：模拟"有 textarea"的主聊天界面
    if (sel === 'textarea') return makeEl('textarea')
    return null
  },
  addEventListener() {},
  documentElement: makeEl('html'),
}
globalThis.setInterval = () => 0
globalThis.setTimeout = () => 0
globalThis.clearInterval = () => {}

// 执行挂件
const fn = new Function(widgetSrc)
fn.call(globalThis)

// 挂件会先建 host 并把内容 append 进它的 children
await new Promise((r) => setImmediate(r))
await new Promise((r) => setImmediate(r))

// 找到 host（data-dshhw 标记由 setAttribute 设置，这里用 className 特征）
const hosts = created.filter((e) => String(e.className || '').indexOf('dshhw') === 0)
const host = hosts[0] || created.find((e) => e.children && e.children.some((c) => String(c.className || '').indexOf('dshhw-row') === 0))
ok('挂件创建了宿主节点', !!host)

// 在宿主里递归找 dshhw-row 元素
function collectRows(node, out) {
  if (!node) return out
  if (String(node.className || '').indexOf('dshhw-row') === 0) out.push(node)
  for (const c of node.children || []) collectRows(c, out)
  return out
}
const rows = collectRows(host, [])
ok('渲染出读数行（修复前这里是 0）', rows.length > 0, 'rows=' + rows.length + ' body children=' + body.children.length)

if (rows.length > 0) {
  const texts = rows.map((r) => (r.children || []).map((c) => c.textContent).join(' = '))
  console.log('  渲染内容:')
  for (const t of texts) console.log('    ' + t)
  const hasNumber = texts.some((t) => /=\s*[-+]?\d/.test(t))
  ok('读数含数值', hasNumber, JSON.stringify(texts.slice(0, 2)))
}

console.log(fail === 0 ? '\nWIRE PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
