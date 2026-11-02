// 用**真实鼠标事件序列**（pointerdown → pointermove → pointerup → click）验证 ◦ 按钮
// 上一版测试直接 dispatch('click')，绕过了 pointer capture 的重定向行为，
// 因此可能掩盖真实用户点击失效的 bug。这里复现真实序列。
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

function findBrowser() {
  const c = []
  if (process.platform === 'win32') {
    for (const r of [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean)) {
      c.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      c.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
    }
  }
  for (const x of c) { try { if (fs.existsSync(x)) return x } catch (e) {} }
  return null
}

const CHROME = process.env.CHROME_PATH || findBrowser()
if (!CHROME) { console.log('SKIP: no browser'); process.exit(0) }

const widgetSrc = fs.readFileSync(new URL('../assets/widget.js', import.meta.url), 'utf8')
const harness = fs.readFileSync(new URL('./real-harness.html', import.meta.url), 'utf8')

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

function run(probe, delay) {
  const html = harness.replace('__WIDGET_SRC__', widgetSrc).replace('</body>', `
<script>
setTimeout(function () {
  var out
  try { out = (function () { ${probe} })() } catch (e) { out = { error: String(e && e.message) } }
  var pre = document.createElement('pre'); pre.id = 'result'
  pre.textContent = JSON.stringify(out)
  document.body.appendChild(pre)
}, ${delay || 1100})
</script>
</body>`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwseq-'))
  const f = path.join(dir, 's.html')
  fs.writeFileSync(f, html, 'utf8')
  const o = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=4000', '--dump-dom', 'file:///' + f.split(path.sep).join('/')],
    { encoding: 'utf8', timeout: 40000, maxBuffer: 64 * 1024 * 1024 })
  const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(o)
  if (!m) return { error: 'no result' }
  const t = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  try { return JSON.parse(t) } catch (e) { return { error: 'bad json', raw: t.slice(0, 300) } }
}

// 真实点击序列的辅助函数（在页面里定义）
const HELPERS = `
function findDot() {
  var host = document.querySelector('[data-dshhw]')
  var heads = host.querySelectorAll('.dshhw-h > span')
  var dot = null
  for (var i = 0; i < heads.length; i++) if (heads[i].textContent === '◦') dot = heads[i]
  return { host: host, dot: dot }
}
// 模拟真实鼠标点击：down -> up -> click（浏览器会自动生成 click，
// 但 PointerEvent 的 capture 会影响 click 的 retargeting，所以这里照真实顺序来）
function realClick(el, shiftKey) {
  var r = el.getBoundingClientRect()
  var x = r.left + r.width / 2, y = r.top + r.height / 2
  var pid = 1
  try { el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: pid, shiftKey: !!shiftKey, isPrimary: true })) } catch (e) {}
  try { el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: pid, shiftKey: !!shiftKey, isPrimary: true })) } catch (e) {}
  try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y, shiftKey: !!shiftKey })) } catch (e) {}
}
`

// ── 1. Shift+点击（真实序列）应彻底收起 ──
{
  const r = run(HELPERS + `
    var f = findDot()
    if (!f.dot) return { error: 'dot not found' }
    var before = localStorage.getItem('dshhw-mode')
    realClick(f.dot, true)
    return { before: before,
             mode: localStorage.getItem('dshhw-mode'),
             cls: f.host.className,
             display: getComputedStyle(f.host).display }`)
  console.log('Shift+真实点击:', JSON.stringify(r))
  ok('Shift+真实点击 → dismissed', r.mode === 'dismissed', 'mode=' + r.mode)
  ok('Shift+真实点击 → display:none', r.display === 'none', 'display=' + r.display)
}

// ── 2. 普通点击（真实序列）应循环档位 ──
{
  const r = run(HELPERS + `
    var f = findDot()
    if (!f.dot) return { error: 'dot not found' }
    realClick(f.dot, false)
    return { mode: localStorage.getItem('dshhw-mode'), display: getComputedStyle(f.host).display }`)
  console.log('普通真实点击:', JSON.stringify(r))
  ok('普通真实点击 → mini', r.mode === 'mini', 'mode=' + r.mode)
}

// ── 3. 直接 dispatch click 是否与真实点击结果一致（检验测试本身是否可信） ──
{
  const r = run(HELPERS + `
    var f = findDot()
    if (!f.dot) return { error: 'dot not found' }
    f.dot.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }))
    return { mode: localStorage.getItem('dshhw-mode') }`)
  ok('直接 dispatch click（旧测试方式）也得到 dismissed', r.mode === 'dismissed', 'mode=' + r.mode)
}

console.log(fail === 0 ? '\nREAL CLICK SEQUENCE PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
