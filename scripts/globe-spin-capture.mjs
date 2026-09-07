// Globe visual-regression capture (DATA_DECISIONS section 43).
//
//   npm run dev            (in another terminal, port 5173)
//   HEADED=1 node scripts/globe-spin-capture.mjs <political|satellite|terrain> <tag> [wheelSteps]
//
// Loads the home page with the chosen base view, drags the globe, flicks
// it, and writes frames (static, mid-drag, inertia, settled, mid-flick,
// final) to .scratch/shots/<view>-<tag>-*.png, then prints rAF callback
// timings for the gesture. HEADED=1 uses the installed Chrome with the
// real GPU (timings are meaningless under SwiftShader). Requires the
// playwright devDependency (`npx playwright install chromium` for the
// headless path).
import fs from 'node:fs'
fs.mkdirSync('.scratch/shots', { recursive: true })
import { chromium } from 'playwright'
const view = process.argv[2] || 'satellite'
const tag = process.argv[3] || 'before'
const zoomSteps = Number(process.argv[4] || 0)
const headed = process.env.HEADED === '1'
const browser = await chromium.launch(headed ? { headless: false, channel: 'chrome' } : { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 })
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()) })
page.on('pageerror', (e) => console.log('pageerror:', e.message))
await page.addInitScript((v) => {
  localStorage.setItem('map-base-view', v)
  window.__frames = []
  const orig = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb) => orig((t) => { const s = performance.now(); cb(t); window.__frames.push(performance.now() - s) })
}, view)
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
await page.waitForSelector('svg[role="group"]')
await page.waitForTimeout(2500)
const svg = page.locator('svg[role="group"]')
const box = await svg.boundingBox()
const cx = box.x + box.width / 2, cy = box.y + box.height / 2
const shot = (name) => page.screenshot({ path: `.scratch/shots/${view}-${tag}-${name}.png`, clip: box, animations: 'allow', caret: 'initial', timeout: 30000 })
for (let i = 0; i < zoomSteps; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -300); await page.waitForTimeout(150) }
await page.waitForTimeout(2000)
await shot('0-static')
await page.evaluate(() => { window.__frames = [] })
await page.mouse.move(cx - 200, cy)
await page.mouse.down()
for (let i = 1; i <= 8; i++) {
  await page.mouse.move(cx - 200 + i * 50, cy + (i % 2) * 6, { steps: 4 })
  await page.waitForTimeout(40)
  if (i === 3 || i === 6) await shot(`drag${i}`)
}
await page.mouse.up()
await page.waitForTimeout(80)
await shot('inertia')
await page.waitForTimeout(1500)
await shot('settled')
await page.mouse.move(cx + 150, cy)
await page.mouse.down()
await page.mouse.move(cx - 250, cy + 20, { steps: 3 })
await page.mouse.up()
await page.waitForTimeout(30)
await shot('flick1')
await page.waitForTimeout(120)
await shot('flick2')
await page.waitForTimeout(2500)
await shot('final')
const frames = await page.evaluate(() => window.__frames.filter((f) => f > 0.5))
frames.sort((a, b) => a - b)
const pct = (p) => frames[Math.floor(frames.length * p)]?.toFixed(1)
console.log(`${view} ${tag}: ${frames.length} rAF frames >0.5ms; median ${pct(0.5)} ms, p90 ${pct(0.9)} ms, max ${frames.at(-1)?.toFixed(1)} ms`)
await browser.close()
