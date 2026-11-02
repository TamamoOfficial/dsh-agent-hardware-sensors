// ============================================================================
// hwinfo.js —— HWiNFO 传感器源（注册表 VSB + 共享内存 SM2，各自探测）
// ============================================================================
// 一手依据：本机 HWiNFO64 v8.26-5730 运行中，两个接口都开着，全部字段为实测解码值
// （见 docs/HWiNFO-sensor-format-spec.md）。与 AIDA64 的三个关键差异：
//
//   1) 注册表根键是 `HKCU|HKLM\Software\HWiNFO64\VSB`，不是 `…\Sensors`
//      （`Sensors` 是 HWiNFO 自己的设置巢：窗口几何、EnableVSB、以及反方向写入的
//        Custom 子键）。从 build 5590 起同时镜像到 HKLM。
//   2) **数据是扁平五元组**：`SensorN`(组名) / `LabelN` / `ValueN`(本地化文本) /
//      `ValueRawN`(裸数字，小数点) / `ColorN`，全是 REG_SZ，N 从 0 起。
//   3) ⚠ 注册表值**在 HWiNFO 退出后不清除**，也没有时间戳/计数器 —— 光看注册表无法
//      区分"活着"与"上次快照"。所以判活必须依赖共享内存头部的 `poll_time`，
//      或进程存活探针。"键存在"只是必要条件，不是充分条件。
//
// 共享内存 `Global\HWiNFO_SENS_SM2`（同名用于 32/64 位）：48 字节头 + 定长结构体数组。
// 签名按 **DWORD 0x53695748** 比较 —— 原始字节读出来是 "HWiS"，不是 "SiWH"，
// 拿字节串比较是这类解析器最常见的"看着对其实错"的坑。
// 免提权可读（实测：非管理员进程 FILE_MAP_READ 完整解码 26 组 + 320 条读数）。
// ============================================================================

export const HWINFO_REGISTRY_KEYS = [
  // HKLM 优先：HWiNFO 需要管理员运行；若它以另一个账户提权，写的是那个账户的 HKCU，
  // 我们（非提权宿主）的 HKCU 就是空的 —— 实测印证开发者的说明。
  'HKLM\\Software\\HWiNFO64\\VSB',
  'HKCU\\Software\\HWiNFO64\\VSB',
]
export const HWINFO_SHM_NAME = 'Global\\HWiNFO_SENS_SM2'
export const HWINFO_SIGNATURE = 0x53695748 // FOURCC "SiWH"（DWORD 比较，见文件头注记）

// tReading 枚举（实测观察到 1–8）
export const TREADING = {
  0: 'none', 1: 'temperature', 2: 'voltage', 3: 'fan', 4: 'current',
  5: 'power', 6: 'clock', 7: 'usage', 8: 'other',
}

// 单位文本 → 类别（注册表通道没有 tReading，只能从单位/标签反推）
const UNIT_HINTS = [
  [/°\s?[CF]\b|温度|temperature/i, 'temperature'],
  [/^\s*RPM\s*$|转速|fan/i, 'fan'],
  [/^V$|伏|voltage/i, 'voltage'],
  [/^A$|电流|current/i, 'current'],
  [/^W$|功率|power/i, 'power'],
  [/^MHz$|^GHz$/i, 'clock'],
  [/^%$|占用|使用率|utilization/i, 'usage'],
  [/^MB$|^GB$|^KB$|MB\/s|GB\/s/i, 'data'],
]

/** 裸数字解析：`ValueRawN` 是小数点的不变格式文本，绝不能用本地化文本 `ValueN`。 */
export function parseHwinfoRaw(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (s === '') return null
  const cleaned = s.replace(/,/g, '') // 个别版本/区域会把千分位逗号带进来
  const n = Number.parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}

function inferCategory(unit, label) {
  const probe = `${unit || ''} ${label || ''}`
  for (const [re, cat] of UNIT_HINTS) if (re.test(probe)) return cat
  return 'other'
}

// ---------------------------------------------------------------------------
// 通道 A：注册表 VSB
// ---------------------------------------------------------------------------
/**
 * @param {(key:string)=>Promise<any>} readKey
 * @param {string[]} [keys] 覆盖用（测试）
 */
export async function readHwinfoRegistry(readKey, keys = HWINFO_REGISTRY_KEYS) {
  for (const keyPath of keys) {
    const r = await readKey(keyPath)
    if (!r.ok) continue
    const slots = collectVsbSlots(r.values)
    if (slots.sensors.length === 0) {
      return { available: false, sensors: [], keyPath, reason: slots.reason || 'no-vsb-slots' }
    }
    return { available: true, sensors: slots.sensors, keyPath, transport: 'registry' }
  }
  return { available: false, sensors: [], reason: 'no-vsb-registry' }
}

/**
 * 把 `SensorN/LabelN/ValueN/ValueRawN/ColorN` 五元组按 N 归并。
 * 槽位号在用户增删上报项时会**整体位移**，所以绝不硬编码下标，只做连续扫描；
 * 遇到第一个没有任何字段的 N 就停（实测无空洞）。
 */
export function collectVsbSlots(values) {
  const sensors = []
  let maxSeen = -1
  for (let n = 0; n <= 4096; n++) {
    const g = values.get(`Sensor${n}`)
    const lb = values.get(`Label${n}`)
    const vr = values.get(`ValueRaw${n}`)
    const vd = values.get(`Value${n}`)
    const cl = values.get(`Color${n}`)
    if (!g && !lb && !vr && !vd && !cl) {
      // 连续扫描：首个完全缺失的 N 即结束
      if (n > 0 && n === maxSeen + 1) break
      continue
    }
    maxSeen = n
    const group = g ? String(g.value ?? '') : ''
    const label = lb ? String(lb.value ?? '') : ''
    const raw = vr ? String(vr.value ?? '') : ''
    const display = vd ? String(vd.value ?? '') : ''
    const unit = unitFromDisplay(display, label)
    const num = parseHwinfoRaw(raw !== '' ? raw : display)
    if (!group && !label) continue
    sensors.push({
      id: `hwinfo:vsb:${n}`,
      group,
      label,
      value: display || raw,
      num,
      unit,
      category: inferCategory(unit, label),
      color: cl ? String(cl.value ?? '') : '',
      source: 'hwinfo-registry',
      staleUnknown: true, // 注册表无时间戳：判活要靠外部探针
    })
  }
  if (sensors.length === 0) return { sensors: [], reason: 'no-vsb-slots' }
  return { sensors }
}

/** 从本地化显示文本里剥出单位（`4,803.6 MHz` → `MHz`）。 */
function unitFromDisplay(display, label) {
  const s = String(display || '').trim()
  const m = /^[-+0-9.,\s]*\s*(\S.*)$/.exec(s)
  if (m && !/^[-+0-9.,\s]+$/.test(s)) {
    const u = m[1].trim()
    if (u.length <= 8 && !/^[A-Za-z]{2,}$/.test(u) === false || u.length <= 8) return u
  }
  // 没有单位时按标签兜底（HWiNFO 的 °C 有时并进标签）
  if (/温度|temperature|°C/i.test(label || '')) return '°C'
  if (/使用率|占用|utilization/i.test(label || '')) return '%'
  if (/转速|fan|rpm/i.test(label || '')) return 'RPM'
  return ''
}

// ---------------------------------------------------------------------------
// 通道 B：共享内存 SM2
// ---------------------------------------------------------------------------
// Node 没有"打开既有命名映射"的 API ⇒ 一次 PowerShell 调用把需要的字节区间原样
// 取回（base64），解码全部在 JS 侧做 —— 编码阶梯集中一处，PS 脚本保持纯 ASCII。
//
// 脚本输出两行：
//   第 1 行  `DSHHW|ver|poll|offS|sizeS|numS|offR|sizeR|numR|acp`
//            或哨兵 `DSHHW:NONE` / `DSHHW:DENIED` / `DSHHW:BADSIG` / `DSHHW:BADSZ` /
//                  `DSHHW:ERR:<类型>`
//   第 2 行  整段 [0, offR + numR*sizeR) 的 base64
// `acp` 是 .NET Default 编码名（v1 结构的 ANSI 字段要用它解码；v2 有 UTF-8 字段就不依赖）。
// ⚠ 两个必须遵守的实测结论（都会静默把成功变成"读不到"）：
//   1) **必须显式请求 Read 访问**。.NET 的 `OpenExisting(name)` 默认按读写申请，
//      而 HWiNFO 发布的映射 DACL 只给非管理员读权限 ⇒ 不传 Read 就是 Access Denied。
//      （官方 C 样例用 FILE_MAP_READ 成功，正是同一件事。）
//   2) **PowerShell 会把 .NET 异常包成 MethodInvocationException**，直接看
//      `$_.Exception.GetType()` 永远拿不到 FileNotFoundException —— 必须走
//      InnerException 链，或用类型化 catch（PS 的类型化 catch 会看 inner）。
export const HWINFO_SHM_PS = `
$ErrorActionPreference='Stop'
$acp = 'gbk'
try { $acp = [System.Text.Encoding]::Default.WebName } catch { }
$ACC = [System.IO.MemoryMappedFiles.MemoryMappedFileAccess]::Read
$mmf = $null
try {
  $mmf = [System.IO.MemoryMappedFiles.MemoryMappedFile]::OpenExisting('Global\\HWiNFO_SENS_SM2', $ACC)
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
  $h = New-Object byte[] 48
  $a0 = $mmf.CreateViewAccessor(0, 48, $ACC)
  try { [void]$a0.ReadArray(0, $h, 0, 48) } finally { $a0.Dispose() }
  $sig = [BitConverter]::ToUInt32($h, 0)
  if ($sig -ne 0x53695748) { Write-Output 'DSHHW:BADSIG'; exit 0 }
  $ver = [BitConverter]::ToUInt32($h, 4)
  $poll = [BitConverter]::ToInt64($h, 12)
  $offS = [BitConverter]::ToUInt32($h, 20)
  $sizeS = [BitConverter]::ToUInt32($h, 24)
  $numS = [BitConverter]::ToUInt32($h, 28)
  $offR = [BitConverter]::ToUInt32($h, 32)
  $sizeR = [BitConverter]::ToUInt32($h, 36)
  $numR = [BitConverter]::ToUInt32($h, 40)
  $total = $offR + ($numR * $sizeR)
  if ($total -lt 48 -or $total -gt 33554432) { Write-Output 'DSHHW:BADSZ'; exit 0 }
  $buf = New-Object byte[] ([int]$total)
  $a1 = $mmf.CreateViewAccessor(0, [int]$total, $ACC)
  try { [void]$a1.ReadArray(0, $buf, 0, [int]$total) } finally { $a1.Dispose() }
  Write-Output ('DSHHW|' + $ver + '|' + $poll + '|' + $offS + '|' + $sizeS + '|' + $numS + '|' + $offR + '|' + $sizeR + '|' + $numR + '|' + $acp)
  [Convert]::ToBase64String($buf)
} finally { $mmf.Dispose() }
`

/** 定长字节串：取 NUL 前的内容。 */
function fixedString(buf, off, len, decoder) {
  const slice = buf.subarray(off, off + len)
  let end = slice.indexOf(0)
  if (end < 0) end = slice.length
  try { return decoder(slice.subarray(0, end)) } catch (err) { return '' }
}

function makeDecoders(acpName) {
  let ansi
  try { ansi = new TextDecoder(acpName || 'gbk', { fatal: false }) }
  catch (err) {
    try { ansi = new TextDecoder('gbk', { fatal: false }) } catch (e2) { ansi = null }
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false })
  return {
    ansi: (b) => (ansi ? ansi.decode(b) : b.toString('latin1')),
    utf8: (b) => utf8.decode(b),
  }
}

/**
 * 解码 SM2 结构体。v1(264/316) 与 v2(392/460) 的**头部字段位置相同**，
 * 元素尺寸一律取头里的 sizeSensor/sizeReading，绝不硬编码。
 * @returns {{sensors:Array, meta:object}}
 */
export function decodeHwinfoShm(meta, buf) {
  const { ver, poll, offS, sizeS, numS, offR, sizeR, numR, acp } = meta
  const d = makeDecoders(acp)
  const hasUtf8 = sizeS >= 392 // v2 才带 UTF-8 名字段
  const groups = []
  for (let i = 0; i < numS; i++) {
    const base = offS + i * sizeS
    if (base + sizeS > buf.length) break
    const id = buf.readUInt32LE(base)
    const instance = buf.readUInt32LE(base + 4)
    let name = ''
    if (hasUtf8) {
      name = fixedString(buf, base + 0x108, 128, d.utf8) || fixedString(buf, base + 0x88, 128, d.ansi)
    } else {
      name = fixedString(buf, base + 0x88, 128, d.ansi) || fixedString(buf, base + 0x08, 128, d.ansi)
    }
    groups[i] = { id, instance, name }
  }

  const sensors = []
  const readingSize = sizeR
  for (let i = 0; i < numR; i++) {
    const base = offR + i * readingSize
    if (base + readingSize > buf.length) break
    const tReading = buf.readUInt32LE(base)
    if (tReading === 0) continue // 空槽
    const sidx = buf.readUInt32LE(base + 4)
    if (!Number.isInteger(sidx) || sidx < 0 || sidx >= numS) continue // 越界：组可能在两次轮询间被移除
    const readingId = buf.readUInt32LE(base + 8)
    const category = TREADING[tReading] || 'other' // 未知码一律当 other，不报错

    // value/min/max/avg 的偏移在 v1 与 v2 **完全相同**（v2 只是在 0x13C 之后追加
    // 两个 UTF-8 缓冲：labelUserUtf8 128B + unitUtf8 16B ⇒ 316 → 460）。
    // 所以这里统一用 0x11C，不分版本。
    let label, unit
    if (readingSize >= 460) { // v2：优先 UTF-8 字段，省掉代码页猜测
      label = fixedString(buf, base + 0x13C, 128, d.utf8) || fixedString(buf, base + 0x8C, 128, d.ansi)
      unit = fixedString(buf, base + 0x1BC, 16, d.utf8) || fixedString(buf, base + 0x10C, 16, d.ansi)
    } else {
      label = fixedString(buf, base + 0x8C, 128, d.ansi) || fixedString(buf, base + 0x0C, 128, d.ansi)
      unit = fixedString(buf, base + 0x10C, 16, d.ansi)
    }
    const valueOff = base + 0x11C
    let num = null
    try { num = buf.readDoubleLE(valueOff) } catch (err) { num = null }
    if (!Number.isFinite(num)) num = null

    let min = null, max = null, avg = null
    try {
      if (valueOff + 24 <= buf.length) {
        min = buf.readDoubleLE(valueOff + 8); max = buf.readDoubleLE(valueOff + 16); avg = buf.readDoubleLE(valueOff + 24)
        if (!Number.isFinite(min)) min = null
        if (!Number.isFinite(max)) max = null
        if (!Number.isFinite(avg)) avg = null
      }
    } catch (err) { /* 截断视图：只丢统计字段 */ }

    const g = groups[sidx] || { id: 0, instance: 0, name: '' }
    sensors.push({
      id: `hwinfo:sm:${i}`,
      group: g.name,
      groupId: '0x' + (g.id >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      groupInstance: g.instance,
      readingId: '0x' + (readingId >>> 0).toString(16).toUpperCase().padStart(8, '0'),
      label,
      value: num === null ? '' : String(num),
      num,
      unit,
      category,
      min, max, avg, // 均为"自会话开始/自复位以来"，不是滚动窗口
      source: 'hwinfo-shm',
      index: i,
    })
  }
  return {
    sensors,
    meta: {
      version: ver, pollTime: poll, numGroups: numS, numReadings: numR,
      groupSize: sizeS, readingSize: sizeR, acp,
      // poll_time 是 **Unix 秒**，每次轮询 +1（实测 ~2s 节奏）。这是唯一的活动信号 ——
      // 注册表那条通道没有等价物，所以即便值来自注册表，也应尽量用这里的 poll_time 判活。
      ageSeconds: poll > 0 ? Math.max(0, Math.floor(Date.now() / 1000 - poll)) : null,
    },
  }
}

/**
 * @param {{runPs?:(script:string)=>Promise<string>}} deps
 */
export async function readHwinfoSharedMemory(deps = {}) {
  const runPs = deps.runPs || (await import('./spawn.js')).runPowerShell
  let out
  try { out = await runPs(HWINFO_SHM_PS) }
  catch (err) {
    return { available: false, sensors: [], reason: 'shm-probe-failed: ' + String((err && err.message) || err).slice(0, 140) }
  }
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0)
  const head = lines[0] || ''
  if (!head.startsWith('DSHHW|')) {
    const sentinel = head.replace('DSHHW:', '')
    if (sentinel === 'NONE') return { available: false, sensors: [], reason: 'no-shared-memory' }
    if (sentinel === 'DENIED') return { available: false, sensors: [], reason: 'shared-memory-denied',
      note: 'HWiNFO 的映射拒绝本进程读取（权限或会话隔离），只能走注册表通道' }
    return { available: false, sensors: [], reason: 'shm-' + (sentinel || 'empty').slice(0, 60) }
  }
  const p = head.split('|')
  const meta = {
    ver: Number(p[1]), poll: Number(p[2]), offS: Number(p[3]), sizeS: Number(p[4]), numS: Number(p[5]),
    offR: Number(p[6]), sizeR: Number(p[7]), numR: Number(p[8]), acp: p[9] || 'gbk',
  }
  if (!Number.isFinite(meta.numR) || meta.numR < 0) return { available: false, sensors: [], reason: 'shm-badmeta' }
  const b64 = lines[1] || ''
  let buf
  try { buf = Buffer.from(b64, 'base64') }
  catch (err) { return { available: false, sensors: [], reason: 'shm-decode-failed' } }
  if (buf.length < 48) return { available: false, sensors: [], reason: 'shm-too-small' }
  let decoded
  try { decoded = decodeHwinfoShm(meta, buf) }
  catch (err) { return { available: false, sensors: [], reason: 'shm-parse-failed: ' + String((err && err.message) || err).slice(0, 120) } }
  if (decoded.sensors.length === 0) return { available: false, sensors: [], reason: 'shm-no-readings', meta: decoded.meta }

  const age = decoded.meta.ageSeconds
  const live = age === null ? null : age <= 8 // 2s 轮询 ⇒ 允许错过 3~4 拍
  decoded.sensors.sort((a, b) => a.group.localeCompare(b.group) || a.index - b.index)
  return {
    available: live === false ? false : true,
    stale: live === false,
    sensors: decoded.sensors,
    meta: decoded.meta,
    transport: 'shared-memory',
    reason: live === false ? 'shm-stale' : undefined,
  }
}

/**
 * 汇总：两条通道各自探测。共享内存优先（有类别、有单位、有 poll_time 可判活），
 * 注册表兜底（免 spawn，但值可能是上次快照 ⇒ 必须叠加进程存活判断）。
 *
 * ⚠ 共享内存即使被判**陈旧**，只要它带回了数据就仍是最优来源（有单位/类别/poll_time）；
 *   绝不能因为"陈旧"就回退到注册表、再因为注册表也没有而整体丢弃 —— 那会把
 *   "上次快照"这个对用户仍有价值的信息误报成"什么都没有"。
 */
export async function readHwinfo(opts = {}) {
  const readKey = opts.readKey
  const shm = await readHwinfoSharedMemory(opts.deps || {})
  if (shm.available) return shm
  if (shm.sensors && shm.sensors.length) return shm // 陈旧但有数据：原样交给上层标注

  const reg = readKey ? await readHwinfoRegistry(readKey) : { available: false, sensors: [], reason: 'no-reader' }
  if (reg.available) {
    // ⚠ HWiNFO 退出后**不清注册表 VSB**（文档明示），所以"键里有值"不代表"软件在跑"。
    // 这里把"进程已死"的情况显式标为 stale —— 上层据此提示用户，而不是把上次快照
    // 当成实时读数（这正是本插件最容易静默骗人的地方）。
    const procAlive = opts.isProcessAlive === undefined ? null : opts.isProcessAlive
    return {
      ...reg,
      stale: procAlive === false ? true : undefined,
      note: procAlive === false
        ? 'HWiNFO 已退出，注册表里保留的是上一次的快照（不会自动清除）'
        : '值取自注册表 VSB，HWiNFO 退出后不会清除；判活已叠加进程存活探针',
      shmReason: shm.reason,
    }
  }
  return { available: false, sensors: [], reason: reg.reason || shm.reason, shmReason: shm.reason }
}
