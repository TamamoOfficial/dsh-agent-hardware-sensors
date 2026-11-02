// 数据源变化事件（changes）测试：接入 / 离线 / 停止更新，且不重复刷
import { createStore } from '../lib/store.js'

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

let hwinfoOn = false          // 进程是否在跑
let registryResidue = false   // 注册表里是否留着上次的快照（HWiNFO 退出后不清除）
const hwRows = {
  Sensor0: 'CPU [#0]: Test', Label0: 'CPU 封装', Value0: '39.0 °C', ValueRaw0: '39.0', Color0: '33cc33',
}
const readKey = async (key) => {
  if (!key.includes('HWiNFO64\\VSB')) return { ok: false, error: 'NOT_FOUND' }
  // 关键：注册表残留独立于进程状态 —— HWiNFO 退出后键仍在
  if (!registryResidue) return { ok: false, error: 'NOT_FOUND' }
  const values = new Map(Object.entries(hwRows).map(([k, v]) => [k, { type: 'REG_SZ', value: v, raw: v }]))
  return { ok: true, values }
}
const noShm = async () => 'DSHHW:NONE\n'
const tasklist = async () => ({ stdout: hwinfoOn ? '"HWiNFO64.EXE","1","Console","1","1 K"\r\n' : '' })

const store = createStore({ readKey, runPs: noShm, execFileAsync: tasklist })
const st = store.states

// ① 首测：离线。首次探测**不应**产生事件（否则每次开页面都提醒一次）
let snap = await store.get({ force: true })
ok('首测不产生 change（避免误报）', !snap.changes || snap.changes.length === 0,
   JSON.stringify(snap.changes))

// ② 接入：应产生一条 online
hwinfoOn = true
registryResidue = true
st.get('hwinfo').nextProbeAt = Date.now() - 1
snap = await store.get({ force: true })
const onlineEv = (snap.changes || []).filter((c) => c.source === 'hwinfo' && c.to === 'online')
ok('接入时产生 online 事件', onlineEv.length === 1, JSON.stringify(snap.changes))
ok('online 事件带条数', onlineEv[0] && onlineEv[0].count > 0, onlineEv[0] && String(onlineEv[0].count))
ok('online 不需要用户动作', onlineEv[0] && onlineEv[0].actionable === false)

// ③ 再采样一次（状态没变）：不应重复产生事件
const before = snap.changes.length
st.get('hwinfo').nextProbeAt = Date.now() - 1
snap = await store.get({ force: true })
ok('状态未变时不重复产生事件', snap.changes.length === before,
   'before=' + before + ' after=' + snap.changes.length)

// ④ 软件退出（注册表残留）→ 应产生 stale 事件，且 actionable
// 关键：进程停了，但注册表键还在（HWiNFO 的真实行为）
hwinfoOn = false
registryResidue = true
st.get('hwinfo').nextProbeAt = Date.now() - 1
snap = await store.get({ force: true })
const staleEv = (snap.changes || []).filter((c) => c.source === 'hwinfo' && c.to === 'stale')
ok('软件退出后产生 stale 事件（注册表残留）', staleEv.length === 1, JSON.stringify(snap.changes))
ok('stale 需要用户动作', staleEv[0] && staleEv[0].actionable === true)
ok('stale 时 source 标 stale=true', snap.sources.find((s) => s.source === 'hwinfo').stale === true)

// ⑤ 记录上限：不无限增长
for (let i = 0; i < 40; i++) {
  hwinfoOn = !hwinfoOn
  st.get('hwinfo').nextProbeAt = Date.now() - 1
  await store.get({ force: true })
}
ok('changes 有上限（不无限增长）', (store.snapshot().changes || []).length <= 20,
   'len=' + (store.snapshot().changes || []).length)

console.log(fail === 0 ? '\nCHANGES PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
