// ============================================================================
// regfile.js —— `reg export` 产物的解析器（UTF-16LE .reg）
// ============================================================================
// 为什么走 `reg export` 而不是 `reg query`：
//   1) `reg query` 把值渲染成**控制台代码页**（中文机器上是 GBK），Node 侧要额外
//      猜代码页才能还原；`reg export` 的产物是 **UTF-16LE + FF FE BOM**，编码无歧义
//      —— 实测 `Label0="核心频率"` 原样还原，而 reg query 给的是乱码。
//   2) 一次进程调用拿到整棵子树，轮询成本 O(1) 次 spawn（实测 ~38ms）。
//
// 格式契约全部用本机真实导出校准（HKLM\Software\HWiNFO64\VSB、
// HKCU\Software\FinalWire\AIDA64），不是照抄文档：
//   - 首行 `Windows Registry Editor Version 5.00`
//   - 节头 `[HKEY_LOCAL_MACHINE\Software\HWiNFO64\VSB]`：**单反斜杠、不转义**
//   - REG_SZ：`"Name"="value"`，单行不折行（实测 2452 字符长值仍在一行内）；
//     值内只有 `\"` 是转义，反斜杠保持字面
//   - REG_DWORD：`"Name"=dword:0000002a`
//   - REG_BINARY：`"Name"=hex:41,00,42,00`，带类型标注时 `hex(7)`/`hex(b)`，
//     仅这一类可能折行
// ============================================================================

import { systemTool } from './spawn.js'

const VALUE_RE = /^"((?:[^"\\]|\\.)*)"\s*=\s*(.*)$/
const DEFAULT_RE = /^@=(.*)$/

/**
 * 反转义 .reg 里的**值名与字符串值**。
 * ⚠ 实测：只有 `\"` 是转义；反斜杠在字符串里**不转义**，节头同样是单反斜杠。
 *   早期我把节头也做"反斜杠转义"处理，于是 `\Software\HWiNFO64` 里每个 `\` 都被
 *   吃掉、键路径永远匹配不上 —— 这是最难查的一个 bug，因为 JSON.stringify 打印
 *   单反斜杠时显示成 `\\`，看起来反而"像是对的"。
 */
function unescapeRegText(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]
    if (c === '\\' && i + 1 < raw.length) {
      const next = raw[i + 1]
      if (next === '"' || next === '\\') { out += next; i++; continue }
      out += c
      continue
    }
    out += c
  }
  return out
}

/** 把 `hex:` 的字节串（含续行拼好的整串）解析成 Buffer。 */
function hexToBuffer(hex) {
  const bytes = []
  for (const tok of String(hex).split(',')) {
    const t = tok.trim()
    if (!t) continue
    const v = Number.parseInt(t, 16)
    if (Number.isFinite(v)) bytes.push(v & 0xff)
  }
  return Buffer.from(bytes)
}

/** `HKEY_LOCAL_MACHINE\` → `HKLM\` 等，统一别名，避免上层写死全称。 */
export function normalizeKeyPath(p) {
  return String(p)
    .replace(/^HKEY_LOCAL_MACHINE\\/i, 'HKLM\\')
    .replace(/^HKEY_CURRENT_USER\\/i, 'HKCU\\')
    .replace(/^HKEY_CLASSES_ROOT\\/i, 'HKCR\\')
    .replace(/^HKEY_USERS\\/i, 'HKU\\')
}

/**
 * 解析 `reg export` 的 .reg 文本。
 * @param {string} text 已解码为 JS 字符串的 .reg 内容（去掉 BOM）
 * @returns {Map<string, Map<string, {type:string, value:*, raw:string}>>}
 *   key 为规范化后的绝对键路径，value 为「值名 → 值」的 Map。
 */
export function parseRegExport(text) {
  const lines = String(text).split(/\r\n|\n|\r/)
  const tree = new Map()
  let current = null // { key, values }
  let pending = null // 正在拼接的 hex 续行

  const flushPending = () => {
    if (!pending) return
    const { name, subType, hex, owner } = pending
    pending = null
    if (!owner) return
    const buf = hexToBuffer(hex)
    let value
    let type = 'REG_BINARY'
    if (subType === '7') {
      type = 'REG_MULTI_SZ'
      value = buf.toString('utf16le').split('\0').filter((s) => s.length > 0)
    } else if (subType === 'b') {
      type = 'REG_QWORD'
      value = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : null
    }
    owner.values.set(name, { type, value, raw: hex })
  }

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '' || trimmed.startsWith('Windows Registry Editor')) { flushPending(); continue }

    if (trimmed.startsWith('[')) {
      flushPending()
      const end = trimmed.lastIndexOf(']')
      if (end < 0) { current = null; continue }
      // 节头**不做反转义**（实测单反斜杠）
      current = { key: normalizeKeyPath(trimmed.slice(1, end).trim()), values: new Map() }
      tree.set(current.key, current.values)
      continue
    }

    // hex 续行：既不是节头、也不是 `"name"=` / `@=` 开头的行
    if (!trimmed.startsWith('"') && !trimmed.startsWith('@=')) {
      if (pending) { pending.hex += trimmed; continue }
      continue
    }

    flushPending()
    if (!current) continue

    // (Default) 值：`@=...`
    const d = DEFAULT_RE.exec(trimmed)
    if (d) {
      current.values.set('', { type: 'REG_SZ', value: stripQuotes(d[1]), raw: d[1] })
      continue
    }

    const m = VALUE_RE.exec(trimmed)
    if (!m) continue
    const name = unescapeRegText(m[1])
    const rest = m[2].trim()

    if (rest.length >= 2 && rest.startsWith('"') && rest.endsWith('"')) {
      current.values.set(name, { type: 'REG_SZ', value: unescapeRegText(rest.slice(1, -1)), raw: rest })
      continue
    }
    const typed = /^([a-zA-Z]+)(?:\((\w*)\))?:(.*)$/.exec(rest)
    if (!typed) { current.values.set(name, { type: 'UNKNOWN', value: rest, raw: rest }); continue }
    const kind = typed[1].toLowerCase()
    const payload = typed[3]
    if (kind === 'dword') {
      current.values.set(name, { type: 'REG_DWORD', value: Number.parseInt(payload, 16) >>> 0, raw: payload })
      continue
    }
    if (kind === 'hex') {
      // 可能折行：挂起，直到遇到下一行边界
      pending = { name, subType: typed[2] || '', hex: payload, owner: current }
      continue
    }
    current.values.set(name, { type: kind.toUpperCase(), value: payload, raw: payload })
  }
  flushPending()
  return tree
}

function stripQuotes(s) {
  const t = String(s).trim()
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? unescapeRegText(t.slice(1, -1)) : t
}

/** 把 execFile 的 stderr/stdout 归一成 Buffer。 */
function toBuf(v) {
  if (Buffer.isBuffer(v)) return v
  if (typeof v === 'string') return Buffer.from(v, 'latin1')
  return Buffer.alloc(0)
}

/** 按系统 ANSI 码页解码（中文机 GBK；Node 的 TextDecoder 原生支持 gbk）。 */
function decodeAnsi(buf) {
  if (!buf || buf.length === 0) return ''
  try { return new TextDecoder('gbk', { fatal: false }).decode(buf) }
  catch (err) { return buf.toString('latin1') }
}

/**
 * 读一个键（含其所有值与其子键）。
 * @param {string} keyPath 形如 `HKCU\Software\...`
 * @param {{execFileAsync?:Function}} [deps] 测试注入点
 * @returns {Promise<{ok:boolean, values?:Map, tree?:Map, error?:string}>}
 *   键不存在时 ok:false、error 为 `NOT_FOUND` —— 这是"该软件未安装/未开启导出"的
 *   **正常**信号，调用方不得当成故障上报。
 */
export async function readKey(keyPath, deps = {}) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const os = await import('node:os')
  const fpath = await import('node:path')
  const fs = await import('node:fs/promises')
  const run = deps.execFileAsync || promisify(execFile)

  const tmp = fpath.join(os.tmpdir(), `dshhw-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.reg`)
  try {
    // 宿主进程不继承交互式 PATH ⇒ 用绝对路径（dsh-thermal-monitor 实测踩过裸
    // powershell.exe 的 ENOENT；reg.exe/tasklist.exe 同在 System32，同理）。
    await run(systemTool('reg.exe'), ['export', keyPath, tmp, '/y'], {
      windowsHide: true,
      timeout: 10000,
      maxBuffer: 32 * 1024 * 1024,
      encoding: 'buffer',
    })
    const buf = await fs.readFile(tmp)
    const body = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe ? buf.slice(2) : buf
    const tree = parseRegExport(new TextDecoder('utf-16le').decode(body))
    const values = tree.get(normalizeKeyPath(keyPath))
    if (!values) return { ok: false, error: 'NOT_FOUND' }
    return { ok: true, values, tree }
  } catch (err) {
    // ⚠ reg.exe 的诊断信息用**系统 ANSI 码页**输出（中文机 = GBK）。用 utf8 解码得到
    // 乱码，"键不存在"就匹配不上、被误报成故障 —— 本机实测踩过。
    const raw = Buffer.concat([toBuf(err && err.stderr), toBuf(err && err.stdout)])
    const msg = decodeAnsi(raw) + ' ' + String((err && err.message) || '')
    if (err && err.code === 'ENOENT') return { ok: false, error: 'REG_MISSING' }
    if (/unable to find|cannot find|not find|找不到|ERROR: 2\b/i.test(msg)) return { ok: false, error: 'NOT_FOUND' }
    return { ok: false, error: decodeAnsi(raw).slice(0, 200) || String((err && err.message) || err).slice(0, 200) }
  } finally {
    try { await fs.unlink(tmp) } catch (err) {}
  }
}
