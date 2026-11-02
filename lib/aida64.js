// ============================================================================
// aida64.js —— AIDA64 传感器源（两条通道，各自探测，缺一条不影响另一条）
// ============================================================================
// 契约来源见插件目录 docs/aida64-sensor-export-spec.md（本机实测 + 官方文档交叉验证）：
//
//   注册表：HKCU\Software\FinalWire\AIDA64\SensorValues —— 平铺、无子键，
//           只有两种名字：`Label.<ID>` / `Value.<ID>`，**都是 REG_SZ**。
//           **没有单位字段**，类别由 ID 首字母决定；标签恒为英文（官方明确"不本地化"）。
//           AIDA64 退出时**整键删除** ⇒ "键存在" 即 "正在导出"，不需要陈旧判断。
//
//   共享内存：名字 `AIDA64_SensorValues`（裸名，无 Global\ 前缀）。内容是
//           **一段以 NUL 结尾的 XML 片段**（不是定长记录、不是完整 XML 文档）：
//             <temp><id>TCC-1-1</id><label>CPU #1 / Core #1</label><value>58</value></temp>…
//           编码随版本变：v7.65.x 及更早是 ANSI，v7.99 beta 起是 UTF-16LE。
//
// 两个坑（都不在官方文档里）：
//   · 小数点分隔符随系统区域设置 —— 注册表实测 `17,24`（逗号），共享内存 `108.56`（点）。
//     绝不能用环境 culture 直接 parseFloat。
//   · AIDA64 写入无任何同步/序号 ⇒ 先拷快照再解析，解析失败当作"可重试"而不是故障。
// ============================================================================

import { normalizeKeyPath } from './regfile.js'

export const AIDA64_REGISTRY_KEY = 'HKCU\\Software\\FinalWire\\AIDA64\\SensorValues'
export const AIDA64_SHM_NAME = 'AIDA64_SensorValues'

// ID 首字母 → 类别（注册表通道唯一的类型线索，来自官方 ID 命名规范）
const CATEGORY_BY_PREFIX = {
  S: 'system', T: 'temperature', F: 'fan', D: 'duty',
  V: 'voltage', C: 'current', P: 'power', W: 'flow', L: 'liquid',
}
// 共享内存通道的元素名 → 类别
const CATEGORY_BY_ELEMENT = {
  sys: 'system', temp: 'temperature', fan: 'fan', duty: 'duty',
  volt: 'voltage', curr: 'current', pwr: 'power', flow: 'flow', liquid: 'liquid',
}
// 类别 → 单位（AIDA64 不导出单位，这里按类别补，温度恒为摄氏度）
const UNIT_BY_CATEGORY = {
  temperature: '°C', fan: 'RPM', duty: '%', voltage: 'V',
  current: 'A', power: 'W', flow: 'L/h', liquid: '', system: '',
}

export function categoryOfId(id) {
  return CATEGORY_BY_PREFIX[String(id).charAt(0).toUpperCase()] || 'system'
}

/**
 * 解析 AIDA64 的数字文本。
 * 逗号小数点（德语/中文区实测）与点小数点都要吃下：
 * `17,24`→17.24、`1.368`→1.368、`108.56`→108.56、`28302`→28302。
 * 规则：只有当逗号/点后紧跟 1~2 位且到此结尾时才当小数点（AIDA64 的
 * 千分位不会出现这种形态），否则多组分隔符按千分位去掉。
 * @returns {{num:number|null, text:string}} 非数字值（`DDR5-6200`、`OK`）保留原文
 */
export function parseAidaNumber(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (s === '') return { num: null, text: '' }
  // 已经是点小数
  if (/^-?\d+(\.\d+)?$/.test(s)) return { num: Number.parseFloat(s), text: s }
  // 逗号小数（区域设置）
  if (/^-?\d+,\d{1,3}$/.test(s)) return { num: Number.parseFloat(s.replace(',', '.')), text: s }
  // 千分位分组：1.234.567 / 1,234,567
  if (/^-?\d{1,3}([.,]\d{3})+$/.test(s)) return { num: Number.parseFloat(s.replace(/[.,]/g, '')), text: s }
  // 混排兜底：去掉分组点后仍有单个逗号 → 当小数点
  if (/^-?\d{1,3}([.,]\d{3})*(?:[.,]\d+)?$/.test(s)) {
    const lastSepIdx = Math.max(s.lastIndexOf(','), s.lastIndexOf('.'))
    const norm = s.slice(0, lastSepIdx).replace(/[.,]/g, '') + '.' + s.slice(lastSepIdx + 1)
    const n = Number.parseFloat(norm)
    if (Number.isFinite(n)) return { num: n, text: s }
  }
  return { num: null, text: s }
}

/**
 * 解析共享内存里的 XML 片段。
 * 不引入 XML 依赖：记录形态极固定（`<cat><id>..</id><label>..</label><value>..</value></cat>`），
 * 用状态机切顶层元素，容忍未知字段与字段缺失（前向兼容）。
 * @param {string} xml 已解码、已去掉 NUL 与 BOM 的片段
 * @returns {Array<{id,label,value,num,unit,category}>}
 */
export function parseAidaXmlFragment(xml) {
  const out = []
  const text = String(xml || '')
  // 顶层元素：<name> … </name>，name 是类别标签
  const re = /<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g
  let m
  while ((m = re.exec(text)) !== null) {
    const category = CATEGORY_BY_ELEMENT[m[1].toLowerCase()] || categoryOfId(inner(m[2], 'id'))
    const id = inner(m[2], 'id')
    if (!id) continue // 无 id 的记录无法去重/寻址，丢弃
    const label = inner(m[2], 'label')
    const rawValue = inner(m[2], 'value')
    const { num, text: valueText } = parseAidaNumber(rawValue)
    out.push({
      id, label, value: valueText, num,
      unit: UNIT_BY_CATEGORY[category] === undefined ? UNIT_BY_CATEGORY.system : UNIT_BY_CATEGORY[category],
      category, source: 'aida64-shm',
    })
  }
  return out
}

function inner(body, field) {
  const m = new RegExp('<' + field + '>([\\s\\S]*?)</' + field + '>', 'i').exec(body)
  if (!m) return ''
  return decodeXmlText(m[1])
}

function decodeXmlText(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, h) => { const c = Number.parseInt(h, 16); return Number.isFinite(c) ? String.fromCodePoint(c) : '' })
    .replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

// ---------------------------------------------------------------------------
// 编码阶梯（规范 §2.5：v7.99 起 UTF-16LE，之前 ANSI；BOM 优先，再按 byte[1]==0）
// ---------------------------------------------------------------------------
/**
 * @param {Buffer} buf 原始映射视图字节
 * @returns {string} 解码后的文本（已剥 BOM、已在第一个 NUL 处截断）
 */
export function decodeAidaSharedMemory(buf) {
  if (!buf || buf.length === 0) return ''
  // 1) UTF-16LE with BOM
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return cutAtNul(new TextDecoder('utf-16le').decode(buf.slice(2)))
  }
  // 2) UTF-16BE with BOM
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return cutAtNul(new TextDecoder('utf-16be').decode(buf.slice(2)))
  }
  // 3) FinalWire 官方判据：第 2 字节为 0 ⇒ UTF-16LE 无 BOM（payload 以 '<' 0x3C 开头）
  if (buf.length >= 2 && buf[1] === 0x00 && buf[0] === 0x3c) {
    return cutAtNul(new TextDecoder('utf-16le').decode(buf))
  }
  // 4) ANSI：先试 UTF-8 严格解码，失败退回系统 ANSI 码页（中文机 = GBK）
  const raw = cutAtNulBytes(buf)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw)
  } catch (err) {
    try { return new TextDecoder('gbk', { fatal: false }).decode(raw) }
    catch (err2) { return raw.toString('latin1') }
  }
}

function cutAtNul(s) {
  const i = s.indexOf('\0')
  return i < 0 ? s : s.slice(0, i)
}
function cutAtNulBytes(buf) {
  // UTF-16 情形的 NUL 由字符串层处理；这里只截第一个 0x00（ANSI 情形的 PChar 结尾）
  const i = buf.indexOf(0)
  return i < 0 ? buf : buf.subarray(0, i)
}

// ---------------------------------------------------------------------------
// 通道 A：注册表
// ---------------------------------------------------------------------------
/**
 * @param {(key:string)=>Promise<any>} readKey regfile.js 的 readKey
 * @returns {Promise<{available:boolean, sensors:Array, reason?:string, note?:string}>}
 */
export async function readAidaRegistry(readKey) {
  const r = await readKey(AIDA64_REGISTRY_KEY)
  if (!r.ok) {
    return { available: false, sensors: [], reason: r.error === 'NOT_FOUND' ? 'no-registry-export' : r.error }
  }
  const values = r.values
  const labels = new Map()
  const readings = new Map()
  for (const [name, rec] of values) {
    if (name.startsWith('Label.')) { labels.set(name.slice(6), rec.value === null || rec.value === undefined ? '' : String(rec.value)); continue }
    if (name.startsWith('Value.')) { readings.set(name.slice(6), rec.value === null || rec.value === undefined ? '' : String(rec.value)); continue }
    // 未知前缀：静默忽略（前向兼容，可能是 FinalWire 以后加的字段）
  }
  const sensors = []
  for (const [id, rawValue] of readings) {
    const category = categoryOfId(id)
    const { num, text } = parseAidaNumber(rawValue)
    sensors.push({ id, label: labels.get(id) || '', value: text, num, unit: UNIT_BY_CATEGORY[category] ?? '', category, source: 'aida64-registry' })
  }
  if (sensors.length === 0) {
    // 键在但没有 Value.*：导出开着、传感器一个都没勾选 —— 这是可操作的配置问题
    return { available: false, sensors: [], reason: 'export-enabled-but-no-sensors-ticked',
      note: 'AIDA64 已在写注册表，但首选项里没有任何传感器被勾选（External Applications 下方的勾选列表）' }
  }
  sensors.sort((a, b) => a.id.localeCompare(b.id))
  return { available: true, sensors }
}

// ---------------------------------------------------------------------------
// 通道 B：共享内存
// ---------------------------------------------------------------------------
// Node 没有"打开已存在的命名内存映射"的 API，所以用一次 PowerShell 调用把映射内容
// 以 base64 取回来（保持原始字节，编码判断留给 JS 侧的阶梯）。
// 单次 spawn 实测 ~260ms：只用于工具调用/低频刷新，不进高频轮询。
//
// ⚠ 两个来自同机器实测的坑（dsh-thermal-monitor 的踩坑记录 + 本机复现）：
//   · 宿主进程不继承交互式 PATH —— 必须用 powershell.exe 的**绝对路径**，
//     且要多个候选位（%SystemRoot% 未必存在于宿主 env）。
//   · `detached: true` 会让 Windows PowerShell **静默空转**（拿到 PID 但什么都不做）。
//     execFile 默认不 detach，保持这个行为，任何改动都要重新验证。
// ⚠ 与 HWiNFO 通道相同的两个坑（见 hwinfo.js 的同名注记）：
//   · `OpenExisting(name)` 默认按**读写**申请 ⇒ 必须显式传 Read 访问，
//     否则非提权读者对 AIDA64 的映射会拿到 Access Denied（官方 Delphi 样例
//     用的是 FILE_MAP_READ，是同一件事）。
//   · PowerShell 会把 .NET 异常包成 MethodInvocationException，类型化 catch 未必
//     命中 ⇒ 兜底走 InnerException 链判断。
export const SHM_PS = `
$ErrorActionPreference='Stop'
$ACC = [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read
$mmf = $null
try {
  $mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('${AIDA64_SHM_NAME}', $ACC)
} catch [System.IO.FileNotFoundException] {
  Write-Output 'DSHHW:NONE'; exit 0
} catch [System.UnauthorizedAccessException] {
  Write-Output 'DSHHW:DENIED'; exit 0
} catch {
  $inner = $_.Exception
  while ($inner.InnerException) { $inner = $inner.InnerException }
  $t = $inner.GetType().Name
  if ($t -match 'FileNotFound') { Write-Output 'DSHHW:NONE' }
  elseif ($t -match 'UnauthorizedAccess|SecurityException|MarshalDirective') { Write-Output 'DSHHW:DENIED' }
  else { Write-Output ('DSHHW:ERR:' + $t) }
  exit 0
}
try {
  $len = 0
  $ac = $mmf.CreateViewAccessor(0, $len, $ACC)
  try {
    $cap = [int]$ac.Capacity
    $buf = New-Object byte[] $cap
    [void]$ac.ReadArray(0, $buf, 0, $cap)
    [Convert]::ToBase64String($buf)
  } finally { $ac.Dispose() }
} finally { $mmf.Dispose() }
`

/** powershell.exe 候选绝对路径（宿主 env 可能缺 SystemRoot，全部试一遍）。 */
export function powershellCandidates(env = process.env) {
  const list = []
  if (env.SystemRoot) list.push(env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  if (env.SystemDrive) list.push(env.SystemDrive + '\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  list.push('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  return [...new Set(list)]
}

/**
 * @param {{runPs?:(script:string)=>Promise<string>}} deps 注入点，便于测试
 */
export async function readAidaSharedMemory(deps = {}) {
  const runPs = deps.runPs || defaultRunPs
  let out
  try { out = await runPs(SHM_PS) }
  catch (err) { return { available: false, sensors: [], reason: 'shm-probe-failed: ' + String((err && err.message) || err).slice(0, 120) } }
  const trimmed = String(out || '').trim().split(/\r?\n/).filter((l) => l.trim()).pop() || ''
  if (trimmed === 'DSHHW:NONE') return { available: false, sensors: [], reason: 'no-shared-memory' }
  if (trimmed === 'DSHHW:DENIED') {
    return { available: false, sensors: [], reason: 'shared-memory-denied',
      note: 'AIDA64 以管理员身份运行，而 DSH 宿主不是 —— 这条通道需要提权才能读' }
  }
  let buf
  try { buf = Buffer.from(trimmed, 'base64') }
  catch (err) { return { available: false, sensors: [], reason: 'shm-decode-failed' } }
  const text = decodeAidaSharedMemory(buf)
  if (!text || text.indexOf('<') < 0) return { available: false, sensors: [], reason: 'shm-empty' }
  let sensors = []
  try { sensors = parseAidaXmlFragment(text) } catch (err) {
    // 撕裂读：AIDA64 无同步写入，偶发半截 XML —— 交给上层当"本次无更新"，不是故障
    return { available: false, sensors: [], reason: 'shm-torn-read', retry: true }
  }
  if (sensors.length === 0) return { available: false, sensors: [], reason: 'shm-unparsable', retry: true }
  sensors.sort((a, b) => a.id.localeCompare(b.id))
  return { available: true, sensors }
}

async function defaultRunPs(script) {
  const { runPowerShell } = await import('./spawn.js')
  return runPowerShell(script)
}

// ---------------------------------------------------------------------------
// 汇总：谁开着读哪个
// ---------------------------------------------------------------------------
/**
 * 两条通道独立探测，注册表优先（免额外进程、无编码歧义），共享内存兜底。
 * @param {{readKey:Function, deps?:object}} opts
 */
export async function readAida64(opts) {
  const reg = await readAidaRegistry(opts.readKey)
  if (reg.available) return { ...reg, transport: 'registry' }
  const shm = await readAidaSharedMemory(opts.deps || {})
  if (shm.available) return { ...shm, transport: 'shared-memory', registryNote: reg.reason }
  // 两条都没有：区分"没运行"与"运行了但没开导出"需要看进程，交给上层 liveness 探针
  return { available: false, sensors: [], transport: 'none', reason: shm.reason || reg.reason, note: reg.note || shm.note }
}

export { normalizeKeyPath }
