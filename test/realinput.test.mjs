// 用 Chrome DevTools Protocol 发**真实输入事件**（Input.dispatchMouseEvent），
// 这是唯一能忠实复现"用户真的用鼠标点了一下"的方式：
// 浏览器会像处理物理点击一样生成 pointer 序列 + 合成 click。
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
if (!CHROME) { console.log('SKIP: 没有浏览器，跳过真实输入验证'); process.exit(0) }

const widgetSrc = fs.readFileSync(new URL('../assets/widget.js', import.meta.url), 'utf8')
const harness = fs.readFileSync(new URL('./real-harness.html', import.meta.url), 'utf8')

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

const html = harness.replace('__WIDGET_SRC__', widgetSrc)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwcdp-'))
const file = path.join(dir, 'c.html')
fs.writeFileSync(file, html, 'utf8')
const url = 'file:///' + file.split(path.sep).join('/')

// 启动带远程调试的 headless Chrome
const port = 9500 + Math.floor(Math.random() * 400)
const proc = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--remote-debugging-port=' + port,
  '--user-data-dir=' + path.join(dir, 'profile'),
  url,
], { stdio: 'ignore' })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/list')
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch (e) {}
    await sleep(200)
  }
  throw new Error('no target')
}

async function main() {
  let page
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/json/list')
      const list = await res.json()
      page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) break
    } catch (e) {}
    await sleep(200)
  }
  if (!page) throw new Error('no debug target')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
  let id = 0
  const pending = new Map()
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id) }
  }
  const send = (method, params) => new Promise((res) => {
    const myId = ++id
    pending.set(myId, res)
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }))
  })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  await evaluate('new Promise(r => setTimeout(r, 1200))')

  // 找到 ◦ 的屏幕坐标
  const pos = await evaluate(`
    (function () {
      var host = document.querySelector('[data-dshhw]')
      if (!host) return null
      var spans = host.querySelectorAll('.dshhw-h > span')
      var dot = null
      for (var i = 0; i < spans.length; i++) if (spans[i].textContent === '◦') dot = spans[i]
      if (!dot) return null
      var r = dot.getBoundingClientRect()
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
    })()`)
  if (!pos) { console.log('FAIL: 找不到 ◦ 按钮坐标'); fail++; }
  else {
    console.log('◦ 坐标:', JSON.stringify(pos))

    // 真实鼠标点击（不带 shift）
    const click = async (x, y, modifiers) => {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', modifiers: modifiers || 0 })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: modifiers || 0 })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: modifiers || 0 })
      await evaluate('new Promise(r => setTimeout(r, 260))')
    }

    // ① 普通点击 → 应切到 mini
    await click(pos.x, pos.y, 0)
    const mode1 = await evaluate("localStorage.getItem('dshhw-mode')")
    ok('真实鼠标点击 ◦ → 档位变化（不再是 null）', mode1 !== null, 'mode=' + mode1)
    ok('真实鼠标点击 → mini', mode1 === 'mini', 'mode=' + mode1)

    // ② Shift = modifier 8
    const pos2 = await evaluate(`
      (function () {
        var host = document.querySelector('[data-dshhw]')
        var spans = host.querySelectorAll('.dshhw-h > span')
        var dot = null
        for (var i = 0; i < spans.length; i++) if (spans[i].textContent === '◦') dot = spans[i]
        if (!dot) return null
        var r = dot.getBoundingClientRect()
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }
      })()`)
    if (pos2) {
      await click(pos2.x, pos2.y, 8)  // 8 = Shift
      const mode2 = await evaluate("localStorage.getItem('dshhw-mode')")
      ok('真实 Shift+点击 → dismissed', mode2 === 'dismissed', 'mode=' + mode2)
      const disp = await evaluate(`(function(){var h=document.querySelector('[data-dshhw]');return h?getComputedStyle(h).display:null})()`)
      ok('真实 Shift+点击 → display:none', disp === 'none', 'display=' + disp)
    }
  }

  ws.close()
  console.log(fail === 0 ? '\nREAL INPUT PASS' : '\n' + fail + ' FAILURES')
}

main()
  .catch((e) => { console.log('ERROR: ' + (e && e.message)); fail++ })
  .finally(() => {
    try { proc.kill() } catch (e) {}
    setTimeout(() => process.exit(fail ? 1 : 0), 300)
  })
