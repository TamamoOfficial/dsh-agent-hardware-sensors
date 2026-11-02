// 视口适配测试：窗口缩小/退出全屏后，挂件必须仍在可视区内。
//
// 背景（真实缺陷）：坐标按旧窗口尺寸保存，缩窗后留在屏幕外，用户完全看不到，
// 且永远不会自愈。真机复现：1920 存 (1700,900)，缩到 1200x700 后
// 超出右侧 714px、底部 301px。
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
if (!CHROME) { console.log('SKIP: 未找到浏览器，跳过视口测试'); process.exit(0) }

const widgetSrc = fs.readFileSync(new URL('../assets/widget.js', import.meta.url), 'utf8')
const harness = fs.readFileSync(new URL('./real-harness.html', import.meta.url), 'utf8')

let fail = 0
const ok = (label, cond, extra) => {
  if (cond) console.log('ok   ' + label)
  else { fail++; console.log('FAIL ' + label + (extra ? ' :: ' + extra : '')) }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hwvp2-'))
const file = path.join(dir, 'v.html')
fs.writeFileSync(file, harness.replace('__WIDGET_SRC__', widgetSrc), 'utf8')
const url = 'file:///' + file.split(path.sep).join('/')

const port = 9400 + Math.floor(Math.random() * 300)
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
    var vw = window.innerWidth, vh = window.innerHeight
    return {
      vw: vw, vh: vh,
      left: Math.round(r.left), top: Math.round(r.top),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      visible: r.left < vw && r.top < vh && r.right > 0 && r.bottom > 0,
      fullyInside: r.left >= 0 && r.top >= 0 && r.right <= vw && r.bottom <= vh,
      offX: Math.max(0, Math.round(r.right - vw), Math.round(-r.left)),
      offY: Math.max(0, Math.round(r.bottom - vh), Math.round(-r.top)),
      storedPos: localStorage.getItem('dshhw-pos')
    }
  })()`)

  await evl('new Promise(r => setTimeout(r, 1300))')

  // ── 1. 大窗口下存一个靠右下的坐标 ──
  await evl(`
    localStorage.setItem('dshhw-pos', JSON.stringify({ x: 1700, y: 900 }))
    localStorage.setItem('dshhw-mode', 'full')
    location.reload(); 'ok'`)
  await sleep(1700)
  const big = await geom()
  ok('大窗口下挂件可见', big.visible === true, JSON.stringify(big))

  // ── 2. 缩小窗口（模拟退出全屏）──
  await send('Emulation.setDeviceMetricsOverride', { width: 1200, height: 700, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
  const small = await geom()
  console.log('缩窗后:', JSON.stringify(small))
  ok('缩窗后挂件仍完全在可视区内（不再跑到屏幕外）', small.fullyInside === true, JSON.stringify(small))
  ok('缩窗后无任何越界', small.offX === 0 && small.offY === 0, 'offX=' + small.offX + ' offY=' + small.offY)
  ok('存储坐标已同步为钳制后的值（下次打开也正确）',
     String(small.storedPos).indexOf(String(small.left)) >= 0, 'stored=' + small.storedPos + ' left=' + small.left)

  // ── 3. 极小窗口（更极端）──
  await send('Emulation.setDeviceMetricsOverride', { width: 640, height: 420, deviceScaleFactor: 1, mobile: false })
  await sleep(900)
  const tiny = await geom()
  console.log('极小窗口:', JSON.stringify(tiny))
  ok('极小窗口下仍在可视区内', tiny.fullyInside === true, JSON.stringify(tiny))

  ws.close()
  console.log(fail === 0 ? '\nVIEWPORT PASS' : '\n' + fail + ' FAILURES')
  process.exitCode = fail ? 1 : 0
}

main()
  .catch((e) => { console.log('ERROR: ' + (e && e.message)); fail++ })
  .finally(() => { try { proc.kill() } catch (e) {} setTimeout(() => process.exit(fail ? 1 : 0), 300) })
