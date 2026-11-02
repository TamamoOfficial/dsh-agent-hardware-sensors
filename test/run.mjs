// 统一测试入口：按顺序跑所有可重复执行的测试套件。
// 用法：
//   node test/run.mjs              # 全部（含真实浏览器，找不到浏览器会自动跳过）
//   node test/run.mjs --unit       # 只跑不需要浏览器的部分
//
// 说明：部分套件需要本机有 AIDA64 / HWiNFO 才能验证"真实数据"路径；
// 没有数据源时它们会自行跳过或只验证降级行为，不会误报失败。
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const onlyUnit = process.argv.includes('--unit')

// 顺序：先纯逻辑，再行为，最后真实浏览器（最慢）
const ORDER = [
  'aida64.test.mjs',
  'ps_ascii.test.mjs',
  'integration.test.mjs',
  'behaviour.test.mjs',
  'liveness.test.mjs',
  'hotswap.test.mjs',
  'changes.test.mjs',
  'widget_contract.test.mjs',
  'column_layout.test.mjs',
  'titlebar_entry.test.mjs',
  'toast.test.mjs',
  'dismiss.test.mjs',
  'viewport.test.mjs',
  'realbrowser.test.mjs',
  // 真实输入事件（CDP）：交互层唯一可信的证据，放最后
  'realinput.test.mjs',
]

const present = new Set(readdirSync(here))
const selected = ORDER
  .filter((f) => present.has(f))
  .filter((f) => !(onlyUnit && f === 'realbrowser.test.mjs'))

let failed = 0
const results = []
for (const file of selected) {
  const started = Date.now()
  let out = ''
  let ok = false
  try {
    out = execFileSync(process.execPath, [path.join(here, file)], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024,
    })
    ok = true
  } catch (err) {
    out = String((err && err.stdout) || '') + String((err && err.stderr) || '')
    ok = false
  }
  const ms = Date.now() - started
  const lastLine = out.trim().split(/\r?\n/).filter((l) => l.trim()).pop() || ''
  const skipped = /SKIP/.test(out)
  results.push({ file, ok, ms, lastLine, skipped })
  if (!ok) failed++
  const mark = ok ? (skipped ? 'skip' : 'ok  ') : 'FAIL'
  console.log(`${mark}  ${file.padEnd(24)} ${String(ms + 'ms').padStart(7)}   ${lastLine.slice(0, 60)}`)
}

console.log('')
if (failed === 0) {
  console.log(`ALL PASS (${selected.length} suites)`)
  process.exit(0)
}
console.log(`${failed} suite(s) FAILED`)
for (const r of results) if (!r.ok) console.log('  failed: ' + r.file)
process.exit(1)
