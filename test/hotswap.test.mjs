// 验证：数据源"接入/离线"是否无需重载就能被识别（决定要不要做重载提醒）
import { createStore } from '../lib/store.js'

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

// 可变的假数据源：模拟软件"先关着 → 后打开 → 又关掉"
let hwinfoOn = false
const hwRows = {
  Sensor0: 'CPU [#0]: Test CPU', Label0: 'CPU 封装', Value0: '39.0 °C', ValueRaw0: '39.0', Color0: '33cc33',
}
const readKey = async (key) => {
  if (!hwinfoOn) return { ok: false, error: 'NOT_FOUND' }
  if (!key.includes('HWiNFO64\\VSB')) return { ok: false, error: 'NOT_FOUND' }
  const values = new Map(Object.entries(hwRows).map(([k, v]) => [k, { type: 'REG_SZ', value: v, raw: v }]))
  return { ok: true, values }
}
const noShm = async () => 'DSHHW:NONE\n'
const tasklist = async () => ({ stdout: hwinfoOn ? '"HWiNFO64.EXE","1","Console","1","1 K"\r\n' : '' })

const store = createStore({ readKey, runPs: noShm, execFileAsync: tasklist })

// ① 离线：应无数据
let snap = await store.get({ force: true })
ok('离线时 hwinfo 不可用', !snap.sources.find((s) => s.source === 'hwinfo').available)
ok('离线时 live=false', snap.live === false)

// ② 软件打开后，**不重建 store、不重载插件**，只等下一次采样 ——
//    注意冷源的 nextProbeAt 是 15s 退避，这里直接把时间推过去（模拟等待）
hwinfoOn = true
const realNow = Date.now
const t0 = realNow()
const storeStates = store.states
// 把 hwinfo 的 nextProbeAt 拨到过去，等价于"已经等过了 15s 退避"
const hwState = storeStates.get('hwinfo')
hwState.nextProbeAt = t0 - 1
// 关键：进程存活探针有 10s 缓存，且 probSource 读的是 liveness.value。
// 用 force 会刷新它，确保"进程已在跑"这一事实被采样到（真实场景里等 10s 也一样）。
snap = await store.get({ force: true })
const hwNow = snap.sources.find((s) => s.source === 'hwinfo')
ok('重新采样后自动识别到 hwinfo（无需重载）', hwNow.available === true, JSON.stringify(hwNow))
ok('并且带回了读数', hwNow.count > 0, 'count=' + hwNow.count)
ok('live 变 true', snap.live === true)

// ③ 再关掉：应自动转为不可用
hwinfoOn = false
storeStates.get('hwinfo').nextProbeAt = realNow() - 1
snap = await store.get({ force: true })
const hwOff = snap.sources.find((s) => s.source === 'hwinfo')
ok('离线后自动识别为不可用（无需重载）', hwOff.available === false, JSON.stringify(hwOff))
ok('live 变回 false', snap.live === false)

console.log(fail === 0 ? '\nHOTSWAP PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
