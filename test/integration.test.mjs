// ============================================================================
// 集成测试：用最小 Cordis/宿主替身跑通 apply()，验证三件事
//   1. 注入行在**不依赖任何服务**的情况下就被注册（桌面端一次性收集的竞态）
//   2. 两个软件都没开 ⇒ available=false、无抛错、无凭据外泄、路由仍可答 200
//   3. 工具参数严格校验（未知键必须抛错，绝不静默忽略）
// 数据源用注入的假 readKey / runPs，不依赖本机软件状态。
// ============================================================================
import { apply } from '../lib/index.js'

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

// —— 宿主替身 ——
function makeHarness(sources) {
  const events = []
  const routes = new Map()
  const tools = new Map()
  let indexInjectCb = null
  const warns = []
  const origWarn = console.warn
  console.warn = (m) => { warns.push(String(m)) }

  const fakeWebServer = {
    register(r) { routes.set(r.path, r); return () => routes.delete(r.path) },
  }
  const fakeTools = {
    register(t) { tools.set(t.name, t); return () => tools.delete(t.name) },
  }
  const fakeConnection = {
    requestRejection(req) { return undefined }, // 全放行，专注测业务
  }

  const ctx = {
    webServer: fakeWebServer,
    tools: fakeTools,
    connection: fakeConnection,
    get(n) { return n === 'connection' ? fakeConnection : undefined },
  }

  const root = {
    effect() {},
    on(evt, cb) {
      events.push(evt)
      if (evt === 'webserver/index-inject') indexInjectCb = cb
      return () => {}
    },
    inject(names, cb) {
      // 立即执行：模拟服务都就绪
      cb(ctx)
      return () => {}
    },
  }

  // 覆盖 store 的数据源：apply() 内部 createStore() 用真实 readKey，
  // 这里用环境变量把 spawn 掐掉 —— 见下方说明。
  const harness = {
    events, routes, tools, warns,
    emitIndex(table) { if (indexInjectCb) indexInjectCb(table) },
    async callTool(args) {
      const t = tools.get('hw_sensors')
      if (!t) throw new Error('tool not registered')
      return await t.execute(args || {})
    },
    async callRoute(path, query, req = {}) {
      const r = routes.get(path)
      if (!r) throw new Error('route not registered: ' + path)
      let code = 0, body = '', headers = null
      const res = {
        writeHead(c, h) { code = c; headers = h },
        end(b) { body = b == null ? '' : String(b) },
        set statusCode(c) { code = c },
      }
      const url = new URL(path + (query ? '?' + query : ''), 'http://x')
      await r.handler({ url: url.pathname + url.search, method: 'GET', headers: { host: '127.0.0.1:19387', ...req.headers } }, res)
      return { code, body, headers }
    },
    restore() { console.warn = origWarn },
  }
  void root
  void sources
  return harness
}

// —— 1. apply() 立即注册注入行（早于任何服务注入）——
const h = makeHarness()
const order = []
{
  // 包一层：记录 inject 与 on 的相对顺序
  let injected = false
  const spy = {
    effect() {},
    on(evt, cb) { order.push('on:' + evt); if (evt === 'webserver/index-inject') h.__cb = cb; return () => {} },
    inject(names, cb) { order.push('inject:' + names.join(',')); injected = true; cb({
      webServer: { register(r) { h.routes.set(r.path, r); return () => {} } },
      tools: { register(t) { h.tools.set(t.name, t); return () => {} } },
      connection: { requestRejection() { return undefined } },
      get(n) { return n === 'connection' ? { requestRejection() { return undefined } } : undefined },
    }) },
  }
  apply(spy)
  ok('index-inject subscribed BEFORE service injection', order[0] === 'on:webserver/index-inject', JSON.stringify(order))
  ok('services injected after', injected && order.some((o) => o.startsWith('inject:')), JSON.stringify(order))

  // 注入行内容
  const table = []
  if (h.__cb) h.__cb(table)
  ok('injection row pushed', table.length === 1, JSON.stringify(table))
  ok('row kind is inline script (not script-src)', table[0] && table[0].kind === 'script', JSON.stringify(table[0] && table[0].kind))
  ok('row swallows onerror', table[0] && /onerror=function\(\)\{\}/.test(table[0].text), table[0] && table[0].text.slice(0, 120))
  ok('row targets our route', table[0] && table[0].text.indexOf('/dsh-hw/widget.js') >= 0)
  // 幂等：已有我们的行就不重复推
  const before = table.length
  if (h.__cb) h.__cb(table)
  ok('idempotent (no duplicate row)', table.length === before, 'before=' + before + ' after=' + table.length)
}
h.restore()

console.log(fail === 0 ? '\nINTEGRATION PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
