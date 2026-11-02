// 真实浏览器验证（Chrome/Edge headless + 真 DOM/真事件/真 CSS）
// 覆盖：单例、读数渲染、Shift+点击收起、面板恢复开关
//
// 浏览器路径按优先级探测，也可用环境变量 CHROME_PATH 显式指定；
// 找不到浏览器时优雅跳过（不让这个可选测试卡住整个套件）。
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

function findBrowser() {
  const explicit = process.env.CHROME_PATH || process.env.BROWSER_PATH
  const candidates = explicit ? [explicit] : []
  if (process.platform === 'win32') {
    const roots = [process.env['PROGRAMFILES'], process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]
      .filter(Boolean)
    for (const r of roots) {
      candidates.push(path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'))
      candidates.push(path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))
      candidates.push(path.join(r, 'Chromium', 'Application', 'chrome.exe'))
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    candidates.push('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge')
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge')
  }
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c } catch (e) {}
  }
  return null
}

const CHROME = findBrowser()
if (!CHROME) {
  console.log('SKIP: 未找到 Chrome/Edge/Chromium，跳过真实浏览器验证')
  console.log('      可用 CHROME_PATH 指定浏览器可执行文件路径')
  process.exit(0)
}
console.log('browser: ' + CHROME)
const widgetSrc = fs.readFileSync(new URL('../assets/widget.js', import.meta.url), 'utf8')
const harness = fs.readFileSync(new URL('./real-harness.html', import.meta.url), 'utf8')

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

function run(probeBody, opts) {
  const html = harness.replace('__WIDGET_SRC__', widgetSrc).replace('</body>', `
<script>
setTimeout(function () {
  var out
  try { out = (function () { ${probeBody} })() }
  catch (e) { out = { error: String(e && e.message) } }
  var pre = document.createElement('pre'); pre.id = 'result'
  pre.textContent = JSON.stringify(out)
  document.body.appendChild(pre)
}, ${(opts && opts.delay) || 900})
</script>
</body>`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwr-'))
  const f = path.join(dir, 'r.html')
  fs.writeFileSync(f, html, 'utf8')
  const o = execFileSync(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--virtual-time-budget=' + ((opts && opts.budget) || 4000), '--dump-dom',
    'file:///' + f.split(path.sep).join('/'),
  ], { encoding: 'utf8', timeout: 40000, maxBuffer: 64 * 1024 * 1024 })
  const m = /<pre id="result">([\s\S]*?)<\/pre>/.exec(o)
  if (!m) return { error: 'no result node', raw: o.slice(0, 200) }
  const txt = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  try { return JSON.parse(txt) } catch (e) { return { error: 'bad json', raw: txt.slice(0, 200) } }
}

// ── 1. 脚本真的执行了 ──
{
  const r = run(`return { mounted: !!window.__widgetMounted, err: window.__widgetError || null, errors: window.__errors || [] }`)
  ok('挂件脚本执行成功（无语法错误）', r.mounted === true && !r.err, JSON.stringify(r))
  ok('无 window.onerror 报错', Array.isArray(r.errors) && r.errors.length === 0, JSON.stringify(r.errors))
}

// ── 2. 单例：遗留节点被清掉，只剩一个 ──
{
  const r = run(`
    var hosts = document.querySelectorAll('[data-dshhw]')
    var btns = document.querySelectorAll('[id="dshhw-title-entry"]')
    return { hosts: hosts.length, btns: btns.length,
             cls: hosts[0] && hosts[0].className,
             kids: hosts[0] && hosts[0].children.length }`)
  ok('只剩一个挂件节点', r.hosts === 1, 'hosts=' + r.hosts)
  ok('只剩一个标题栏入口', r.btns === 1, 'btns=' + r.btns)
  ok('挂件节点有内容', r.kids > 0, 'kids=' + r.kids)
}

// ── 3. 渲染出读数（不是"暂无常用读数"） ──
{
  const r = run(`
    var host = document.querySelector('[data-dshhw]')
    var rows = host ? host.querySelectorAll('.dshhw-row') : []
    var texts = []
    for (var i = 0; i < rows.length; i++) texts.push(rows[i].textContent.replace(/\\s+/g, ' ').trim())
    var hint = host && host.querySelector('.dshhw-hint')
    return { rows: rows.length, texts: texts, hint: hint ? hint.textContent : null }`, { delay: 1200 })
  ok('渲染出读数行', r.rows > 0, 'rows=' + r.rows + ' hint=' + r.hint)
  if (r.rows > 0) {
    ok('读数含数值', r.texts.some((t) => /=?\s*\d/.test(t)), JSON.stringify(r.texts))
    console.log('     读数:', JSON.stringify(r.texts))
  }
}

// ── 4. Shift+点击小点 → 彻底收起（真实 CSS display:none） ──
{
  const r = run(`
    var host = document.querySelector('[data-dshhw]')
    var heads = host.querySelectorAll('.dshhw-h > span')
    var dot = null
    for (var i = 0; i < heads.length; i++) if (heads[i].textContent === '◦') dot = heads[i]
    if (!dot) return { error: 'dot not found', spans: Array.prototype.map.call(heads, function (s) { return s.textContent }) }
    dot.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: true }))
    return { mode: localStorage.getItem('dshhw-mode'),
             cls: host.className,
             display: getComputedStyle(host).display,
             kids: host.children.length }`, { delay: 1200 })
  ok('Shift+点击写入 dismissed', r.mode === 'dismissed', 'mode=' + r.mode)
  ok('节点带 dismissed 类', /dshhw-dismissed/.test(String(r.cls)), String(r.cls))
  ok('真实 CSS：display:none', r.display === 'none', 'display=' + r.display)
  ok('收起后无子元素', r.kids === 0, 'kids=' + r.kids)
}

// ── 5. 普通点击仍切到 mini（不受 Shift 影响） ──
{
  const r = run(`
    var host = document.querySelector('[data-dshhw]')
    var heads = host.querySelectorAll('.dshhw-h > span')
    var dot = null
    for (var i = 0; i < heads.length; i++) if (heads[i].textContent === '◦') dot = heads[i]
    if (!dot) return { error: 'dot not found' }
    dot.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey: false }))
    return { mode: localStorage.getItem('dshhw-mode'), display: getComputedStyle(host).display }`, { delay: 1200 })
  ok('普通点击切到 mini', r.mode === 'mini', 'mode=' + r.mode)
  ok('mini 档仍可见', r.display !== 'none', 'display=' + r.display)
}

// ── 6. 面板里的开关能显示回来 ──
{
  const r = run(`
    // 先设为 dismissed 再强制重渲染
    localStorage.setItem('dshhw-mode', 'dismissed')
    var host = document.querySelector('[data-dshhw]')
    // 通过标题栏入口打开面板
    var btn = document.querySelector('[id="dshhw-title-entry"]')
    if (!btn) return { error: 'no entry button' }
    btn.click()
    var chips = document.querySelectorAll('.dshhw-chip')
    var dock = null
    for (var i = 0; i < chips.length; i++) if (chips[i].textContent.indexOf('悬浮提示') >= 0) dock = chips[i]
    if (!dock) return { error: 'no dock toggle', chips: Array.prototype.map.call(chips, function (c) { return c.textContent }) }
    var before = dock.textContent
    dock.click()
    return { before: before, after: dock.textContent,
             mode: localStorage.getItem('dshhw-mode'),
             cls: host ? host.className : null,
             display: host ? getComputedStyle(host).display : null }`, { delay: 1300 })
  ok('面板有悬浮提示开关', !r.error, JSON.stringify(r).slice(0, 140))
  if (!r.error) {
    ok('开关文案随状态变化', r.before === '显示悬浮提示' && r.after === '隐藏悬浮提示',
       r.before + ' → ' + r.after)
    ok('点击后恢复 full', r.mode === 'full', 'mode=' + r.mode)
    ok('挂件重新可见', r.display !== 'none', 'display=' + r.display)
  }
}

console.log(fail === 0 ? '\nREAL BROWSER PASS' : '\n' + fail + ' FAILURES')
process.exit(fail ? 1 : 0)
