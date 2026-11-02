// 复现"拖动过之后点击失效"的场景
// attachDrag 里有一个 capture 阶段的 click 拦截：if (moved) { stopPropagation(); moved = false }
// 如果 moved 标志在拖动后没有被正确重置，后续点击就会被永久吞掉。
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwdr-'))
  const f = path.join(dir, 'd.html')
  fs.writeFileSync(f, html, 'utf8')
  const o = execFileSync(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=4500', '--dump-dom', 'file:///' + f.split(path.sep).join('/')],
    { encoding: 'utf8', timeout: 40000, maxBuffer: 64 * 1024 * 1024 })
  const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(o)
  if (!m) return { error: 'no result' }
  const t = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  try { return JSON.parse(t) } catch (e) { return { error: 'bad json', raw: t.slice(0, 300) } }
}

const PROBE = `
function ev(type, el, opts) {
  var r = el.getBoundingClientRect()
  var x = (opts && opts.x) !== undefined ? opts.x : r.left + r.width / 2
  var y = (opts && opts.y) !== undefined ? opts.y : r.top + r.height / 2
  var Ctor = type.indexOf('pointer') === 0 ? PointerEvent : MouseEvent
  var init = { bubbles: true, cancelable: true, clientX: x, clientY: y,
    shiftKey: !!(opts && opts.shiftKey), isPrimary: true, pointerId: 1 }
  try { return el.dispatchEvent(new Ctor(type, init)) } catch (e) { return false }
}
function findDot() {
  var host = document.querySelector('[data-dshhw]')
  var heads = host.querySelectorAll('.dshhw-h > span')
  for (var i = 0; i < heads.length; i++) if (heads[i].textContent === '◦') return { host: host, dot: heads[i] }
  return { host: host, dot: null }
}
`

// ── 场景 1：先拖动标题（超过 3px 阈值），再普通点击 ◦ ──
{
  const r = run(PROBE + `
    var f = findDot()
    if (!f.dot) return { error: 'dot not found' }
    var head = f.host.querySelector('.dshhw-h')
    // 拖动：down 在标题上，move 30px，up
    var hr = head.getBoundingClientRect()
    ev('pointerdown', head)
    ev('pointermove', head, { x: hr.left + 40, y: hr.top + 20 })
    ev('pointerup', head, { x: hr.left + 40, y: hr.top + 20 })
    // 拖动结束后立刻普通点击 ◦（期望：mini）
    ev('pointerdown', f.dot)
    ev('pointerup', f.dot)
    ev('click', f.dot)
    return { mode: localStorage.getItem('dshhw-mode'),
             movedShip: 'n/a',
             cls: f.host.className }`)
  console.log('拖动后点击:', JSON.stringify(r))
  ok('拖动后紧接着点击 ◦ 仍然生效', r.mode === 'mini', 'mode=' + r.mode)
}

// ── 场景 2：拖动后点击，但 click 由浏览器合成（不手工 dispatch click） ──
{
  const r = run(PROBE + `
    var f = findDot()
    if (!f.dot) return { error: 'dot not found' }
    var head = f.host.querySelector('.dshhw-h')
    var hr = head.getBoundingClientRect()
    ev('pointerdown', head)
    ev('pointermove', head, { x: hr.left + 40, y: hr.top + 20 })
    ev('pointerup', head, { x: hr.left + 40, y: hr.top + 20 })
    // 只发 pointer 序列，不手工发 click（真实浏览器会在 pointerup 后合成 click）
    ev('pointerdown', f.dot)
    ev('pointerup', f.dot)
    return { mode: localStorage.getItem('dshhw-mode') }`)
  console.log('拖动后 pointer-only:', JSON.stringify(r))
  // 这条只记录事实，不强制断言（浏览器合成 click 的行为依赖实现）
  console.log('     (参考：仅 pointer 序列时 mode=' + r.mode + ')')
}

// ── 场景 3：连续两次 Shift+点击 ──
{
  const r = run(PROBE + `
    var f = findDot()
    if (!f.dot) return { error: 'dot not found' }
    ev('pointerdown', f.dot, { shiftKey: true })
    ev('pointerup', f.dot, { shiftKey: true })
    ev('click', f.dot, { shiftKey: true })
    return { mode: localStorage.getItem('dshhw-mode'), display: getComputedStyle(f.host).display }`)
  ok('单次 Shift+点击 → dismissed', r.mode === 'dismissed', 'mode=' + r.mode)
}

console.log(fail === 0 ? '\nDRAG+CLICK PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
