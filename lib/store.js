// ============================================================================
// store.js —— 传感器数据层：缓存、单飞、退避、合并、陈旧判定
// ============================================================================
// 为什么需要这一层：
//   · 每次读源都要派生一个子进程（注册表 ~25ms、共享内存 ~220ms 实测）。挂件默认
//     1s 轮询 + 工具随时调用，如果不缓存就会变成每秒数个 powershell 进程。
//   · "谁开着读谁"要求我们能**及时**发现软件被启动，又不能让没开的那个源每拍
//     都白跑一次 spawn ⇒ 未就绪的源退避到 ~15s 再探一次。
//   · HWiNFO 的注册表 VSB **退出后不清空、也没有时间戳** ⇒ 单看注册表无法判活，
//     必须叠加 poll_time 或进程存活。AIDA64 相反：它退出时整键删除 ⇒ 键在就是活的。
//     这条差异是两个源最容易写错的地方，集中在这里处理。
// ============================================================================

import { readKey } from './regfile.js'
import { readAida64, AIDA64_REGISTRY_KEY } from './aida64.js'
import { readHwinfo, HWINFO_REGISTRY_KEYS } from './hwinfo.js'
import { processesAlive, AIDA64_IMAGES, HWINFO_IMAGES } from './liveness.js'

const FRESH_MS = 1200        // 就绪源的采样下限（HWiNFO 自身 ~2s、AIDA64 1s，再快无意义）
const COLD_PROBE_MS = 15000  // 未就绪源的重探间隔：软件启动后 ≤15s 内被识别
const LIVENESS_MS = 10000    // 进程存活探针缓存
const STALE_AFTER_MS = 9000  // poll_time 超过 4~5 拍没更新 ⇒ 判陈旧

export const SOURCE_ORDER = ['hwinfo', 'aida64']

class SourceState {
  constructor(name) {
    this.name = name
    this.sensors = []
    this.transport = 'none'
    this.available = false
    this.reason = 'not-probed'
    this.note = ''
    this.meta = null
    this.stale = false
    this.updatedAt = 0
    this.nextProbeAt = 0
    this.inFlight = null
  }
}

export function createStore(deps = {}) {
  const read = deps.readKey || readKey
  const states = new Map(SOURCE_ORDER.map((n) => [n, new SourceState(n)]))
  let liveness = { at: 0, value: {}, probeFailed: false }
  let timer = null
  let listeners = new Set()
  // 源状态变化事件队列：接入 / 离线 / 转为陈旧。
  // 只在**检测到翻转**时产生一条，绝不每拍重复刷（那会变成噪音）。
  let changes = []
  let lastAvail = { aida64: null, hwinfo: null }   // null = 尚未首测，避免首次探测误报

  const now = () => Date.now()

  function snapshot() {
    const sources = []
    for (const name of SOURCE_ORDER) {
      const s = states.get(name)
      sources.push({
        source: name,
        available: s.available,
        stale: s.stale,
        transport: s.transport,
        reason: s.reason,
        note: s.note,
        count: s.sensors.length,
        updatedAt: s.updatedAt || null,
        meta: s.meta || null,
      })
    }
    detectChanges(sources)
    return {
      at: now(),
      sources,
      sensors: mergedSensors(),
      live: sources.some((s) => s.available && !s.stale),
      liveness: liveness.probeFailed ? 'unknown' : liveness.value,
      changes: changes.slice(),
    }
  }

  /**
   * 检测源状态翻转并记录一条事件。
   * 三种事件：`online`（新源接入且带数据）、`offline`（源不再有数据）、
   * `stale`（数据还在但已停止更新，例如软件退出后注册表残留）。
   * 首次探测不产生事件（`lastAvail` 为 null），否则每次页面打开都会"提醒"一次。
   */
  function detectChanges(sources) {
    for (const s of sources) {
      const prev = lastAvail[s.source]
      const cur = s.available ? (s.stale ? 'stale' : 'online') : 'offline'
      if (prev === null) { lastAvail[s.source] = cur; continue }
      if (prev === cur) continue
      lastAvail[s.source] = cur
      // offline → online / online → offline / 任意 → stale 都值得提示
      changes.push({
        at: now(),
        source: s.source,
        from: prev,
        to: cur,
        count: s.count,
        // `online` 只需要提示一次"已接入"；`offline`/`stale` 才需要用户动作
        actionable: cur !== 'online',
      })
      if (changes.length > 20) changes = changes.slice(-20)
    }
  }

  function mergedSensors() {
    const out = []
    for (const name of SOURCE_ORDER) {
      const s = states.get(name)
      if (!s.available) continue
      for (const x of s.sensors) out.push({ ...x, sourceApp: name })
    }
    return out
  }

  async function refreshLiveness(force = false) {
    if (!force && now() - liveness.at < LIVENESS_MS) return liveness.value
    const v = await processesAlive([...AIDA64_IMAGES, ...HWINFO_IMAGES], deps)
    liveness = { at: now(), value: v, probeFailed: !!v.__probe_failed }
    return v
  }

  /** 单个源的采集，含"未就绪 ⇒ 退避"的逻辑。 */
  async function probeSource(name) {
    const st = states.get(name)
    if (st.inFlight) return st.inFlight // 单飞：绝不并发同一源的 spawn
    if (!st.available && now() < st.nextProbeAt) return // 冷源退避中
    st.inFlight = (async () => {
      try {
        if (name === 'aida64') {
          const r = await readAida64({ readKey: read, deps })
          applyResult(st, r, { requireLiveness: false }) // AIDA64 键在即活（退出时整键删除）
        } else {
          // HWiNFO 的注册表 VSB 退出后不清除 ⇒ 必须把进程存活状态传下去，
          // 否则"上次快照"会被当成实时读数。
          const alive = liveness.probeFailed ? undefined : !!(liveness.value && (liveness.value['hwinfo64.exe'] || liveness.value['hwinfo32.exe']))
          const r = await readHwinfo({ readKey: read, deps, isProcessAlive: alive })
          applyResult(st, r, { requireLiveness: true })
        }
      } catch (err) {
        st.available = false
        st.stale = false
        st.sensors = []
        st.reason = 'probe-threw: ' + String((err && err.message) || err).slice(0, 160)
        st.nextProbeAt = now() + COLD_PROBE_MS
      } finally {
        st.inFlight = null
      }
    })()
    return st.inFlight
  }

  function applyResult(st, r, { requireLiveness }) {
    st.transport = r.transport || 'none'
    st.meta = r.meta || null
    st.note = r.note || ''
    st.updatedAt = now()

    // poll_time 判活（共享内存才有）
    let staleByPoll = false
    if (r.meta && typeof r.meta.ageSeconds === 'number') {
      staleByPoll = r.meta.ageSeconds * 1000 > STALE_AFTER_MS
    }

    if (r.available && !staleByPoll && !r.stale) {
      st.sensors = r.sensors || []
      st.available = st.sensors.length > 0
      st.stale = false
      st.reason = st.available ? '' : 'empty'
      st.nextProbeAt = st.available ? 0 : now() + COLD_PROBE_MS
      return
    }

    // 数据在、但已停止更新 ⇒ **保留数据并标注陈旧**，绝不能清空：
    // "上次快照"对用户仍有参考价值，只是不能再当成实时读数。
    // 触发条件有三种：poll_time 不涨（共享内存停更）、HWiNFO 进程已退出但注册表
    // 仍有残留值（VSB 退出不清除），或数据源自己标了 stale。
    if ((r.available || r.stale) && r.sensors && r.sensors.length) {
      st.sensors = r.sensors
      st.available = true
      st.stale = true
      st.reason = r.reason === 'stale-poll-time' || staleByPoll ? 'stale-poll-time' : 'source-stopped'
      st.nextProbeAt = 0
      return
    }

    // 源不可用：区分"没运行"与"运行了但没开导出"——后者值得告诉用户去哪儿开
    st.sensors = []
    st.available = false
    st.stale = false
    st.reason = r.reason || 'unavailable'
    if (r.note) st.note = r.note
    st.nextProbeAt = now() + COLD_PROBE_MS

    if (requireLiveness) {
      const alive = isHwinfoAlive()
      if (alive === true && r.transport !== 'shared-memory') {
        st.note = 'HWiNFO 在运行但没有可用数据通道：注册表上报需在传感器窗口里对具体读数右键 "Report to…" 勾选；共享内存需在 设置→传感器 里开启 "Shared Memory Support"'
      } else if (alive === false) {
        st.note = ''
      }
    } else {
      const alive = isAidaAlive()
      if (alive === true && !r.available) {
        st.note = 'AIDA64 在运行但没导出数据：首选项 → 硬件监控 → 外部应用程序 → 勾选 "Enable writing sensor values to Registry"（或共享内存），并在下方列表勾选要导出的传感器'
      } else if (alive === false) {
        st.note = ''
      }
    }
  }

  function isAidaAlive() {
    if (liveness.probeFailed) return null
    return !!liveness.value['aida64.exe']
  }
  function isHwinfoAlive() {
    if (liveness.probeFailed) return null
    return !!(liveness.value['hwinfo64.exe'] || liveness.value['hwinfo32.exe'])
  }

  /**
   * 取当前数据。
   * @param {{force?:boolean, category?:string, ids?:string[], limit?:number}} opts
   */
  async function get(opts = {}) {
    const force = !!opts.force
    await refreshLiveness(force)
    await Promise.all(SOURCE_ORDER.map((n) => {
      const st = states.get(n)
      if (force || (st.available && now() - st.updatedAt >= FRESH_MS) || (!st.available && now() >= st.nextProbeAt)) {
        return probeSource(n)
      }
      return Promise.resolve()
    }))
    const snap = snapshot()
    if (opts.category && opts.category !== 'all') {
      snap.sensors = snap.sensors.filter((s) => s.category === opts.category)
    }
    if (Array.isArray(opts.ids) && opts.ids.length) {
      const want = new Set(opts.ids.map((x) => String(x).toLowerCase()))
      snap.sensors = snap.sensors.filter((s) => want.has(String(s.id || '').toLowerCase())
        || want.has(String(s.label || '').toLowerCase()))
    }
    // ⚠ match 必须在这里消费：index.js 把它传进来，若这里不处理就会被**静默忽略**
    // —— 工具照样返回成功，模型以为过滤生效了（正是 dsh-ops 注释点名的陷阱形态）。
    if (typeof opts.match === 'string' && opts.match.trim()) {
      const terms = opts.match.toLowerCase().split(/\s+/).filter(Boolean)
      if (terms.length) {
        snap.sensors = snap.sensors.filter((s) => {
          const hay = [s.id, s.label, s.group].map((x) => String(x || '').toLowerCase()).join(' ')
          return terms.some((t) => hay.includes(t))
        })
      }
    }
    // 重要性排序：温度/占用/功率/风扇在前。320 条里内存时序排最前会让默认
    // 输出全是无用行（真机实测踩过）。
    snap.sensors = rankSensors(snap.sensors)
    snap.matchedTotal = snap.sensors.length
    if (Number.isFinite(opts.limit) && opts.limit > 0) {
      snap.sensors = snap.sensors.slice(0, Math.floor(opts.limit))
    }
    notify()
    return snap
  }

  /** 类别权重：越小越靠前。 */
  const RANK = { temperature: 0, usage: 1, power: 2, fan: 3, current: 4, voltage: 5, clock: 6, data: 7, other: 8 }
  function rankSensors(list) {
    const score = (s) => {
      let v = RANK[s.category] === undefined ? 9 : RANK[s.category]
      const hay = String(s.label || '') + ' ' + String(s.group || '')
      // 封装/整包温度最能代表"现在多少度"，排最前；每核温度次之（真机 320 条里
      // 若不加这一层，默认输出会全是 Core0..CoreN，把最有价值的一条挤到后面）。
      if (/tctl|tdie|package|封装|热点|hot ?spot/i.test(String(s.label || ''))) v -= 8
      else if (/cpu/i.test(hay)) v -= 4
      else if (/gpu/i.test(hay)) v -= 2
      return v
    }
    return list.slice().sort((a, b) => score(a) - score(b)
      || String(a.group || '').localeCompare(String(b.group || ''))
      || String(a.label || '').localeCompare(String(b.label || '')))
  }

  // ---- 后台采样：只在有人监听时跑，且间隔不低于 FRESH_MS ----
  function notify() { for (const cb of listeners) { try { cb(snapshot()) } catch (err) {} } }
  function subscribe(cb) {
    listeners.add(cb)
    ensureTimer()
    return () => {
      listeners.delete(cb)
      if (listeners.size === 0) stopTimer()
    }
  }
  function ensureTimer() {
    if (timer) return
    timer = setInterval(() => { get().catch(() => {}) }, Math.max(FRESH_MS, 1000))
    if (typeof timer.unref === 'function') timer.unref() // 不该拖住宿主退出
  }
  function stopTimer() { if (timer) { clearInterval(timer); timer = null } }

  return { get, subscribe, stopTimer, snapshot, states, SOURCE_ORDER, HWINFO_REGISTRY_KEYS, AIDA64_REGISTRY_KEY }
}
