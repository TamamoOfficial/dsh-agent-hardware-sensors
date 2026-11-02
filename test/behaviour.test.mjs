// ============================================================================
// 行为测试（假数据源，可在任何机器上跑）
//   A. 两个软件都没开 ⇒ available=false、不抛错、不显示任何"你没开导出"的误导提示
//   B. 只开一个 ⇒ 只读那个，另一个静默缺席（用户的硬要求）
//   C. 软件在跑但没开导出 ⇒ 给出**可操作**的提示（与 A 区分开）
//   D. 工具参数严格校验：未知键必须抛错
//   E. HWiNFO poll_time 陈旧 ⇒ 标记 stale 而不是当成活数据
// ============================================================================
import { startHost } from '../lib/index.js'

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}
const eq = (label, got, want) => ok(label + ' = ' + JSON.stringify(want), JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got))

function harness() {
  const routes = new Map(), tools = new Map(), warns = []
  const ctx = {
    webServer: { register: (r) => { routes.set(r.path, r); return () => routes.delete(r.path) } },
    tools: { register: (t) => { tools.set(t.name, t); return () => tools.delete(t.name) } },
    connection: { requestRejection: () => undefined },
    get: (n) => (n === 'connection' ? ctx.connection : undefined),
  }
  const origWarn = console.warn
  console.warn = (m) => warns.push(String(m))
  const root = { effect() {}, on: () => () => {}, inject: (_n, cb) => { cb(ctx); return () => {} } }
  return {
    ctx, routes, tools, warns, root, disposers: [],
    restore: () => { console.warn = origWarn },
    async tool(args) { return JSON.parse(await tools.get('hw_sensors').execute(args)) },
    async route(path, query) {
      let code = 0, body = ''
      const res = { writeHead: (c) => { code = c }, end: (b) => { body = String(b || '') }, set statusCode(c) { code = c } }
      await routes.get(path).handler({ url: path + (query ? '?' + query : ''), method: 'GET', headers: { host: '127.0.0.1:9434' } }, res)
      this.restore()
      return { code, json: code === 200 && path.endsWith('.json') ? JSON.parse(body) : null, body }
    },
  }
}

/** 假 readKey：按 key 路径返回预设的 Map（或 NOT_FOUND）。 */
function fakeReadKey(table) {
  return async (key) => {
    const hit = table[key.replace(/\//g, '\\')]
    if (!hit) return { ok: false, error: 'NOT_FOUND' }
    const values = new Map(Object.entries(hit).map(([k, v]) => [k, { type: 'REG_SZ', value: v, raw: v }]))
    return { ok: true, values }
  }
}
/** 假 runPs：返回哨兵（无共享内存）。 */
function fakePsNoShm() { return async () => 'DSHHW:NONE\n' }
/** 假 tasklist：指定哪些进程活着。 */
function fakeTasklist(alive) {
  return async () => ({ stdout: alive.map((n) => `"${n}","1234","Console","1","1,000 K"`).join('\r\n') + '\r\n' })
}

const AIDA_KEY = 'HKCU\\Software\\FinalWire\\AIDA64\\SensorValues'
const HW_K1 = 'HKLM\\Software\\HWiNFO64\\VSB'
const HW_K2 = 'HKCU\\Software\\HWiNFO64\\VSB'

// ───────────────────────── A. 两个都没开 ─────────────────────────
{
  const h = harness()
  startHost(h.ctx, h.root, h.disposers, {
    storeDeps: { readKey: fakeReadKey({}), runPs: fakePsNoShm(), execFileAsync: fakeTasklist([]) },
  })
  const r = await h.tool({})
  h.restore()
  eq('A live=false', r.live, false)
  eq('A sources count', r.sources.length, 2)
  ok('A both sources unavailable', r.sources.every((s) => !s.available), JSON.stringify(r.sources))
  ok('A no misleading note', !r.sources.some((s) => s.note), JSON.stringify(r.sources.map((s) => s.note)))
  ok('A has hint', typeof r.hint === 'string' && r.hint.length > 0, r.hint)
  ok('A sensors empty', r.sensors.length === 0)
  ok('A reason is "not running"-ish', r.sources.every((s) => /no-|none|missing|not/i.test(s.reason || '')), JSON.stringify(r.sources.map(s=>s.reason)))
}

// ───────────────────────── B. 只开 HWiNFO ─────────────────────────
{
  const h = harness()
  startHost(h.ctx, h.root, h.disposers, {
    storeDeps: {
      readKey: fakeReadKey({
        [HW_K1]: { Sensor0: 'CPU [#0]: AMD Ryzen 5 9600X', Label0: '核心频率', Value0: '4,322.5 MHz', ValueRaw0: '4322.5', Color0: 'ff0000',
          Sensor1: 'CPU [#0]: AMD Ryzen 5 9600X', Label1: 'CPU (Tctl/Tdie)', Value1: '53.9 °C', ValueRaw1: '53.9', Color1: '33cc33' },
      }),
      runPs: fakePsNoShm(),
      execFileAsync: fakeTasklist(['HWiNFO64.EXE']),
    },
  })
  const r = await h.tool({})
  h.restore()
  eq('B live=true (hwinfo only)', r.live, true)
  const byApp = Object.fromEntries(r.sources.map((s) => [s.app, s]))
  eq('B hwinfo available', byApp.hwinfo.available, true)
  eq('B aida64 NOT available', byApp.aida64.available, false)
  ok('B aida64 silent (no note when not running)', !byApp.aida64.note, byApp.aida64.note)
  eq('B sensor count', r.sensors.length, 2)
  const cpuTemp = r.sensors.find((s) => /Tctl/.test(s.label))
  eq('B parses ValueRaw (not localized text)', cpuTemp && cpuTemp.value, 53.9)
  eq('B category from unit', cpuTemp && cpuTemp.category, 'temperature')
  const clk = r.sensors.find((s) => /频率/.test(s.label))
  eq('B clock value invariant-parsed', clk && clk.value, 4322.5)
  eq('B unit extracted', clk && clk.unit, 'MHz')
}

// ───────────────────────── C. 在跑但没开导出 ─────────────────────────
{
  const h = harness()
  startHost(h.ctx, h.root, h.disposers, {
    storeDeps: { readKey: fakeReadKey({}), runPs: fakePsNoShm(), execFileAsync: fakeTasklist(['AIDA64.EXE']) },
  })
  const r = await h.tool({})
  h.restore()
  const aida = r.sources.find((s) => s.app === 'aida64')
  eq('C aida unavailable', aida.available, false)
  ok('C actionable note present', typeof aida.note === 'string' && /首选项|Preferences|勾选|Enable/i.test(aida.note), aida.note)
  const hw = r.sources.find((s) => s.app === 'hwinfo')
  ok('C hwinfo silent (not running)', !hw.note, hw.note)
}

// ───────────────────────── D. 参数严格校验 ─────────────────────────
{
  const h = harness()
  startHost(h.ctx, h.root, h.disposers, {
    storeDeps: { readKey: fakeReadKey({}), runPs: fakePsNoShm(), execFileAsync: fakeTasklist([]) },
  })
  const t = h.tools.get('hw_sensors')
  const grab = async (args) => { try { await t.execute(args); return null } catch (e) { return String(e.message) } }
  ok('D unknown key rejected', /unknown argument/.test((await grab({ categroy: 'temperature' })) || ''), await grab({ categroy: 'x' }))
  ok('D wrong type rejected', /must be/.test((await grab({ limit: '20' })) || ''))
  ok('D wrong bool rejected', /must be/.test((await grab({ refresh: 'yes' })) || ''))
  ok('D null args accepted', (await grab(null)) === null)
  ok('D valid args accepted', (await grab({ category: 'temperature', limit: 5 })) === null)
  h.restore()
}

// ───────────────────────── E. 路由 + 陈旧判定 ─────────────────────────
{
  const h = harness()
  // 假的 SM2：header 完整、poll_time 在 60s 前 ⇒ 应判 stale
  const meta = { ver: 2, poll: Math.floor(Date.now() / 1000) - 60, offS: 48, sizeS: 392, numS: 1, offR: 48 + 392, sizeR: 460, numR: 1, acp: 'gbk' }
  const buf = Buffer.alloc(meta.offR + 460)
  buf.writeUInt32LE(0x53695748, 0); buf.writeUInt32LE(2, 4); buf.writeBigUInt64LE(BigInt(meta.poll), 12)
  buf.writeUInt32LE(meta.offS, 20); buf.writeUInt32LE(392, 24); buf.writeUInt32LE(1, 28)
  buf.writeUInt32LE(meta.offR, 32); buf.writeUInt32LE(460, 36); buf.writeUInt32LE(1, 40)
  buf.write('CPU [#0]: Test', meta.offS + 0x08, 'latin1')
  buf.write('系统: CPU', meta.offS + 0x108, 'utf8')
  buf.writeUInt32LE(1, meta.offR + 0)      // tReading = temperature
  buf.writeUInt32LE(0, meta.offR + 4)      // sensor index 0
  buf.writeUInt32LE(0x01000000, meta.offR + 8)
  buf.write('CPU (Tctl)', meta.offR + 0x0C, 'latin1')
  buf.write('°C', meta.offR + 0x10C, 'latin1')
  buf.writeDoubleLE(66.5, meta.offR + 0x11C)
  buf.write('CPU 温度', meta.offR + 0x13C, 'utf8')
  buf.write('℃', meta.offR + 0x1BC, 'utf8')
  const hdr = `DSHHW|2|${meta.poll}|48|392|1|${meta.offR}|460|1|gbk`
  const ps = async () => hdr + '\n' + buf.toString('base64') + '\n'

  startHost(h.ctx, h.root, h.disposers, {
    storeDeps: { readKey: fakeReadKey({}), runPs: ps, execFileAsync: fakeTasklist(['HWiNFO64.EXE']) },
  })
  const r = await h.tool({})
  const hw = r.sources.find((s) => s.app === 'hwinfo')
  eq('E stale flagged', hw.stale, true)
  eq('E poll age seconds', hw.pollAgeSeconds >= 55, true)
  const dec = r.sensors[0]
  eq('E utf8 label preferred', dec && dec.label, 'CPU 温度')
  eq('E utf8 unit preferred', dec && dec.unit, '℃')
  eq('E double decoded', dec && dec.value, 66.5)
  eq('E category from tReading', dec && dec.category, 'temperature')

  const rt = await h.route('/dsh-hw/sensors.json', 'category=temperature')
  eq('E route 200', rt.code, 200)
  ok('E route json shaped', rt.json && Array.isArray(rt.json.sources) && typeof rt.json.live === 'boolean', JSON.stringify(rt.json && Object.keys(rt.json)))
  const w = await h.route('/dsh-hw/widget.js')
  eq('E widget route 200', w.code, 200)
  ok('E widget is js', /dshhw|__dshHwSensorsWidget/.test(w.body))
  h.restore()
}

// ───────────────────────── F. 非回环 Host 拒绝 ─────────────────────────
{
  const h = harness()
  startHost(h.ctx, h.root, h.disposers, {
    storeDeps: { readKey: fakeReadKey({}), runPs: fakePsNoShm(), execFileAsync: fakeTasklist([]) },
  })
  let code = 0
  const res = { writeHead: (c) => { code = c }, end: () => {}, set statusCode(c) { code = c } }
  await h.routes.get('/dsh-hw/sensors.json').handler(
    { url: '/dsh-hw/sensors.json', method: 'GET', headers: { host: 'evil.example.com', 'sec-fetch-site': 'cross-site' } }, res)
  h.restore()
  ok('F cross-site non-loopback rejected 403', code === 403, 'code=' + code)
}

console.log(fail === 0 ? '\nBEHAVIOUR PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
