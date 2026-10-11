// Globe visual-regression capture (DATA_DECISIONS section 43).
//
//   npm run dev            (in another terminal, port 5173)
//   HEADED=1 [PALETTE=antique] [PORT=5173] [FULLSCREEN=1] [DPR=1] \
//     node scripts/globe-spin-capture.mjs <political|satellite|terrain> <tag> [wheelSteps]
//
// Loads the home page with the chosen base view, drags the globe, flicks
// it, and writes frames (static, mid-drag, inertia, settled, mid-flick,
// final) to .scratch/shots/<view>-<tag>-*.png, then prints the gesture's
// timings. HEADED=1 uses the installed Chrome with the real GPU (timings
// are meaningless under SwiftShader). Requires the playwright
// devDependency (`npx playwright install chromium` for the headless
// path).
//
// TWO numbers are printed, and round 14 (DATA_DECISIONS section 70.2) is
// why both are needed:
//
//   * MAIN-THREAD ms inside each rAF callback -- the CPU work the map
//     does per frame. This is what rounds 3, 4 and 12 drove to ~1 ms.
//   * the rAF-to-rAF INTERVAL -- a GPU proxy. When the cost is fill rate
//     (six million per-pixel inverse projections in full screen) the
//     callback stays under 2 ms while the interval stretches to 170; the
//     old number said everything was fine and the globe crawled.
//
// FULLSCREEN=1 opens the map's own full screen (the toolbar button) at a
// 1920x1080 viewport, DPR sets deviceScaleFactor (2 by default in full
// screen -- a HiDPI display is where the fill rate bites).
import fs from 'node:fs'
fs.mkdirSync('.scratch/shots', { recursive: true })
import { chromium } from 'playwright'
const view = process.argv[2] || 'satellite'
const tag = process.argv[3] || 'before'
const zoomSteps = Number(process.argv[4] || 0)
const headed = process.env.HEADED === '1'
const port = process.env.PORT || '5173'
const full = process.env.FULLSCREEN === '1'
const dsf = Number(process.env.DPR || (full ? 2 : 1))
const browser = await chromium.launch(headed ? { headless: false, channel: 'chrome' } : { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({
  viewport: full ? { width: 1920, height: 1080 } : { width: 1200, height: 900 },
  deviceScaleFactor: dsf,
})
page.on('console', (m) => { if (m.type() === 'error') console.log('console:', m.text()) })
page.on('pageerror', (e) => console.log('pageerror:', e.message))
// Optional PALETTE=<atlas|paper|antique|pastel|nautical|mono> picks the
// colour direction (round 4: it applies to every base view).
const palette = process.env.PALETTE || 'atlas'
await page.addInitScript(([v, p]) => {
  localStorage.setItem('map-base-view', v)
  localStorage.setItem('map-palette', p)
  window.__frames = []
  window.__gaps = []
  let prev = 0
  const orig = window.requestAnimationFrame.bind(window)
  window.requestAnimationFrame = (cb) => orig((t) => {
    const s = performance.now()
    if (prev) window.__gaps.push(s - prev)
    prev = s
    cb(t)
    window.__frames.push(performance.now() - s)
  })
}, [view, palette])
await page.goto(`http://localhost:${port}/`, { waitUntil: 'load' })
await page.waitForSelector('svg[role="group"]')
await page.waitForTimeout(2500)
if (full) {
  await page.getByRole('button', { name: /view full screen/i }).first().click()
  await page.waitForTimeout(2500)
}
const svg = page.locator('svg[role="group"]')
await svg.scrollIntoViewIfNeeded()
await page.waitForTimeout(400)
const box = await svg.boundingBox()
const cx = box.x + box.width / 2, cy = box.y + box.height / 2
const shot = (name) => page.screenshot({ path: `.scratch/shots/${view}-${tag}-${name}.png`, clip: box, animations: 'allow', caret: 'initial', timeout: 30000 })
for (let i = 0; i < zoomSteps; i++) { await page.mouse.move(cx, cy); await page.mouse.wheel(0, -300); await page.waitForTimeout(150) }
await page.waitForTimeout(2000)
await shot('0-static')
await page.evaluate(() => { window.__frames = []; window.__gaps = [] })
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
console.log(`${view} ${tag}${full ? ' FULLSCREEN' : ''} dpr ${dsf}: ${frames.length} rAF frames >0.5ms; main-thread median ${pct(0.5)} ms, p90 ${pct(0.9)} ms, max ${frames.at(-1)?.toFixed(1)} ms`)
// The GPU proxy: how long the browser actually took to turn each frame
// around. Only the frames during the gesture are counted; the long idle
// gaps between phases are dropped at 200 ms.
const gaps = (await page.evaluate(() => window.__gaps)).filter((g) => g > 0 && g < 200)
gaps.sort((a, b) => a - b)
const gpct = (p) => gaps[Math.floor(gaps.length * p)]?.toFixed(1)
console.log(`${view} ${tag}: ${gaps.length} frame intervals; median ${gpct(0.5)} ms, p90 ${gpct(0.9)} ms (16.7 = 60 fps)`)
const stores = await page.evaluate(() =>
  [...document.querySelectorAll('canvas')]
    .filter((c) => c.width > 400)
    .map((c) => `${c.width}x${c.height} (${((c.width * c.height) / 1e6).toFixed(2)} Mpx) display=${c.style.display || 'block'}`),
)
console.log(`${view} ${tag}: settled backing stores: ${stores.join(' | ')}`)
await browser.close()
