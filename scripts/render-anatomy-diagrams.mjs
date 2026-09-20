// Render the static anatomy diagrams FROM THE 3-D MODELS (round 13,
// DATA_DECISIONS.md §66 draft in .scratch/decisions-r13-anatomy.md).
//
// The Diagrams tab of /anatomy stacks one image per layer per sex, so the
// layers must register pixel for pixel. Building them from the models with
// ONE fixed orthographic camera per sex guarantees that by construction:
// every layer of a sex is framed by the same body box, drawn with the same
// materials as the 3-D viewer, and written as a transparent image. An ID
// pass (every structure a unique flat colour) gives each structure its
// visible-pixel count and centroid, which the tab uses as label anchors,
// so a label only ever points at a pixel where the structure is really
// visible from that side.
//
// Outputs (committed artifacts, gated by scripts/check-anatomy.mjs):
//   data/anatomy/diagrams/<sex>-<layer>-<front|back>.webp
//   data/anatomy/diagrams/diagrams.json      camera, image list, anchors,
//                                            sha256/bytes per image and the
//                                            sha256 of every model file used
//
// How it renders: a tiny static server serves node_modules/three and the
// model files to a Playwright Chromium page (headless by default; HEADED=1
// shows it), the page loads a layer with three's GLTFLoader + meshopt
// decoder, renders it twice (beauty, ID) and posts the PNG and the anchor
// table back. The same page serves the "--shot" diagnostic mode used to
// verify close-ups (feet, hands, face) of any GLB set from any camera.
//
//   node scripts/render-anatomy-diagrams.mjs                 build everything
//   node scripts/render-anatomy-diagrams.mjs --sex female    one sex
//   node scripts/render-anatomy-diagrams.mjs --shot out.png --files a.glb,b.glb
//        [--view front|back|left|right|top|custom] [--dir x,y,z] [--target x,y,z]
//        [--height metres] [--px 1200] [--persp fovDeg]
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'
import sharp from 'sharp'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MODELS = join(ROOT, 'data', 'anatomy', 'models')
const OUT = join(ROOT, 'data', 'anatomy', 'diagrams')
const HEIGHT_PX = 1600
const VIEWS = ['front', 'back']
const LAYERS = ['skeleton', 'nervous', 'organs', 'vessels', 'muscles', 'skin']
const IMAGE_BUDGET = 700_000 // bytes per image
const SEX_BUDGET = 5_000_000 // bytes per sex, all layers and views

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : fallback
}

// --------------------------------------------------------------------------
// Static server: /three/... -> node_modules/three, /models/... -> data/anatomy/models,
// /file/<absolute path> for diagnostics, /page -> the render page.
// --------------------------------------------------------------------------
const MIME = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.glb': 'model/gltf-binary', '.json': 'application/json', '.html': 'text/html' }
function serve() {
  return new Promise((done) => {
    const server = createServer((req, res) => {
      const url = decodeURIComponent(req.url.split('?')[0])
      let path = null
      if (url === '/page') {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end(PAGE)
        return
      }
      if (url.startsWith('/three/')) path = join(ROOT, 'node_modules', 'three', url.slice(7))
      else if (url.startsWith('/models/')) path = join(MODELS, url.slice(8))
      else if (url.startsWith('/file/')) path = url.slice(6).replace(/^([A-Za-z]):?\//, '$1:/')
      if (!path || !existsSync(path)) {
        res.writeHead(404)
        res.end('not found: ' + url)
        return
      }
      res.writeHead(200, { 'content-type': MIME[extname(path)] ?? 'application/octet-stream' })
      res.end(readFileSync(path))
    })
    server.listen(0, '127.0.0.1', () => done({ server, port: server.address().port }))
  })
}

// The colour scheme is the viewer's (src/components/anatomy/BodyViewer.tsx
// COLOURS/colourFor), copied so the diagrams and the 3-D body match.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>anatomy diagram renderer</title>
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<style>html,body{margin:0;background:transparent}canvas{display:block}</style></head><body>
<script type="module">
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'

const COLOURS = { bone: 0xe6dcc8, cartilage: 0xcfd8d4, ligament: 0xd9c9a8, nerve: 0xe7c85a, brain: 0xd8b6b0, eye: 0xe9ecef,
  muscle: 0xa64b3f, tendon: 0xe0d6c2, fascia: 0xd7cdb8, skin: 0xd6a98a, skinFemale: 0xd9ad90, artery: 0xc23b2f, vein: 0x3f5fa8,
  heart: 0xa8302a, lymph: 0x6fae7a, digestive: 0xc9906a, respiratory: 0xe3a3a8, urinary: 0xcaa24a, reproductive: 0xcf8fb5,
  endocrine: 0xb28ad4, liver: 0x8f4a3f, hair: 0x4a3626, other: 0xb9a89a }
function colourFor(s) {
  if (!s) return COLOURS.other
  const name = s.name.toLowerCase(); const organ = s.organ ?? ''
  switch (s.layer) {
    case 'skeleton':
      if (/cartilage|disc|pulposus|menisc|labrum/.test(name)) return COLOURS.cartilage
      if (/ligament|capsule|membrane|symphysis/.test(name)) return COLOURS.ligament
      return COLOURS.bone
    case 'nervous':
      if (organ === 'eye' || /\\beye|retina|cornea|lens|sclera|vitreous|iris|conjunctiva/.test(name)) return COLOURS.eye
      if (/^(brain|cerebrum|cerebellum|brainstem|hypothalamus|pineal|pituitary|spinal-cord)$/.test(organ)) return COLOURS.brain
      if (/muscle|rectus|oblique/.test(name)) return COLOURS.muscle
      if (/artery|vein/.test(name)) return /vein/.test(name) ? COLOURS.vein : COLOURS.artery
      return COLOURS.nerve
    case 'vessels':
      if (organ === 'heart') return COLOURS.heart
      if (s.system === 'lymphatic' || /lymph|node|spleen|thymus|tonsil/.test(name)) return COLOURS.lymph
      if (/vein|vena|venous|sinus|azygos|portal/.test(name)) return COLOURS.vein
      return COLOURS.artery
    case 'muscles':
      if (/tendon|aponeurosis|retinaculum/.test(name)) return COLOURS.tendon
      if (/fascia|bursa|sheath|septum/.test(name)) return COLOURS.fascia
      return COLOURS.muscle
    case 'skin':
      if (/hairs? of head|eyebrow|pubic hair|eyelash/.test(name)) return COLOURS.hair
      return COLOURS.skin
    default:
      if (organ === 'liver' || organ === 'gallbladder') return COLOURS.liver
      switch (s.system) {
        case 'respiratory': return COLOURS.respiratory
        case 'urinary': return COLOURS.urinary
        case 'reproductive': return COLOURS.reproductive
        case 'endocrine': return COLOURS.endocrine
        case 'lymphatic': return COLOURS.lymph
        case 'digestive': return COLOURS.digestive
        case 'integumentary': return COLOURS.skinFemale
        case 'muscular': return COLOURS.muscle
        default: return COLOURS.other
      }
  }
}

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' })
renderer.setPixelRatio(1)
renderer.outputColorSpace = THREE.SRGBColorSpace
document.body.appendChild(renderer.domElement)
const loader = new GLTFLoader()
loader.setMeshoptDecoder(MeshoptDecoder)
const draco = new DRACOLoader(); draco.setDecoderPath('/three/examples/jsm/libs/draco/'); loader.setDRACOLoader(draco)

const cache = new Map()
async function loadFile(url) {
  if (!cache.has(url)) cache.set(url, loader.loadAsync(url))
  const gltf = await cache.get(url)
  return gltf.scene.clone(true)
}

function frameOrtho(box, view, aspect, pad) {
  const size = new THREE.Vector3(); box.getSize(size)
  const centre = new THREE.Vector3(); box.getCenter(centre)
  const h = size.y * (1 + pad)
  const w = h * aspect
  const cam = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.01, 100)
  const d = size.length()
  const dir = { front: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0], top: [0, 1, 0.0001] }[view]
  cam.position.set(centre.x + dir[0] * d, centre.y + dir[1] * d, centre.z + dir[2] * d)
  cam.up.set(0, 1, 0)
  cam.lookAt(centre)
  cam.updateProjectionMatrix()
  cam.updateMatrixWorld(true)
  return cam
}

function lights(cam) {
  const g = new THREE.Group()
  g.add(new THREE.HemisphereLight(0xffffff, 0x8a8078, 1.6))
  const key = new THREE.DirectionalLight(0xffffff, 2.1); key.position.set(2, 3, 4); g.add(key)
  const fill = new THREE.DirectionalLight(0xdfe8ff, 0.8); fill.position.set(-3, 1, -2); g.add(fill)
  cam.add(g)
  return g
}

// spec: { files: [{url, structures: {node -> structure}}], frame: {box|null, view, aspect, pad, heightPx}
//        or camera: {type:'persp', fov, position, target, widthPx, heightPx}, ids: bool, background: null|'#fff' }
window.renderSpec = async function (spec) {
  const scene = new THREE.Scene()
  const meshes = []
  const boxAll = new THREE.Box3()
  for (const f of spec.files) {
    const root = await loadFile(f.url)
    root.updateMatrixWorld(true)
    root.traverse((o) => {
      if (!o.isMesh) return
      const node = o.userData.name ?? o.name
      const s = f.structures?.[node] ?? null
      o.userData.node = node
      o.userData.structure = s
      if (!o.geometry.getAttribute('normal')) o.geometry.computeVertexNormals()
      o.geometry.computeBoundingBox()
      const wb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld)
      o.userData.box = wb
      boxAll.union(wb)
      meshes.push(o)
    })
    scene.add(root)
  }
  const frame = spec.frame
  let cam, W, H
  if (spec.camera) {
    const c = spec.camera
    W = c.widthPx; H = c.heightPx
    cam = new THREE.PerspectiveCamera(c.fov, W / H, 0.005, 100)
    cam.position.set(...c.position); cam.up.set(0, 1, 0); cam.lookAt(new THREE.Vector3(...c.target)); cam.updateMatrixWorld(true)
  } else {
    const box = frame.box ? new THREE.Box3(new THREE.Vector3(...frame.box.min), new THREE.Vector3(...frame.box.max)) : boxAll
    H = frame.heightPx
    const size = new THREE.Vector3(); box.getSize(size)
    const extentX = frame.view === 'left' || frame.view === 'right' ? size.z : size.x
    W = Math.round((H * extentX * (1 + frame.pad)) / (size.y * (1 + frame.pad)))
    if (frame.widthPx) W = frame.widthPx
    cam = frameOrtho(box, frame.view, W / H, frame.pad)
  }
  scene.add(cam)
  const lg = lights(cam)
  renderer.setSize(W, H, false)
  renderer.setClearColor(0x000000, 0)
  // Beauty pass
  const beauty = new Map()
  const SHEET = /fascia|bursa|sheath|septum|aponeurosis|retinaculum|iliotibial tract|membrane/
  for (const m of meshes) {
    const s = m.userData.structure
    const colour = colourFor(s)
    const sheet = s && ((s.layer === 'muscles' && SHEET.test(s.name.toLowerCase())) || (s.layer === 'skeleton' && /membrane/.test(s.name.toLowerCase())))
    const key = colour * 2 + (sheet ? 1 : 0)
    let mat = beauty.get(key)
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.72, metalness: 0, transparent: sheet, opacity: sheet ? 0.35 : 1, depthWrite: !sheet })
      beauty.set(key, mat)
    }
    m.material = mat
    m.userData.sheet = sheet
  }
  if (spec.background) { scene.background = new THREE.Color(spec.background) }
  renderer.render(scene, cam)
  const png = renderer.domElement.toDataURL('image/png')
  let anchors = null
  if (spec.ids) {
    // ID pass: every mesh a unique flat colour, read back and tallied.
    const ids = new Map()
    meshes.forEach((m, i) => {
      const id = i + 1
      const mat = new THREE.MeshBasicMaterial()
      // A translucent sheet must not hide the muscle beneath it in the ID
      // pass: it neither writes depth nor is drawn after the opaque meshes.
      if (m.userData.sheet) { mat.depthWrite = false; m.renderOrder = -1 }
      mat.color.setRGB(((id >> 16) & 255) / 255, ((id >> 8) & 255) / 255, (id & 255) / 255, THREE.NoColorSpace)
      m.material = mat
      ids.set(id, m)
    })
    scene.background = null
    const target = new THREE.WebGLRenderTarget(W, H, { samples: 0, depthBuffer: true })
    const prevTone = renderer.toneMapping
    renderer.toneMapping = THREE.NoToneMapping
    renderer.setRenderTarget(target)
    renderer.setClearColor(0x000000, 0)
    renderer.clear()
    renderer.render(scene, cam)
    const px = new Uint8Array(W * H * 4)
    renderer.readRenderTargetPixels(target, 0, 0, W, H, px)
    renderer.setRenderTarget(null)
    renderer.toneMapping = prevTone
    target.dispose()
    const tally = new Map()
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4
        if (px[o + 3] === 0) continue
        const id = (px[o] << 16) | (px[o + 1] << 8) | px[o + 2]
        if (!id) continue
        let t = tally.get(id)
        if (!t) { t = { n: 0, sx: 0, sy: 0, x0: W, y0: H, x1: 0, y1: 0 }; tally.set(id, t) }
        const yy = H - 1 - y // GL reads bottom-up
        t.n += 1; t.sx += x; t.sy += yy
        if (x < t.x0) t.x0 = x; if (x > t.x1) t.x1 = x; if (yy < t.y0) t.y0 = yy; if (yy > t.y1) t.y1 = yy
      }
    }
    anchors = []
    for (const [id, m] of ids) {
      const t = tally.get(id)
      const b = m.userData.box
      const centre = b.getCenter(new THREE.Vector3())
      const p = centre.clone().project(cam)
      anchors.push({
        node: m.userData.node,
        px: t ? t.n : 0,
        cx: t ? Math.round(t.sx / t.n) : null,
        cy: t ? Math.round(t.sy / t.n) : null,
        bbox: t ? [t.x0, t.y0, t.x1, t.y1] : null,
        proj: [Math.round(((p.x + 1) / 2) * W), Math.round(((1 - p.y) / 2) * H)],
        box: [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].map((v) => Number(v.toFixed(4))),
      })
    }
    for (const m of ids.values()) m.material.dispose()
  }
  for (const mat of beauty.values()) mat.dispose()
  cam.remove(lg)
  scene.clear()
  return { png, width: W, height: H, anchors, sceneBox: [boxAll.min.x, boxAll.min.y, boxAll.min.z, boxAll.max.x, boxAll.max.y, boxAll.max.z] }
}
window.rendererReady = true
</script></body></html>`

// --------------------------------------------------------------------------
// Driver
// --------------------------------------------------------------------------
async function withPage(fn) {
  const { server, port } = await serve()
  const browser = await chromium.launch({
    headless: !process.env.HEADED,
    channel: process.env.PW_CHANNEL ?? 'chrome',
    args: ['--use-gl=angle', '--use-angle=default', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'],
  })
  const page = await browser.newPage({ viewport: { width: 1200, height: 1600 }, deviceScaleFactor: 1 })
  const errors = []
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  page.on('pageerror', (e) => errors.push(e.message))
  try {
    await page.goto(`http://127.0.0.1:${port}/page`)
    await page.waitForFunction(() => window.rendererReady === true, null, { timeout: 60000 })
    return await fn(page, port, errors)
  } finally {
    await browser.close()
    server.close()
  }
}

const dataUrlToBuffer = (url) => Buffer.from(url.split(',')[1], 'base64')

async function shot() {
  const out = arg('--shot')
  const files = (arg('--files') ?? '').split(',').filter(Boolean).map((f) => resolve(f))
  const view = arg('--view', 'front')
  const px = Number(arg('--px', '1200'))
  const persp = arg('--persp')
  const target = arg('--target')
  const dir = arg('--dir')
  const height = arg('--height')
  const background = arg('--bg', null)
  await withPage(async (page, port, errors) => {
    const spec = {
      files: files.map((f) => ({ url: `http://127.0.0.1:${port}/file/${f.replace(/\\/g, '/')}` })),
      ids: false,
      background,
    }
    if (persp) {
      const t = target.split(',').map(Number)
      const d = dir.split(',').map(Number)
      const dist = Number(arg('--dist', '0.6'))
      spec.camera = { type: 'persp', fov: Number(persp), position: [t[0] + d[0] * dist, t[1] + d[1] * dist, t[2] + d[2] * dist], target: t, widthPx: px, heightPx: px }
    } else {
      let box = null
      if (target && height) {
        const t = target.split(',').map(Number)
        const h = Number(height)
        box = { min: [t[0] - h / 2, t[1] - h / 2, t[2] - h / 2], max: [t[0] + h / 2, t[1] + h / 2, t[2] + h / 2] }
      }
      spec.frame = { box, view, pad: 0.04, heightPx: px }
    }
    const result = await page.evaluate((s) => window.renderSpec(s), spec)
    writeFileSync(out, dataUrlToBuffer(result.png))
    console.log(`wrote ${out} (${result.width}x${result.height}) scene box ${result.sceneBox.map((v) => v.toFixed(3)).join(' ')}${errors.length ? ` errors: ${errors.join(' | ')}` : ''}`)
  })
}

async function build() {
  const manifest = JSON.parse(readFileSync(join(MODELS, 'manifest.json'), 'utf-8'))
  const sexes = arg('--sex') ? [arg('--sex')] : ['male', 'female']
  mkdirSync(OUT, { recursive: true })
  const previous = existsSync(join(OUT, 'diagrams.json')) ? JSON.parse(readFileSync(join(OUT, 'diagrams.json'), 'utf-8')) : null
  const result = { version: 1, generatedBy: 'scripts/render-anatomy-diagrams.mjs', heightPx: HEIGHT_PX, views: VIEWS, layers: LAYERS,
    note: 'One orthographic camera per sex (front and back), framed by the union box of every layer of that sex, so the layer images register pixel for pixel. anchors[<layer>-<view>][node] = [visible pixels, centroid x, centroid y, bbox x0, y0, x1, y1] in image pixels, from an ID pass of that layer alone; a structure hidden from that side has no entry. Images are the models drawn with the viewer materials on a transparent ground.',
    budgets: { imageBytes: IMAGE_BUDGET, sexBytes: SEX_BUDGET }, sexes: previous?.sexes ?? {} }
  await withPage(async (page, port, errors) => {
    for (const sex of sexes) {
      const record = manifest.sexes[sex]
      const structures = JSON.parse(readFileSync(join(MODELS, `structures-${sex}.json`), 'utf-8')).structures
      const byNode = Object.fromEntries(structures.map((s) => [s.node, s]))
      const layerFiles = (layer) => {
        const l = record.layers.find((x) => x.id === layer)
        return [l.file, ...(l.supplements ?? []).map((s) => s.file)]
      }
      // Frame: the union box of all layers, rendered once as a probe.
      const allFiles = LAYERS.flatMap(layerFiles)
      const probe = await page.evaluate((s) => window.renderSpec(s), {
        files: allFiles.map((f) => ({ url: `http://127.0.0.1:${port}/models/${f.replace('anatomy/models/', '')}` })),
        frame: { box: null, view: 'front', pad: 0.03, heightPx: 64 }, ids: false,
      })
      const b = probe.sceneBox
      const box = { min: b.slice(0, 3), max: b.slice(3) }
      const sexRecord = { box, images: [], anchors: {}, modelFiles: [] }
      for (const f of allFiles) {
        const bytes = readFileSync(join(MODELS, f.replace('anatomy/models/', '')))
        sexRecord.modelFiles.push({ file: f, sha256: sha256(bytes), bytes: bytes.length })
      }
      let sexBytes = 0
      for (const layer of LAYERS) {
        const files = layerFiles(layer)
        for (const view of VIEWS) {
          const spec = {
            files: files.map((f) => ({ url: `http://127.0.0.1:${port}/models/${f.replace('anatomy/models/', '')}`, structures: byNode })),
            frame: { box, view, pad: 0.03, heightPx: HEIGHT_PX }, ids: true,
          }
          const r = await page.evaluate((s) => window.renderSpec(s), spec)
          const png = dataUrlToBuffer(r.png)
          const webp = await sharp(png).webp({ quality: 80, alphaQuality: 90, effort: 5 }).toBuffer()
          const name = `${sex}-${layer}-${view}.webp`
          writeFileSync(join(OUT, name), webp)
          sexBytes += webp.length
          sexRecord.images.push({ layer, view, file: `anatomy/diagrams/${name}`, width: r.width, height: r.height, bytes: webp.length, sha256: sha256(webp) })
          // Anchors keyed by node; only the fields the tab needs.
          // Compact: [px, cx, cy, x0, y0, x1, y1] per VISIBLE structure; a
          // structure hidden from this side has no entry (the tab treats
          // absence as px = 0).
          const table = {}
          for (const a of r.anchors) if (a.px > 0) table[a.node] = [a.px, a.cx, a.cy, ...a.bbox]
          sexRecord.anchors[`${layer}-${view}`] = table
          const visible = r.anchors.filter((a) => a.px > 0).length
          console.log(`  ${name}: ${r.width}x${r.height}, ${(webp.length / 1e3).toFixed(0)} kB, ${visible}/${r.anchors.length} structures visible`)
          if (webp.length > IMAGE_BUDGET) console.error(`  FAIL ${name} over the ${IMAGE_BUDGET} byte image budget`)
        }
      }
      sexRecord.totalBytes = sexBytes
      if (sexBytes > SEX_BUDGET) console.error(`  FAIL ${sex}: ${sexBytes} bytes over the ${SEX_BUDGET} sex budget`)
      result.sexes[sex] = sexRecord
      console.log(`  ${sex}: ${(sexBytes / 1e6).toFixed(2)} MB of diagrams`)
    }
    if (errors.length) console.error('page errors:', errors.slice(0, 10))
  })
  writeFileSync(join(OUT, 'diagrams.json'), JSON.stringify(result) + '\n')
  console.log('wrote', join(OUT, 'diagrams.json'))
}

if (arg('--shot')) await shot()
else await build()
