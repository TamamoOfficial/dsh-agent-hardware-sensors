// ============================================================================
// liveness.js —— "谁开着读谁"的判定
// ============================================================================
// 为什么需要它：导出数据"不存在"有两种完全不同的含义 ——
//   a) 软件根本没在运行         ⇒ 正常，静默跳过，绝不提示用户
//   b) 软件在运行但没开导出选项   ⇒ 可操作，值得告诉用户去哪儿开
// 把这两种情况混成"未检测到传感器源"是本类插件最常见的误报来源。
//
// 注意：**不要**读 aida64.ini / HWiNFO 的配置文件判断状态 —— AIDA64 在内存里维护
// 设置、退出时才回写 INI，运行中的实例那份是陈旧的（本机实测印证：INI 里
// HWMonEnableSharedMem=1，但既没有活动键也没有活动映射）。
// ============================================================================

/**
 * 用 tasklist 判断某进程是否在跑。
 * tasklist 单次 ~40ms（本机实测），且不需要提权就能看到同会话进程名。
 * @param {string[]} imageNames 例如 ['AIDA64.EXE']（大小写不敏感）
 * @param {{execFileAsync?:Function}} deps 注入点
 * @returns {Promise<Record<string, boolean>>}
 */
export async function processesAlive(imageNames, deps = {}) {
  const result = {}
  for (const n of imageNames) result[n.toLowerCase()] = false
  if (imageNames.length === 0) return result
  let stdout = ''
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const { systemTool } = await import('./spawn.js')
    const run = deps.execFileAsync || promisify(execFile)
    const r = await run(systemTool('tasklist.exe'), ['/NH', '/FO', 'CSV'], {
      windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8',
    })
    stdout = typeof r === 'string' ? r : (r && r.stdout) || ''
  } catch (err) {
    // tasklist 拿不到 ⇒ 无法区分 a/b，返回全 false：上层会保守地"只报告读不到数据，
    // 不擅自给出修复建议"，避免误报"软件没开导出"。
    return { ...result, __probe_failed: true }
  }
  const lower = stdout.toLowerCase()
  for (const n of imageNames) {
    // CSV 形如 "AIDA64.EXE","1234","Console",…
    result[n.toLowerCase()] = lower.includes('"' + n.toLowerCase() + '"')
  }
  return result
}

// AIDA64 桌面版进程名（安装实测：图吧工具箱里的便携版也叫 aida64.exe）
export const AIDA64_IMAGES = ['AIDA64.EXE']
// HWiNFO：64 位主程序、32 位版、以及只开传感器窗口的 -s 模式同名
export const HWINFO_IMAGES = ['HWiNFO64.EXE', 'HWiNFO32.EXE']
