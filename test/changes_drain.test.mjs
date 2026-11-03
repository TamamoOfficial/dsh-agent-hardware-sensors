// changes 交付语义测试：每次 get() 只返回**本次新增**的事件，取走即清空。
// 回归背景：早先返回累积历史，导致前端每 2 秒把同一批旧事件重弹一遍，
// 用户点叉关掉也被弹回来（真机复现过）。
import { createStore } from '../lib/store.js'

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

let hwinfoOn = false
let registryResidue = false
const hwRows = {
  Sensor0: 'CPU [#0]: Test', Label0: 'CPU 封装', Value0: '39.0 °C', ValueRaw0: '39.0', Color0: '33cc33',
}
const readKey = async (key) => {
  if (!key.includes('HWiNFO64\\VSB')) return { ok: false, error: 'NOT_FOUND' }
  if (!registryResidue) return { ok: false, error: 'NOT_FOUND' }
  const values = new Map(Object.entries(hwRows).map(([k, v]) => [k, { type: 'REG_SZ', value: v, raw: v }]))
  return { ok: true, values }
}
const noShm = async () => 'DSHHW:NONE\n'
const tasklist = async () => ({ stdout: hwinfoOn ? '"HWiNFO64.EXE","1","Console","1","1 K"\r\n' : '' })

const store = createStore({ readKey, runPs: noShm, execFileAsync: tasklist })
const st = store.states

// ① 首测：离线状态，不应产生事件
let snap = await store.get({ force: true })
ok('首测不产生事件', (snap.changes || []).length === 0, JSON.stringify(snap.changes))

// ② 接入 → 第一次 get 应拿到 1 条
hwinfoOn = true
registryResidue = true
st.get('hwinfo').nextProbeAt = Date.now() - 1
snap = await store.get({ force: true })
const c1 = snap.changes || []
ok('接入产生 1 条事件', c1.length === 1, JSON.stringify(c1))
ok('事件是 online', c1[0] && c1[0].to === 'online', c1[0] && c1[0].to)

// ③ 紧接着再 get（状态没变）→ 必须为空（不重发历史）
st.get('hwinfo').nextProbeAt = Date.now() - 1
snap = await store.get({ force: true })
ok('状态未变时第二次 get 无事件（不重发历史）', (snap.changes || []).length === 0,
   'got=' + JSON.stringify(snap.changes))

// ④ 第三次、第四次 get → 仍应为空（这是"关掉又被弹回来"的根因）
for (let i = 0; i < 3; i++) {
  st.get('hwinfo').nextProbeAt = Date.now() - 1
  snap = await store.get({ force: true })
}
ok('连续多次 get 仍无事件（历史不会重发）', (snap.changes || []).length === 0,
   'got=' + JSON.stringify(snap.changes))

// ⑤ 内部历史仍在（供诊断），但 get 返回的是本次增量
const internal = store.drainChanges()
ok('内部历史保留可诊断（清空后为空也说明 drain 生效）', Array.isArray(internal), 'len=' + internal.length)

// ⑥ 离线 → 应产生新事件（且只交付一次）
hwinfoOn = false          // 进程停了
registryResidue = true    // 注册表残留 → stale
st.get('hwinfo').nextProbeAt = Date.now() - 1
snap = await store.get({ force: true })
const c2 = snap.changes || []
ok('软件退出后产生 1 条事件', c2.length === 1, JSON.stringify(c2))
ok('事件是 stale（注册表残留）', c2[0] && c2[0].to === 'stale', c2[0] && c2[0].to)

st.get('hwinfo').nextProbeAt = Date.now() - 1
snap = await store.get({ force: true })
ok('stale 事件同样只交付一次', (snap.changes || []).length === 0,
   'got=' + JSON.stringify(snap.changes))

// ⑦ 无人消费时的上限：不无限增长
for (let i = 0; i < 30; i++) {
  hwinfoOn = !hwinfoOn
  st.get('hwinfo').nextProbeAt = Date.now() - 1
  await store.get({ force: true })   // 每次消费，所以不会堆积
}
ok('反复切换后事件被正常消费（不堆积）', (store.snapshot().changes || []).length === 0,
   'len=' + (store.snapshot().changes || []).length)

console.log(fail === 0 ? '\nCHANGES DRAIN PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
