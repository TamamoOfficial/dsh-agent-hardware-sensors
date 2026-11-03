// 端到端验证：离线提醒关掉之后，不再被弹回来。
// 用 CDP 驱动真实页面，按序投递 payload（模拟真实轮询）。
import fs from 'node:fs'
import { spawn } from 'node:child_process'
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
if (!CHROME) { console.log('SKIP: 无浏览器'); process.exit(0) }

const widgetSrc = fs.readFileSync(new URL('../assets/widget.js', import.meta.url), 'utf8')
const harness = fs.readFileSync(new URL('./real-harness.html', import.meta.url), 'utf8')

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

const driver = `
<script>
window.__queue = []
var _of = window.fetch
window.fetch = function (u) {
  if (window.__queue.length) {
    var p = window.__queue.shift()
    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(p) } })
  }
  return _of.apply(this, arguments)
}
</script>
</body>`

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwe2e-'))
const file = path.join(dir, 'e.html')
fs.writeFileSync(file, harness.replace('__WIDGET_SRC__', widgetSrc).replace('</body>', driver), 'utf8')
const url = 'file:///' + file.split(path.sep).join('/')

const port = 9800 + Math.floor(Math.random() * 150)
const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + port, '--user-data-dir=' + path.join(dir, 'p'), url], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  let page
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
      page = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) break
    } catch (e) {}
    await sleep(200)
  }
  if (!page) throw new Error('no target')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) } }
  const send = (m2, p) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method: m2, params: p || {} })) })
  const evl = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r.result && r.result.result ? r.result.result.value : undefined
  }
  await evl('new Promise(r => setTimeout(r, 1400))')

  const toastCount = () => evl(`document.querySelectorAll('.dshhw-toast').length`)
  const closeToasts = () => evl(`(function(){
    var xs = document.querySelectorAll('.dshhw-toast-x')
    for (var i = 0; i < xs.length; i++) xs[i].click()
    return document.querySelectorAll('.dshhw-toast').length })()`)

  const offline = {
    live: false,
    sources: [
      { app: 'hwinfo', available: false, transport: 'none', count: 0, reason: 'no-shared-memory' },
      { app: 'aida64', available: false, transport: 'none', count: 0, reason: 'no-shared-memory' },
    ],
    matched: 0, sensors: [],
    changes: [{ source: 'hwinfo', from: 'online', to: 'offline', count: 0, actionable: true }],
  }
  // 无事件的普通 payload：模拟"离线状态已稳定，不再有新事件"
  const quiet = Object.assign({}, offline, { changes: [] })

  // ① 第一轮：投递离线事件
  await evl(`window.__queue.push(${JSON.stringify(offline)}); 'q1'`)
  await sleep(2400)
  const t1 = await toastCount()
  ok('离线事件触发提醒', t1 >= 1, 'toasts=' + t1)

  // ② 关掉
  await closeToasts()
  await sleep(400)
  ok('关闭后提醒消失', (await toastCount()) === 0)

  // ③ 后续多轮：喂"无事件"的 payload（真实 store 已不再重发历史）
  for (let i = 0; i < 3; i++) {
    await evl(`window.__queue.push(${JSON.stringify(quiet)}); 'q'`)
    await sleep(2200)
  }
  const t3 = await toastCount()
  ok('多轮之后不再弹出（核心修复）', t3 === 0, 'toasts=' + t3)

  // ④ 防御性：即使宿主又重发了同一批历史事件（旧版行为），也不该重弹
  await evl(`window.__queue.push(${JSON.stringify(offline)}); 'q2'`)
  await sleep(2400)
  const t4 = await toastCount()
  ok('同一事件即使被重发也不重弹（指纹去重）', t4 === 0, 'toasts=' + t4)

  ws.close()
  console.log(fail === 0 ? '\nTOAST NO-RESHOW PASS' : '\n' + fail + ' FAILURES')
  process.exitCode = fail ? 1 : 0
}
main().catch((e) => { console.log('ERROR: ' + (e && e.message)); fail++ })
  .finally(() => { try { proc.kill() } catch (e) {} setTimeout(() => process.exit(fail ? 1 : 0), 300) })
