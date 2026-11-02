// 位置记忆测试：缩窗时临时收进可视区，放大后**还原到用户原来的位置**。
//
// 两份坐标模型：
//   posUser  = 用户拖到的位置（存 localStorage，永不因钳制而改变）
//   posShown = clamp(posUser, 当前视口)，仅用于渲染
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
if (!CHROME) { console.log('SKIP: 未找到浏览器'); process.exit(0) }

const widgetSrc = fs.readFileSync(new URL('../assets/widget.js', import.meta.url), 'utf8')
const harness = fs.readFileSync(new URL('./real-harness.html', import.meta.url), 'utf8')

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwmem-'))
const file = path.join(dir, 'm.html')
fs.writeFileSync(file, harness.replace('__WIDGET_SRC__', widgetSrc), 'utf8')
const url = 'file:///' + file.split(path.sep).join('/')

const port = 9600 + Math.floor(Math.random() * 300)
const proc = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox',
  '--window-size=1920,1080', '--remote-debugging-port=' + port,
  '--user-data-dir=' + path.join(dir, 'p'), url], { stdio: 'ignore' })

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
  if (!page) throw new Error('no debug target')

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
  const geom = () => evl(`(function(){
    var h = document.querySelector('[data-dshhw]')
    if (!h) return { error: 'no host' }
    var r = h.getBoundingClientRect()
    return {
      vw: window.innerWidth, vh: window.innerHeight,
      left: Math.round(r.left), top: Math.round(r.top),
      inside: r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight,
      stored: localStorage.getItem('dshhw-pos')
    }
  })()`)
  const setViewport = async (w, h) => {
    await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false })
    await sleep(700)
  }

  await evl('new Promise(r => setTimeout(r, 1300))')

  // ── 阶段 1：大窗口，用户拖到右下角（存 1700,900）──
  await evl(`
    localStorage.setItem('dshhw-pos', JSON.stringify({x:1700,y:900}))
    localStorage.setItem('dshhw-mode','full')
    location.reload(); 'ok'`)
  await sleep(1700)
  await setViewport(1904, 929)
  const p1 = await geom()
  console.log('阶段1 大窗口:', JSON.stringify(p1))
  ok('阶段1 挂件在可视区内', p1.inside === true, JSON.stringify(p1))

  // 记录此时存储的用户位置（应接近 1700,900，可能被大窗口钳制一点）
  const userPos1 = p1.stored
  ok('阶段1 存储记录用户位置', !!userPos1, userPos1)

  // ── 阶段 2：缩窗 → 应临时收进可视区，但**存储的 posUser 不变** ──
  await setViewport(1200, 700)
  const p2 = await geom()
  console.log('阶段2 缩窗后:', JSON.stringify(p2))
  ok('阶段2 缩窗后仍在可视区内', p2.inside === true, JSON.stringify(p2))
  ok('阶段2 存储的用户位置未被钳制结果覆盖（关键：要能还原）',
     p2.stored === userPos1, 'before=' + userPos1 + ' after=' + p2.stored)

  // ── 阶段 3：放大回大窗口 → 应还原到用户原来的位置 ──
  await setViewport(1904, 929)
  const p3 = await geom()
  console.log('阶段3 放大还原:', JSON.stringify(p3))
  ok('阶段3 放大后仍在可视区内', p3.inside === true, JSON.stringify(p3))
  ok('阶段3 位置已还原到大窗口下的原位置（与阶段1 一致）',
     p3.left === p1.left && p3.top === p1.top,
     'stage1=(' + p1.left + ',' + p1.top + ') stage3=(' + p3.left + ',' + p3.top + ')')

  // ── 阶段 4：反复缩放，位置应稳定（幂等） ──
  await setViewport(1200, 700)
  await setViewport(1904, 929)
  const p4 = await geom()
  ok('阶段4 反复缩放后仍还原到原位', p4.left === p1.left && p4.top === p1.top,
     '(' + p4.left + ',' + p4.top + ') vs (' + p1.left + ',' + p1.top + ')')

  ws.close()
  console.log(fail === 0 ? '\nPOSITION MEMORY PASS' : '\n' + fail + ' FAILURES')
  process.exitCode = fail ? 1 : 0
}

main()
  .catch((e) => { console.log('ERROR: ' + (e && e.message)); fail++ })
  .finally(() => { try { proc.kill() } catch (e) {} setTimeout(() => process.exit(fail ? 1 : 0), 300) })
