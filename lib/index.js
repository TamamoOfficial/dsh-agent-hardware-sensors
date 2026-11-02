// ============================================================================
// dsh-agent-hardware-sensors —— Host 半边：hw_sensors 工具 + 认证路由 + 挂件注入行
// ============================================================================
// 设计约束（都来自本机实测 / 一手源码，不是猜测）：
//
// 1. **绝不要求任一软件开启。** 每个源独立探测；读不到就静默跳过，只在"软件在运行
//    但没有数据通道"时才给一条可操作的提示。两个软件都没开时，插件零输出、零报错，
//    除了一次性探测外没有任何副作用。
//
// 2. **注入行必须第一个注册。** 桌面端（Electron）的 index 注入表由宿主在**启动时
//    收集一次**并缓存，没有刷新路径 ⇒ 订阅晚于那次收集就永远不出现。所以 apply()
//    第一件事就是注册 `webserver/index-inject` 订阅（它不依赖任何服务），其余逻辑
//    再放进 root.inject([...]) 里等齐服务。（dsh-whale-widget 在桌面端踩过这个
//    #152/#153 竞态。）
//
// 3. **注入行用内联 `script`，不用 `script-src`。** 桌面渲染层对两者处理不对称：
//    `script` 是 append 不 await（不可能失败）；`script-src` 会 await，失败即 reject
//    掉 __DSH_BOOT_READY__ ⇒ **整个应用起不来**（whale issue #154）。路由注销后
//    script-src 还会 404 致命。内联行里自建 <script> 并**吞掉 onerror**：路由在就
//    加载，不在就静默失败 —— 宿主永远不会因为我们起不来。
//
// 4. **工具参数自己校验。** 走 ctx.tools.register 注册普通定义时，宿主只校验
//    output.schema，模型传来的 args 原样进 execute（dsh-ops/lib/shells/tool.js:34-41
//    点明这个陷阱：用 args?.x 读会静默吞掉未声明的键，报成功却没照做）。
//
// 5. **路由带三层信任栅栏（fail-closed）**：插件自带回环/同源校验永远先跑；宿主
//    connection.requestRejection 可用则委托它；它抛异常按拒绝处理。老宿主没这方法时
//    只靠第一层，并在加载时 warn 一次。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore } from './store.js'

export const name = 'dsh-agent-hardware-sensors'

// 有意**不**在对象级声明 inject：那会把整个 apply() 推迟到服务就绪，注入行就会错过
// 桌面端那次一次性收集（见文件头注记 2）。需要服务的部分放在 root.inject([...]) 里。
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROUTE_BASE = '/dsh-hw'
const WIDGET_PATH = ROUTE_BASE + '/widget.js'
const MAX_SENSORS_INLINE = 400
const CATEGORY_ENUM = ['temperature', 'fan', 'voltage', 'current', 'power', 'clock', 'usage', 'data', 'other', 'all']

const TOOL_PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: {
      type: 'string',
      description: '只返回某类读数。默认 all。常用 temperature（温度）/ fan（风扇 RPM）/ power（功率 W）/ usage（占用 %）/ voltage（电压 V）/ clock（频率 MHz）。',
    },
    match: {
      type: 'string',
      description: '按 id 或标签子串过滤（大小写不敏感；空格分隔的多个词命中任一即可），例如 "cpu gpu" 或 "tctl"。',
    },
    limit: { type: 'number', description: '最多返回条数，默认 200，上限 ' + MAX_SENSORS_INLINE + '。' },
    refresh: { type: 'boolean', description: 'true 强制重新采样（忽略缓存，代价是若干次子进程调用）；默认复用 ≤1.2 秒的缓存。' },
  },
}

/** 未知键 / 错类型一律拒绝 —— 绝不静默忽略模型传来的参数。 */
function assertKnownArgs(args) {
  if (args === undefined || args === null) return {}
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error('arguments must be an object')
  const allowed = Object.keys(TOOL_PARAMETERS.properties)
  for (const k of Object.keys(args)) {
    if (!allowed.includes(k)) throw new Error('unknown argument "' + k + '" (allowed: ' + allowed.join(', ') + ')')
  }
  if (args.category !== undefined && typeof args.category !== 'string') throw new Error('category must be a string')
  // 用声明过的类别表校验：拼错的 category 会得到"空结果"而不是报错，
  // 用户与模型都很难发现，所以在这里直接拒绝并给出可用值。
  if (typeof args.category === 'string' && args.category !== '' && CATEGORY_ENUM.indexOf(args.category) < 0) {
    throw new Error('unknown category "' + args.category + '" (allowed: ' + CATEGORY_ENUM.join(', ') + ')')
  }
  if (args.match !== undefined && typeof args.match !== 'string') throw new Error('match must be a string')
  if (args.limit !== undefined) {
    if (typeof args.limit !== 'number' || !Number.isFinite(args.limit)) throw new Error('limit must be a finite number')
    if (args.limit <= 0) throw new Error('limit must be a positive number')
    if (args.limit > MAX_SENSORS_INLINE) {
      throw new Error('limit must be at most ' + MAX_SENSORS_INLINE + ' (use category/match to narrow instead)')
    }
  }
  if (args.refresh !== undefined && typeof args.refresh !== 'boolean') throw new Error('refresh must be a boolean')
  return args
}

const DEFAULT_LIMIT = 200

/** 查询串里的 limit：非法/缺省回落默认值，并钳到上限（路由不因模型/页面手滑就返回全量）。 */
function clampLimit(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(n), MAX_SENSORS_INLINE)
}

/** 桌面端注入行：自建 script 标签并吞掉 onerror（见文件头注记 3）。 */
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;'
  + 'var s=document.createElement("script");s.src="' + WIDGET_PATH + '";'
  + 's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

export function apply(root) {
  const disposers = []
  root.effect(() => () => { for (const d of disposers) { try { d() } catch (err) {} } })

  // ① 注入行优先注册（不依赖任何服务）
  disposers.push(root.on('webserver/index-inject', (table) => {
    try {
      if (!Array.isArray(table)) return
      for (const row of table) {
        if (!row) continue
        if (row.kind === 'script-src' && row.src === WIDGET_PATH) return // 旧版推过 → 不重复
        if (row.kind === 'script' && typeof row.text === 'string' && row.text.indexOf(WIDGET_PATH) >= 0) return
      }
      table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
    } catch (err) {}
  }))

  // ② 需要宿主服务的部分
  root.inject(['tools', 'webServer', 'connection'], (ctx) => {
    startHost(ctx, root, disposers)
  })
}

/**
 * 装好服务依赖的全部宿主侧装配。导出以便测试注入假数据源 ——
 * 这样"两个软件都没开"这条路径可以在没有软件的环境里被真实验证。
 */
export function startHost(ctx, root, disposers, deps = {}) {
    const store = createStore(deps.storeDeps || {})

    // —— 信任栅栏（三层，fail-closed）——
    const TRUSTED = String(process.env.DSHW_TRUSTED_HOSTS || '')
      .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

    function isLoopbackHostname(hn) {
      const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
      if (!h) return false
      if (h === 'localhost' || h.endsWith('.localhost')) return true
      if (h === '::1') return true
      const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
      if (!m) return false
      if (Number(m[1]) !== 127) return false
      return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
    }

    function selfRejection(req, fenceAvailable) {
      try {
        const headers = (req && req.headers) || {}
        let hostUrl = null
        try { hostUrl = new URL('http://' + String(headers.host || '')) } catch (err) { return 403 }
        const hostname = hostUrl.hostname
        const authority = hostUrl.host
        if (!isLoopbackHostname(hostname)) {
          const listed = TRUSTED.some((e) => (e.indexOf(':') >= 0 ? e === authority.toLowerCase() : e === hostname.toLowerCase()))
          if (!listed && !fenceAvailable) return 403
        }
        // 与信任列表无关，任何情况下都执行
        const site = String(headers['sec-fetch-site'] || '').toLowerCase()
        if (site === 'cross-site') return 403
        const origin = headers.origin
        if (typeof origin === 'string' && origin && origin !== 'null') {
          let ou = null
          try { ou = new URL(origin) } catch (err) { return 403 }
          if (ou.host.toLowerCase() !== authority.toLowerCase()) return 403
        }
        return null
      } catch (err) { return 403 } // 校验器自身出错 → 拒绝
    }

    function fence() {
      try {
        const conn = ctx.get && ctx.get('connection') || ctx.connection
        return conn && typeof conn.requestRejection === 'function' ? conn : null
      } catch (err) { return null }
    }
    if (!fence()) {
      try {
        console.warn('[dsh-agent-hardware-sensors] 宿主信任栅栏不可用（connection.requestRejection 缺失）：已启用插件自带的回环/同源校验；'
          + '若 dsh 部署在非回环地址（反代/局域网），请用环境变量 DSHW_TRUSTED_HOSTS 声明允许的 Host（逗号分隔，可带端口）。')
      } catch (err) {}
    }

    let warnedFenceThrow = false
    function guard(req, res, handler) {
      const deny = (code) => { try { res.statusCode = code || 403; res.end() } catch (err) {} return true }
      const conn = fence()
      const self = selfRejection(req, !!conn)
      if (self !== null) return deny(self)
      if (!conn) return handler(req, res) // 已通过自校验，且没有宿主栅栏可委托
      let code
      try { code = conn.requestRejection(req) } catch (err) {
        // 栅栏自己抛异常 ⇒ 按拒绝处理（不是放行）
        if (!warnedFenceThrow) {
          warnedFenceThrow = true
          try { console.warn('[dsh-agent-hardware-sensors] 信任栅栏抛异常，已按拒绝处理：' + String((err && err.message) || err)) } catch (e2) {}
        }
        return deny(403)
      }
      if (code === undefined || code === null || code === false) return handler(req, res)
      return deny(typeof code === 'number' ? code : 403)
    }

    const json = (res, code, obj) => {
      const body = JSON.stringify(obj)
      try {
        res.writeHead(code, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Length': String(Buffer.byteLength(body)),
        })
        res.end(body)
      } catch (err) {}
    }

    // —— 路由 ——
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_BASE + '/sensors.json',
      handler: (req, res) => guard(req, res, async () => {
        try {
          const u = new URL(req.url, 'http://x')
          const snap = await store.get({
            category: u.searchParams.get('category') || undefined,
            match: u.searchParams.get('match') || undefined,
            limit: clampLimit(u.searchParams.get('limit')),
            refresh: u.searchParams.get('refresh') === '1',
          })
          json(res, 200, summarize(snap, MAX_SENSORS_INLINE))
        } catch (err) {
          json(res, 500, { error: String((err && err.message) || err).slice(0, 200) })
        }
      }),
    }))

    const widgetFile = path.join(HERE, '..', 'assets', 'widget.js')
    disposers.push(ctx.webServer.register({
      kind: 'exact',
      path: WIDGET_PATH,
      handler: (req, res) => guard(req, res, () => {
        // 注意：挂件脚本本身走同源校验即可（内容不含凭据）
        let src = ''
        try { src = fs.readFileSync(widgetFile, 'utf8') } catch (err) {
          try { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('widget unavailable') } catch (e2) {}
          return
        }
        try {
          res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-store',
            'Content-Length': String(Buffer.byteLength(src)),
          })
          res.end(src)
        } catch (err) {}
      }),
    }))

    // —— 工具 ——
    disposers.push(ctx.tools.register({
      name: 'hw_sensors',
      description: '读取本机硬件传感器读数（CPU/GPU 温度、风扇转速、功耗、电压、频率、内存占用）。'
        + '数据源是本机正在运行并开启了导出的 AIDA64 或 HWiNFO —— 两者都可选、都不要求：'
        + '谁开着读谁，都没开时返回 available=false 与一句说明，不报错。'
        + '先不带参数调用一次看 sources，再用 category/match 缩小范围。',
      parameters: TOOL_PARAMETERS,
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: String(value) }],
      },
      async execute(args) {
        const a = assertKnownArgs(args)
        const snap = await store.get({
          category: a.category,
          match: a.match,
          limit: a.limit === undefined ? DEFAULT_LIMIT : a.limit,
          refresh: !!a.refresh,
        })
        return JSON.stringify(summarize(snap, MAX_SENSORS_INLINE), null, 1)
      },
    }))

    // 预热一次，让首次工具调用/挂件首帧不必等冷启动
    store.get().catch(() => {})
    return { store }
}

/** 精简输出：默认只给关键读数 + 源状态，避免几百条灌满上下文。 */
function summarize(snap, cap) {
  const sources = snap.sources.map((s) => ({
    app: s.source,
    available: s.available,
    stale: !!s.stale,
    transport: s.transport,
    count: s.count,
    reason: s.available ? undefined : (s.reason || 'unavailable'),
    note: s.note || undefined,
    pollAgeSeconds: s.meta && typeof s.meta.ageSeconds === 'number' ? s.meta.ageSeconds : undefined,
  }))
  const all = snap.sensors || []
  // matched 是**过滤后、截断前**的条数：store 已经按 limit 截过，所以必须用
  // matchedTotal，否则会报出"只匹配了 6 条"这种假数（真机实测踩过）。
  const total = Number.isFinite(snap.matchedTotal) ? snap.matchedTotal : all.length
  const out = {
    live: !!snap.live,
    sources,
    matched: total,
    sensors: all.slice(0, cap).map((s) => ({
      app: s.sourceApp || s.source,
      id: s.id,
      group: s.group || undefined,
      label: s.label,
      value: s.num === null || s.num === undefined ? (s.value || null) : round(s.num),
      unit: s.unit || undefined,
      category: s.category,
      max: s.max === undefined || s.max === null ? undefined : round(s.max),
    })),
  }
  // 数据源变化事件（接入 / 离线 / 停止更新）：挂件据此弹提醒。
  // 只在**翻转**时出现，不是每拍都有，所以不会刷屏。
  if (Array.isArray(snap.changes) && snap.changes.length) {
    out.changes = snap.changes.map((c) => ({
      source: c.source, from: c.from, to: c.to, count: c.count, actionable: !!c.actionable,
    }))
  }
  if (total > out.sensors.length) out.truncated = total - out.sensors.length
  if (!snap.live && !out.sources.some((s) => s.note)) {
    out.hint = '本机没有可读的传感器导出：启动 AIDA64 或 HWiNFO 并在其设置里开启导出（注册表或共享内存）即可，无需其它配置。'
  }
  return out
}

function round(n) {
  if (!Number.isFinite(n)) return null
  return Math.round(n * 1000) / 1000
}
