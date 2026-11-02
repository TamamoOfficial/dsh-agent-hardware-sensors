// ============================================================================
// spawn.js —— 子进程辅助（宿主环境专用）
// ============================================================================
// 两个来自同机实测的硬约束（dsh-thermal-monitor 踩过、本机也复现）：
//   1) DSH 宿主进程**不继承交互式 PATH** —— 必须用绝对路径找 powershell.exe /
//      reg.exe / tasklist.exe，且 %SystemRoot% 在宿主 env 里未必存在，要多个候选。
//   2) `detached: true` 会让 Windows PowerShell **静默空转**：拿到 PID、spawn 报成功、
//      但什么都不做。execFile 默认不 detach，保持这一点。
// ============================================================================

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'

const run = promisify(execFile)

/** powershell.exe 候选绝对路径。 */
export function powershellCandidates(env = process.env) {
  const list = []
  if (env.SystemRoot) list.push(env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  if (env.SystemDrive) list.push(env.SystemDrive + '\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  list.push('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
  return [...new Set(list)]
}

let cachedPs = null

/** 找到第一个真实存在的 powershell.exe 绝对路径。 */
export function resolvePowerShell() {
  if (cachedPs && fs.existsSync(cachedPs)) return cachedPs
  for (const p of powershellCandidates()) {
    try { if (fs.existsSync(p)) { cachedPs = p; return p } } catch (err) {}
  }
  return null
}

/**
 * 跑一段 PowerShell（纯 ASCII 脚本），返回 stdout。
 * @param {string} script
 * @param {{timeoutMs?:number}} [opts]
 */
export async function runPowerShell(script, opts = {}) {
  const ps = resolvePowerShell()
  if (!ps) throw new Error('powershell.exe not found at any candidate path')
  const { stdout } = await run(ps,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      windowsHide: true, // 绝不 detached：见文件头注记 2
      timeout: opts.timeoutMs || 15000,
      maxBuffer: opts.maxBufferBytes || 48 * 1024 * 1024,
      encoding: 'utf8',
    })
  return stdout
}

/** reg.exe / tasklist.exe 一般直接在 System32；给出绝对路径兜底。 */
export function systemTool(name, env = process.env) {
  const roots = []
  if (env.SystemRoot) roots.push(env.SystemRoot + '\\System32\\' + name)
  roots.push('C:\\Windows\\System32\\' + name)
  for (const p of roots) { try { if (fs.existsSync(p)) return p } catch (err) {} }
  return name // 交给 PATH（宿主里通常仍能解析 System32）
}
