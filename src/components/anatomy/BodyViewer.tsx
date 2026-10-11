import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

import { canvasPixelRatio, lowPowerDevice } from '../../lib/device'
import {
  LAYER_ORDER,
  anatomyModelUrl,
  groupNameOf,
  labelGroups,
  labelPriority,
  structureSide,
  type DiagramsFile,
  type LabelGroup,
  type LayerId,
  type ModelManifest,
  type ModelStructure,
  type Sex,
} from '../../lib/anatomy'

/**
 * The 3-D body (round 12, DATA_DECISIONS.md §65; round 13, §69; round 14, §71).
 *
 * One registered model per sex, six layers ordered bone -> flesh. The depth
 * control shows layers 0..depth; the layer AT the depth is the one the
 * reader is looking at, and with "see-through" on it is drawn translucent
 * so the layer beneath shows through it, in the same model space.
 *
 * Round 14 — how it draws. Every structure used to be its own mesh: at the
 * muscles depth that was 3,000–3,400 draw calls a frame, 14–16 ms of main
 * thread per frame before the GPU did anything, and a loop that rendered
 * every frame whether or not anything had changed. Now each layer is
 * MERGED into a handful of geometries (one per material: colour × sheet
 * translucency), with two extra vertex attributes: `aId`, the structure's
 * integer id, and `aHighlight`, an emissive colour written per structure
 * when it is selected / in the picked group / in the highlighted organ
 * (the material's shader adds it; no material swaps). The structure under a
 * tap or click comes from a 1×1 ID pass (the scene drawn once with the
 * id-to-colour material through a view offset at the pointer) instead of a
 * raycast over a million triangles. The loop renders ON DEMAND: when the
 * controls moved (damping included), while a layer fades, when the
 * highlight or the labels changed, after a resize. During a gesture the
 * backing store drops to a motion pixel ratio and returns to the full one
 * at the settled frame.
 *
 * Labels (round 13, redone in round 14). Once the camera has settled, a
 * low-resolution ID pass of the visible opaque layers gives every
 * structure of the labelled layer the pixels where it is REALLY visible
 * from this camera: its area on screen (the ranking), the visible pixel
 * nearest its centroid (where the leader line lands — never empty space,
 * never a hidden part) and a 3-D anchor there (the structure's own vertex
 * under that pixel) that the leader follows while the body turns. On a
 * desktop the labels are a plate: two margin columns packed top to
 * bottom with leader lines, the same layout as the Diagrams tab; on a
 * phone they are dots on the body that a tap expands. Density follows
 * the zoom (a structure is labelled once its visible area is large
 * enough), with the curated tiers first; a search string shows every
 * match.
 *
 * This module is React.lazy-loaded so three.js stays out of the page
 * chunk (the Solar System pattern); the meshopt decoder is three's own
 * self-contained module, nothing is fetched from a third-party CDN.
 */

export interface LoadState {
  loaded: LayerId[]
  loading: LayerId | null
  error: string | null
}

export interface LabelItem {
  key: string
  label: string
  group: LabelGroup
  nodes: string[]
  organ: string | null
  /** The structure a click on the label opens. */
  structure: ModelStructure
}

interface Props {
  sex: Sex
  manifest: ModelManifest
  structures: ModelStructure[]
  diagrams: DiagramsFile | null
  depth: number
  seeThrough: boolean
  selectedNode: string | null
  selectedKey: string | null
  highlightOrgan: string | null
  labelsOn: boolean
  labelQuery: string
  onPick: (structure: ModelStructure | null) => void
  onLabelOpen: (structure: ModelStructure) => void
  onLoadState: (state: LoadState) => void
  resetToken: number
  /** Full screen in or out: the distance is refitted to the new stage, the rotation kept. */
  fullscreen: boolean
  reducedMotion: boolean
  compact: boolean
}

// Load order: what the reader sees first (the outermost layer), then the
// frame everything hangs on, then the rest. The depth the page opens on
// decides which of these are visible; the others arrive in the background.
const LOAD_ORDER: LayerId[] = ['skin', 'skeleton', 'muscles', 'vessels', 'organs', 'nervous']

const TRANSLUCENT_OPACITY = 0.22
const FADE_SECONDS = 0.35
const FOV = 32
/** Minimum visible size on screen (side of the equivalent square, px) for a label. */
const LABEL_MIN_PX = { desktop: 11, compact: 16 }
/** Caps: a desktop plate packs two margin columns; a phone shows dots. */
const LABEL_MAX = { desktop: 56, compact: 24 }
const LABEL_SEARCH_MAX = 90
const LABEL_ROW = 20
/** The camera must be still this long before the labels are laid out again. */
const SETTLE_MS = 140
/** Long side of the label ID pass, in pixels. */
const ID_PASS_PX = { desktop: 360, compact: 240 }
/** At most this many vertices of a structure are projected to find its anchor. */
const ANCHOR_SAMPLES = 3000

const COLOURS = {
  bone: 0xe6dcc8,
  cartilage: 0xcfd8d4,
  ligament: 0xd9c9a8,
  nerve: 0xe7c85a,
  brain: 0xd8b6b0,
  eye: 0xe9ecef,
  muscle: 0xa64b3f,
  tendon: 0xe0d6c2,
  fascia: 0xd7cdb8,
  skin: 0xd6a98a,
  skinFemale: 0xd9ad90,
  hair: 0x4a3626,
  artery: 0xc23b2f,
  vein: 0x3f5fa8,
  heart: 0xa8302a,
  lymph: 0x6fae7a,
  digestive: 0xc9906a,
  respiratory: 0xe3a3a8,
  urinary: 0xcaa24a,
  reproductive: 0xcf8fb5,
  endocrine: 0xb28ad4,
  liver: 0x8f4a3f,
  other: 0xb9a89a,
}

/** Highlight emissive colours (linear), by kind. */
const HIGHLIGHT = {
  selected: new THREE.Color(0xffc83d).multiplyScalar(0.75),
  group: new THREE.Color(0xffd27a).multiplyScalar(0.5),
  organ: new THREE.Color(0xffa65c).multiplyScalar(0.35),
}

/** Fasciae, bursae, sheaths and the like sheet over the muscles: drawn
    translucent so the muscles read beneath them (round 13). */
const SHEET = /fascia|bursa|sheath|septum|aponeurosis|retinaculum|iliotibial tract|membrane/
function baseOpacityFor(structure: ModelStructure): number {
  const name = structure.name.toLowerCase()
  if (structure.layer === 'muscles' && SHEET.test(name)) return 0.35
  // The skeleton's membranes (intercostal, interosseous, obturator) sheet over the bones.
  if (structure.layer === 'skeleton' && /membrane/.test(name)) return 0.35
  return 1
}

function colourFor(structure: ModelStructure): number {
  const name = structure.name.toLowerCase()
  const organ = structure.organ ?? ''
  switch (structure.layer) {
    case 'skeleton':
      if (/cartilage|disc|pulposus|menisc|labrum/.test(name)) return COLOURS.cartilage
      if (/ligament|capsule|membrane|symphysis/.test(name)) return COLOURS.ligament
      return COLOURS.bone
    case 'nervous':
      if (organ === 'eye' || /\beye|retina|cornea|lens|sclera|vitreous|iris|conjunctiva/.test(name)) return COLOURS.eye
      if (/^(brain|cerebrum|cerebellum|brainstem|hypothalamus|pineal|pituitary|spinal-cord)$/.test(organ)) return COLOURS.brain
      if (/muscle|rectus|oblique/.test(name)) return COLOURS.muscle
      if (/artery|vein/.test(name)) return /vein/.test(name) ? COLOURS.vein : COLOURS.artery
      return COLOURS.nerve
    case 'vessels':
      if (organ === 'heart') return COLOURS.heart
      if (structure.system === 'lymphatic' || /lymph|node|spleen|thymus|tonsil/.test(name)) return COLOURS.lymph
      if (/vein|vena|venous|sinus|azygos|portal/.test(name)) return COLOURS.vein
      return COLOURS.artery
    case 'muscles':
      if (/tendon|aponeurosis|retinaculum/.test(name)) return COLOURS.tendon
      if (/fascia|bursa|sheath|septum/.test(name)) return COLOURS.fascia
      return COLOURS.muscle
    case 'skin':
      // Z-Anatomy's hair regions are meshes of their own: drawn as hair.
      if (/hairs? of head|eyebrow|pubic hair|eyelash/.test(name)) return COLOURS.hair
      return COLOURS.skin
    case 'organs':
    default:
      if (organ === 'liver' || organ === 'gallbladder') return COLOURS.liver
      switch (structure.system) {
        case 'respiratory':
          return COLOURS.respiratory
        case 'urinary':
          return COLOURS.urinary
        case 'reproductive':
          return COLOURS.reproductive
        case 'endocrine':
          return COLOURS.endocrine
        case 'lymphatic':
          return COLOURS.lymph
        case 'digestive':
          return COLOURS.digestive
        case 'integumentary':
          return COLOURS.skinFemale
        case 'muscular':
          return COLOURS.muscle
        default:
          return COLOURS.other
      }
  }
}

/** One structure inside a merged geometry. */
interface Part {
  node: string
  id: number
  structure: ModelStructure | null
  merged: Merged
  vertexStart: number
  vertexCount: number
}

/** One draw call: every structure of a layer that shares a material. */
interface Merged {
  mesh: THREE.Mesh
  material: THREE.MeshStandardMaterial
  positions: Float32Array
  highlight: THREE.BufferAttribute
  baseOpacity: number
  parts: Part[]
}

interface LabelRecord extends LabelItem {
  /** For a side pair: 'left' | 'right'; for the merged pair label: 'both'. */
  pair: 'left' | 'right' | 'both' | null
  /** Priority tier: 0 curated major part, 1 structure, 2 sub-part. */
  tier: number
  /** Structure ids of the nodes (for the ID pass tables). */
  ids: number[]
}

interface Placed {
  key: string
  label: string
  group: LabelGroup
  structure: ModelStructure
  organ: string | null
  /** World-space anchor: the structure's own vertex under its visible centroid. */
  anchor: THREE.Vector3
  /** Desktop plate: the label's fixed position in the margin column. */
  lx: number
  ly: number
  side: 'left' | 'right'
  forced: boolean
}

interface LayerRecord {
  id: LayerId
  group: THREE.Group
  merged: Merged[]
  parts: Map<string, Part>
  labels: LabelRecord[]
  box: THREE.Box3
  opacity: number
  target: number
}

interface SceneRefs {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  controls: OrbitControls
  layers: Map<LayerId, LayerRecord>
  /** Part by id (1-based), across every loaded layer of this sex. */
  partsById: Part[]
  bodyBox: THREE.Box3 | null
  framed: boolean
  generation: number
  lastFrame: number
  /** Something changed: draw a frame. */
  needsRender: boolean
  /** The labels must be laid out again once the camera settles. */
  layoutDirty: boolean
  lastMoveAt: number
  /** The pixel ratio in use (motion or rest). */
  motion: boolean
  pointerDown: boolean
  shownKeys: string
  idMaterial: THREE.ShaderMaterial
  pickTarget: THREE.WebGLRenderTarget
  labelTarget: THREE.WebGLRenderTarget | null
  labelPixels: Uint8Array | null
  /** Frames drawn and label layouts run (the measurement scripts read these). */
  frames: number
  layouts: number
}

/** Layer opacity times the material's own (sheets stay translucent). */
function applyOpacity(material: THREE.MeshStandardMaterial, layerOpacity: number): void {
  const base = (material.userData.baseOpacity as number | undefined) ?? 1
  const opacity = layerOpacity * base
  material.opacity = opacity
  material.transparent = opacity < 0.999
  material.depthWrite = base >= 1 && opacity >= 0.999
}

/**
 * Opacity target of a layer for a depth: layers deeper than the depth are
 * hidden; the layer at the depth is translucent in see-through; and under an
 * OPAQUE skin (the outermost layer, see-through off) the deeper layers are
 * not drawn at all — they are invisible inside a closed skin, and only the
 * slivers of a fitted muscle or vessel poking through it would show.
 */
function layerTarget(index: number, depth: number, seeThrough: boolean): number {
  if (index > depth) return 0
  if (seeThrough && index === depth && depth > 0) return TRANSLUCENT_OPACITY
  if (!seeThrough && depth === LAYER_ORDER.length - 1 && index < depth) return 0
  return 1
}

function disposeLayer(record: LayerRecord): void {
  record.group.removeFromParent()
  for (const m of record.merged) {
    m.mesh.geometry.dispose()
    m.material.dispose()
  }
}

/** The material's shader adds the per-vertex highlight colour as emissive light. */
function highlightMaterial(colour: number, baseOpacity: number): THREE.MeshStandardMaterial {
  const material = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.72, metalness: 0 })
  material.userData.baseOpacity = baseOpacity
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aHighlight;\nvarying vec3 vHighlight;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHighlight = aHighlight;')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHighlight;')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vHighlight;')
  }
  material.customProgramCacheKey = () => 'anatomy-highlight'
  return material
}

/** Structure id -> flat colour, read back as bytes. */
function makeIdMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: `
      attribute float aId;
      varying float vId;
      void main() {
        vId = aId;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying float vId;
      void main() {
        float id = floor(vId + 0.5);
        gl_FragColor = vec4(mod(id, 256.0) / 255.0, mod(floor(id / 256.0), 256.0) / 255.0, floor(id / 65536.0) / 255.0, 1.0);
      }`,
    side: THREE.FrontSide,
  })
}

/** The label set of a layer: one per structure group, or one per side when apart. */
function buildLabels(groups: LabelGroup[], parts: Map<string, Part>): LabelRecord[] {
  const out: LabelRecord[] = []
  const make = (key: string, label: string, group: LabelGroup, nodes: ModelStructure[], pair: LabelRecord['pair'] = null): void => {
    const ids = nodes.map((s) => parts.get(s.node)?.id ?? 0).filter((id) => id > 0)
    if (ids.length === 0) return
    out.push({
      key,
      label,
      group,
      nodes: nodes.map((s) => s.node),
      organ: group.organ,
      structure: nodes[0]!,
      pair,
      tier: labelPriority(group.layer, group.name, group.organ),
      ids,
    })
  }
  for (const group of groups) {
    const left = group.nodes.filter((s) => structureSide(s.name) === 'left')
    const right = group.nodes.filter((s) => structureSide(s.name) === 'right')
    const unsided = group.nodes.filter((s) => structureSide(s.name) === null)
    if (left.length && right.length && unsided.length === 0) {
      make(`${group.key}:left`, `${group.name} (left)`, group, left, 'left')
      make(`${group.key}:right`, `${group.name} (right)`, group, right, 'right')
      // The merged form, used when the two sit together on screen.
      make(`${group.key}:both`, `${group.name} (left/right)`, group, group.nodes, 'both')
      continue
    }
    make(group.key, group.name, group, group.nodes)
  }
  return out
}

/** Per-structure visibility from an ID pass: pixel count, centroid, bbox. */
interface IdStats {
  count: Float64Array
  sx: Float64Array
  sy: Float64Array
  x0: Float64Array
  y0: Float64Array
  x1: Float64Array
  y1: Float64Array
  /** Bounding box of every visible structure (the body on screen), in pass pixels. */
  body: [number, number, number, number] | null
}

function accumulateIds(pixels: Uint8Array, w: number, h: number, maxId: number): IdStats {
  const n = maxId + 1
  const stats: IdStats = {
    count: new Float64Array(n), sx: new Float64Array(n), sy: new Float64Array(n),
    x0: new Float64Array(n).fill(Infinity), y0: new Float64Array(n).fill(Infinity),
    x1: new Float64Array(n).fill(-Infinity), y1: new Float64Array(n).fill(-Infinity), body: null,
  }
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity
  for (let y = 0; y < h; y += 1) {
    // The target reads bottom-up; flip so y grows downward like the screen.
    const row = (h - 1 - y) * w * 4
    for (let x = 0; x < w; x += 1) {
      const o = row + x * 4
      const id = pixels[o]! + pixels[o + 1]! * 256 + pixels[o + 2]! * 65536
      if (id === 0 || id > maxId) continue
      stats.count[id] = stats.count[id]! + 1
      stats.sx[id] = stats.sx[id]! + x
      stats.sy[id] = stats.sy[id]! + y
      if (x < stats.x0[id]!) stats.x0[id] = x
      if (y < stats.y0[id]!) stats.y0[id] = y
      if (x > stats.x1[id]!) stats.x1[id] = x
      if (y > stats.y1[id]!) stats.y1[id] = y
      if (x < bx0) bx0 = x
      if (y < by0) by0 = y
      if (x > bx1) bx1 = x
      if (y > by1) by1 = y
    }
  }
  if (bx1 >= bx0) stats.body = [bx0, by0, bx1, by1]
  return stats
}

export default function BodyViewer({
  sex,
  manifest,
  structures,
  diagrams,
  depth,
  seeThrough,
  selectedNode,
  selectedKey,
  highlightOrgan,
  labelsOn,
  labelQuery,
  onPick,
  onLabelOpen,
  onLoadState,
  resetToken,
  fullscreen,
  reducedMotion,
  compact,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const leadersRef = useRef<SVGSVGElement>(null)
  const refs = useRef<SceneRefs | null>(null)
  const labelElements = useRef(new Map<string, HTMLElement>())
  const lineElements = useRef(new Map<string, SVGLineElement>())
  const [shown, setShown] = useState<Placed[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  /** The placed labels by key, for the per-frame follow and the tap test. */
  const shownByKey = useRef(new Map<string, Placed>())
  const latest = useRef({ depth, seeThrough, onPick, onLabelOpen, onLoadState, reducedMotion, structures, labelsOn, labelQuery, selectedKey, selectedNode, highlightOrgan, compact, sex, expanded })
  latest.current = { depth, seeThrough, onPick, onLabelOpen, onLoadState, reducedMotion, structures, labelsOn, labelQuery, selectedKey, selectedNode, highlightOrgan, compact, sex, expanded }
  // The diagram pass is no longer needed for the 3-D labels (round 14: a live
  // ID pass replaces it); the prop stays so the stage's contract is unchanged.
  void diagrams
  shownByKey.current = new Map(shown.map((p) => [p.key, p]))
  // The pins and leader lines React just committed need one frame to be
  // placed at their anchors (the loop only touches the DOM when it draws).
  useEffect(() => {
    const state = refs.current
    if (state) state.needsRender = true
  }, [shown])

  // ---- Scene lifetime -----------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const width = Math.max(1, mount.clientWidth)
    const height = Math.max(1, mount.clientHeight)
    const restRatio = canvasPixelRatio()
    // During a gesture the backing store shrinks: on a phone to 1×, on a
    // desktop to 1.25× at most (an 8 Mpx full-screen buffer at dpr 2 is
    // what made a fast machine stutter and a phone crawl).
    const motionRatio = lowPowerDevice() ? Math.min(1, restRatio) : Math.min(1.25, restRatio)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(restRatio)
    renderer.setSize(width, height)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.domElement.style.touchAction = 'none'
    renderer.domElement.setAttribute('aria-label', 'Three-dimensional body; drag to rotate, pinch or scroll to zoom')
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(FOV, width / height, 0.01, 100)
    camera.position.set(0, 1, 4)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = !latest.current.reducedMotion
    // Round 14: a firmer response (0.08 read as mush on a phone).
    controls.dampingFactor = 0.16
    controls.enablePan = true
    controls.screenSpacePanning = true
    controls.rotateSpeed = 0.9
    controls.zoomSpeed = 0.9
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN }
    // Zoom toward the pointer (the feet, a hand), not always the body's centre.
    controls.zoomToCursor = true

    scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8078, 1.6))
    const key = new THREE.DirectionalLight(0xffffff, 2.1)
    key.position.set(2, 3, 4)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.8)
    fill.position.set(-3, 1, -2)
    scene.add(fill)

    const state: SceneRefs = {
      renderer, scene, camera, controls,
      layers: new Map(),
      partsById: [],
      bodyBox: null,
      framed: false,
      generation: 0,
      lastFrame: performance.now(),
      needsRender: true,
      layoutDirty: true,
      lastMoveAt: 0,
      motion: false,
      pointerDown: false,
      shownKeys: '',
      idMaterial: makeIdMaterial(),
      pickTarget: new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true }),
      labelTarget: null,
      labelPixels: null,
      frames: 0,
      layouts: 0,
    }
    refs.current = state
    // Dev-only hook for the measurement scripts (.scratch/r14-anatomy-perf.mjs).
    if (import.meta.env.DEV) (window as unknown as { __anatomy?: unknown }).__anatomy = state
    controls.addEventListener('change', () => {
      state.needsRender = true
      state.layoutDirty = true
      state.lastMoveAt = performance.now()
    })

    // ---- ID passes: picking and label anchors ---------------------------------
    /** Draw the visible opaque layers with the id material. `sheets` includes
        the translucent sheets (fasciae) too. */
    const renderIds = (target: THREE.WebGLRenderTarget, sheets: boolean): void => {
      const { depth: d, seeThrough: xray } = latest.current
      const hidden: THREE.Object3D[] = []
      LAYER_ORDER.forEach((id, index) => {
        const record = state.layers.get(id)
        if (!record) return
        const shownOpaque = layerTarget(index, d, xray) >= 1
        if (!shownOpaque) {
          if (record.group.visible) { record.group.visible = false; hidden.push(record.group) }
          return
        }
        if (!record.group.visible) return
        for (const m of record.merged) {
          if (!sheets && m.baseOpacity < 1 && m.mesh.visible) { m.mesh.visible = false; hidden.push(m.mesh) }
        }
      })
      const previousTarget = renderer.getRenderTarget()
      const clear = new THREE.Color()
      renderer.getClearColor(clear)
      const alpha = renderer.getClearAlpha()
      scene.overrideMaterial = state.idMaterial
      renderer.setRenderTarget(target)
      renderer.setClearColor(0x000000, 1)
      renderer.clear()
      renderer.render(scene, camera)
      renderer.setRenderTarget(previousTarget)
      renderer.setClearColor(clear, alpha)
      scene.overrideMaterial = null
      for (const o of hidden) o.visible = true
    }

    const pickAt = (clientX: number, clientY: number): Part | null => {
      const rect = renderer.domElement.getBoundingClientRect()
      const w = Math.max(1, Math.round(rect.width))
      const h = Math.max(1, Math.round(rect.height))
      const px = Math.max(0, Math.min(w - 1, Math.floor(clientX - rect.left)))
      const py = Math.max(0, Math.min(h - 1, Math.floor(clientY - rect.top)))
      const bytes = new Uint8Array(4)
      const read = (sheets: boolean): number => {
        camera.setViewOffset(w, h, px, py, 1, 1)
        renderIds(state.pickTarget, sheets)
        camera.clearViewOffset()
        renderer.readRenderTargetPixels(state.pickTarget, 0, 0, 1, 1, bytes)
        return bytes[0]! + bytes[1]! * 256 + bytes[2]! * 65536
      }
      // An opaque structure under the pointer wins over a translucent sheet.
      let id = read(false)
      if (id === 0) id = read(true)
      state.needsRender = true
      return id > 0 ? (state.partsById[id] ?? null) : null
    }

    // Picking: a press that neither travelled nor lingered is a pick.
    let press: { x: number; y: number; t: number; id: number } | null = null
    const onDown = (event: PointerEvent) => {
      state.pointerDown = true
      if (!event.isPrimary) return
      press = { x: event.clientX, y: event.clientY, t: performance.now(), id: event.pointerId }
    }
    const onUp = (event: PointerEvent) => {
      state.pointerDown = false
      if (!press || press.id !== event.pointerId) return
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y)
      const held = performance.now() - press.t
      press = null
      if (moved > 6 || held > 600) return
      // The pins do not take pointer events (a drag that starts on a label
      // must still turn the body), so a tap is tested against them here.
      for (const [key2, element] of labelElements.current) {
        const item = shownByKey.current.get(key2)
        if (!item || element.style.display === 'none') continue
        const r = element.getBoundingClientRect()
        if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) continue
        const { compact: small, expanded: open, selectedKey: sel, highlightOrgan: organ } = latest.current
        const active = (sel !== null && item.group.key === sel) || (organ !== null && item.organ === organ)
        if (small && open !== key2 && !active) setExpanded(key2)
        else latest.current.onLabelOpen(item.structure)
        return
      }
      const part = pickAt(event.clientX, event.clientY)
      latest.current.onPick(part?.structure ?? null)
    }
    const onCancel = () => {
      state.pointerDown = false
      press = null
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onCancel)
    window.addEventListener('pointerup', onCancel)

    const resize = () => {
      const w = Math.max(1, mount.clientWidth)
      const h = Math.max(1, mount.clientHeight)
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      // The stage changed size (full screen in or out, a window resize):
      // refit the distance so the body fills the new stage, keeping the
      // rotation and the target the reader chose.
      if (state.framed) fitDistance(state)
      mount.dataset.stage = `${w}x${h}`
      state.needsRender = true
      state.layoutDirty = true
      state.lastMoveAt = performance.now()
      if (leadersRef.current) {
        leadersRef.current.setAttribute('width', String(w))
        leadersRef.current.setAttribute('height', String(h))
      }
    }
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    // ---- Label layout (on settle) ---------------------------------------------
    const projected = new THREE.Vector3()
    const viewProjection = new THREE.Matrix4()
    interface Candidate {
      item: LabelRecord
      px: number
      cx: number
      cy: number
      bbox: [number, number, number, number]
      forced: boolean
      boosted: boolean
      tier: number
    }
    const relayout = (w: number, h: number): void => {
      const { depth: d, seeThrough: xray, labelsOn: on, labelQuery: query, selectedKey: sel, highlightOrgan: organ, compact: small } = latest.current
      const labelled = state.layers.get(LAYER_ORDER[xray && d > 0 ? d - 1 : d] ?? 'skin')
      if (!labelled || !state.bodyBox) return
      const q = query.trim().toLowerCase()
      const wanted = on || q || sel || organ
      if (!wanted) {
        if (state.shownKeys !== '') { state.shownKeys = ''; setShown([]) }
        return
      }
      state.layouts += 1
      // The ID pass at a fraction of the stage.
      const long = small ? ID_PASS_PX.compact : ID_PASS_PX.desktop
      const scale = Math.min(1, long / Math.max(w, h))
      const pw = Math.max(8, Math.round(w * scale))
      const ph = Math.max(8, Math.round(h * scale))
      if (!state.labelTarget || state.labelTarget.width !== pw || state.labelTarget.height !== ph) {
        state.labelTarget?.dispose()
        state.labelTarget = new THREE.WebGLRenderTarget(pw, ph, { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true })
        state.labelPixels = new Uint8Array(pw * ph * 4)
      }
      renderIds(state.labelTarget, false)
      renderer.readRenderTargetPixels(state.labelTarget, 0, 0, pw, ph, state.labelPixels!)
      const maxId = state.partsById.length - 1
      const stats = accumulateIds(state.labelPixels!, pw, ph, maxId)
      const toScreen = 1 / scale

      // Candidates: every label whose structures are visible, with its
      // visible pixels, centroid and bbox summed over its nodes.
      const candidates: Candidate[] = []
      const bySideKey = new Map<string, Candidate>()
      for (const item of labelled.labels) {
        const forced = sel !== null && item.group.key === sel
        const boosted = organ !== null && item.organ === organ
        if (!on && !q && !forced && !boosted) continue
        if (q && !item.label.toLowerCase().includes(q) && !forced) continue
        let px = 0, sx = 0, sy = 0
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const id of item.ids) {
          const n = stats.count[id]!
          if (n === 0) continue
          px += n
          sx += stats.sx[id]!
          sy += stats.sy[id]!
          x0 = Math.min(x0, stats.x0[id]!); y0 = Math.min(y0, stats.y0[id]!)
          x1 = Math.max(x1, stats.x1[id]!); y1 = Math.max(y1, stats.y1[id]!)
        }
        if (px === 0) continue
        const c: Candidate = { item, px, cx: sx / px, cy: sy / px, bbox: [x0, y0, x1, y1], forced, boosted, tier: item.tier }
        candidates.push(c)
        bySideKey.set(item.key, c)
      }
      // Side pairs: both visible and apart -> two labels; else the merged one.
      const drop = new Set<string>()
      for (const c of candidates) {
        if (c.item.pair !== 'both') continue
        const base = c.item.key.slice(0, -':both'.length)
        const l = bySideKey.get(`${base}:left`)
        const r = bySideKey.get(`${base}:right`)
        if (l && r) {
          const gap = Math.max(l.bbox[0] - r.bbox[2], r.bbox[0] - l.bbox[2])
          const apart = gap > pw * 0.03
          if (apart) drop.add(c.item.key)
          else { drop.add(l.item.key); drop.add(r.item.key) }
        } else drop.add(c.item.key)
      }
      const minPx = small ? LABEL_MIN_PX.compact : LABEL_MIN_PX.desktop
      const ranked = candidates
        .filter((c) => !drop.has(c.item.key))
        .map((c) => ({ c, blob: Math.sqrt(c.px) * toScreen * (c.boosted ? 2 : 1) }))
        .filter(({ c, blob }) => c.forced || q || blob >= minPx * (c.tier === 0 ? 0.5 : 1))
        .sort((a, b) => (a.c.forced !== b.c.forced ? (a.c.forced ? -1 : 1) : a.c.tier !== b.c.tier ? a.c.tier - b.c.tier : b.blob - a.blob))
        .map(({ c }) => c)

      // The visible pixel nearest each candidate's centroid (a ring or a
      // crescent has its centroid in empty space): one pass over the pixels.
      const cap = q ? LABEL_SEARCH_MAX : small ? LABEL_MAX.compact : LABEL_MAX.desktop
      const considered = ranked.slice(0, cap * 2 + 8)
      const labelOfId = new Int32Array(maxId + 1).fill(-1)
      considered.forEach((c, i) => { for (const id of c.item.ids) labelOfId[id] = i })
      const bestD = new Float64Array(considered.length).fill(Infinity)
      const bestX = new Float64Array(considered.length)
      const bestY = new Float64Array(considered.length)
      const pixels = state.labelPixels!
      for (let y = 0; y < ph; y += 1) {
        const row = (ph - 1 - y) * pw * 4
        for (let x = 0; x < pw; x += 1) {
          const o = row + x * 4
          const id = pixels[o]! + pixels[o + 1]! * 256 + pixels[o + 2]! * 65536
          if (id === 0 || id > maxId) continue
          const li = labelOfId[id]!
          if (li < 0) continue
          const c = considered[li]!
          const dd = (x - c.cx) ** 2 + (y - c.cy) ** 2
          if (dd < bestD[li]!) { bestD[li] = dd; bestX[li] = x; bestY[li] = y }
        }
      }

      // 3-D anchor: the structure's own vertex that projects nearest the
      // anchor pixel (so the leader follows the body as it turns).
      camera.updateMatrixWorld()
      viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
      const anchorFor = (c: Candidate, i: number): THREE.Vector3 | null => {
        const ax = ((bestX[i]! + 0.5) / pw) * 2 - 1
        const ay = 1 - ((bestY[i]! + 0.5) / ph) * 2
        let best: THREE.Vector3 | null = null
        let bestDist = Infinity
        let bestDepth = Infinity
        for (const id of c.item.ids) {
          if (stats.count[id] === 0) continue
          const part = state.partsById[id]
          if (!part) continue
          const pos = part.merged.positions
          const stride = Math.max(1, Math.floor(part.vertexCount / ANCHOR_SAMPLES))
          for (let vi = 0; vi < part.vertexCount; vi += stride) {
            const o = (part.vertexStart + vi) * 3
            projected.set(pos[o]!, pos[o + 1]!, pos[o + 2]!).applyMatrix4(viewProjection)
            if (projected.z > 1) continue
            const dist = (projected.x - ax) ** 2 + (projected.y - ay) ** 2
            // Nearest on screen; among near-ties, the one nearest the camera.
            if (dist < bestDist - 1e-6 || (dist < bestDist + 1e-6 && projected.z < bestDepth)) {
              bestDist = dist
              bestDepth = projected.z
              best = new THREE.Vector3(pos[o]!, pos[o + 1]!, pos[o + 2]!)
            }
          }
        }
        return best
      }

      // Placement.
      const placed: Placed[] = []
      const body = stats.body ?? [0, 0, pw, ph]
      const bodyLeft = body[0] * toScreen
      const bodyRight = (body[2] + 1) * toScreen
      const bodyCentre = (bodyLeft + bodyRight) / 2
      const make = (c: Candidate, i: number, side: 'left' | 'right', x: number, y: number): Placed | null => {
        const anchor = anchorFor(c, i)
        if (!anchor) return null
        return { key: c.item.key, label: c.item.label, group: c.item.group, structure: c.item.structure, organ: c.item.organ, anchor, lx: x, ly: y, side, forced: c.forced }
      }
      if (small) {
        const boxes: { x0: number; y0: number; x1: number; y1: number }[] = []
        for (let i = 0; i < considered.length; i += 1) {
          const c = considered[i]!
          if (placed.length >= cap && !c.forced) break
          if (bestD[i] === Infinity) continue
          const x = (bestX[i]! + 0.5) * toScreen
          const y = (bestY[i]! + 0.5) * toScreen
          const box = { x0: x - 14, y0: y - 14, x1: x + 14, y1: y + 14 }
          if (!c.forced && boxes.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue
          const p = make(c, i, x < bodyCentre ? 'left' : 'right', x, y)
          if (!p) continue
          boxes.push(box)
          placed.push(p)
        }
      } else {
        const rows = Math.max(1, Math.floor((h - 16) / LABEL_ROW))
        const total = Math.min(cap, rows * 2)
        const columns: { left: Placed[]; right: Placed[] } = { left: [], right: [] }
        for (let i = 0; i < considered.length; i += 1) {
          const c = considered[i]!
          if (columns.left.length + columns.right.length >= total && !c.forced) break
          if (bestD[i] === Infinity) continue
          const x = (bestX[i]! + 0.5) * toScreen
          const y = (bestY[i]! + 0.5) * toScreen
          // A label near the midline (a merged left/right pair, the spine)
          // goes to the emptier column so the plate stays balanced.
          const nearMiddle = Math.abs(x - bodyCentre) < (bodyRight - bodyLeft) * 0.12
          const side: 'left' | 'right' = nearMiddle
            ? (columns.left.length <= columns.right.length ? 'left' : 'right')
            : x < bodyCentre ? 'left' : 'right'
          if (columns[side].length >= rows && !c.forced) continue
          // A label must fit its margin (a third of the body's width of
          // overlap is tolerated); on a narrow embedded stage the long
          // names wait for full screen rather than cover the body.
          const width = plateText(c.item).length * 6 + 30
          const room = side === 'left' ? bodyLeft - 8 : w - 8 - bodyRight
          if (!c.forced && width > room + (bodyRight - bodyLeft) * 0.6) continue
          const p = make(c, i, side, x, y)
          if (!p) continue
          columns[side].push(p)
        }
        // The columns sit just outside the body; when the body fills the
        // stage they sit at its edges and read over it.
        const leftX = Math.max(8, Math.min(bodyLeft - 14, w - 8))
        const rightX = Math.min(w - 8, Math.max(bodyRight + 14, 8))
        for (const side of ['left', 'right'] as const) {
          const column = columns[side].sort((a, b) => a.ly - b.ly)
          // Pack top to bottom, then pull the tail back up if it ran off the bottom.
          let last = -Infinity
          for (const item of column) {
            item.ly = Math.max(item.ly, last + LABEL_ROW, 10)
            last = item.ly
          }
          let limit = h - 10
          for (let i = column.length - 1; i >= 0; i -= 1) {
            const item = column[i]!
            if (item.ly > limit) item.ly = limit
            limit = item.ly - LABEL_ROW
          }
          for (const item of column) {
            // The text must stay inside the stage: on a narrow stage the dot
            // moves in over the body by as much as the label needs.
            const width = plateText(item).length * 6 + 30
            item.lx = side === 'left' ? Math.max(leftX, Math.min(w - 8, width + 8)) : Math.min(rightX, Math.max(8, w - 8 - width))
            if (item.ly >= 4 && item.ly <= h - 4) placed.push(item)
          }
        }
      }
      const keys = placed.map((p) => `${p.key}@${p.lx.toFixed(0)},${p.ly.toFixed(0)}`).join('|')
      if (keys !== state.shownKeys) {
        state.shownKeys = keys
        setShown(placed)
      }
      state.needsRender = true
    }

    // ---- Render loop: on demand ------------------------------------------------
    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      const now = performance.now()
      const dt = Math.min(0.1, (now - state.lastFrame) / 1000)
      state.lastFrame = now
      if (controls.update()) {
        state.needsRender = true
        state.layoutDirty = true
        state.lastMoveAt = now
      }
      let fading = false
      for (const record of state.layers.values()) {
        if (record.opacity !== record.target) {
          const step = latest.current.reducedMotion ? 1 : dt / FADE_SECONDS
          record.opacity = record.opacity < record.target
            ? Math.min(record.target, record.opacity + step)
            : Math.max(record.target, record.opacity - step)
          for (const m of record.merged) applyOpacity(m.material, record.opacity)
          record.group.visible = record.opacity > 0.001
          fading = true
        }
      }
      if (fading) state.needsRender = true
      const moving = state.pointerDown || now - state.lastMoveAt < SETTLE_MS
      // Motion pixel ratio in, rest ratio out (one buffer resize per edge).
      if (moving && !state.motion && motionRatio < restRatio) {
        state.motion = true
        renderer.setPixelRatio(motionRatio)
        state.needsRender = true
      } else if (!moving && state.motion) {
        state.motion = false
        renderer.setPixelRatio(restRatio)
        state.needsRender = true
      }
      const overlay = overlayRef.current
      const w = overlay?.clientWidth ?? 0
      const h = overlay?.clientHeight ?? 0
      if (!moving && !fading && state.layoutDirty && state.bodyBox && overlay && w > 0) {
        state.layoutDirty = false
        relayout(w, h)
      }
      if (!state.needsRender) return
      state.needsRender = false
      state.frames += 1
      renderer.render(scene, camera)
      if ((now | 0) % 500 < 20) mount.dataset.cam = `${camera.position.distanceTo(controls.target).toFixed(3)} fit ${((camera.userData.fitDistance as number | undefined) ?? 0).toFixed(3)} aspect ${camera.aspect.toFixed(2)}`
      // Follow the anchors: leader lines on a desktop, dots on a phone.
      if (!overlay || w === 0) return
      for (const [key2, element] of labelElements.current) {
        const item = shownByKey.current.get(key2)
        if (!item) { element.style.display = 'none'; continue }
        projected.copy(item.anchor).project(camera)
        const visible = projected.z < 1 && Math.abs(projected.x) < 1.1 && Math.abs(projected.y) < 1.1
        const x = ((projected.x + 1) / 2) * w
        const y = ((1 - projected.y) / 2) * h
        if (latest.current.compact) {
          element.style.display = visible ? '' : 'none'
          if (visible) element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
        } else {
          element.style.opacity = visible ? '' : '0.35'
          const line = lineElements.current.get(key2)
          if (line) {
            line.style.display = visible ? '' : 'none'
            line.setAttribute('x2', x.toFixed(1))
            line.setAttribute('y2', y.toFixed(1))
          }
        }
      }
    }
    tick()

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('pointerup', onCancel)
      for (const record of state.layers.values()) disposeLayer(record)
      state.layers.clear()
      state.pickTarget.dispose()
      state.labelTarget?.dispose()
      state.idMaterial.dispose()
      controls.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      refs.current = null
    }
  }, [])

  // ---- Loading a sex --------------------------------------------------------
  useEffect(() => {
    const state = refs.current
    if (!state) return
    const generation = ++state.generation
    for (const record of state.layers.values()) disposeLayer(record)
    state.layers.clear()
    state.partsById = [{} as Part]
    state.bodyBox = null
    state.shownKeys = ''
    state.needsRender = true
    setShown([])
    const byNode = new Map(structures.map((s) => [s.node, s]))
    const record = manifest.sexes[sex]
    const loaded: LayerId[] = []
    const loader = new GLTFLoader()
    loader.setMeshoptDecoder(MeshoptDecoder)
    const report = (loading: LayerId | null, error: string | null = null) =>
      latest.current.onLoadState({ loaded: [...loaded], loading, error })

    const loadOne = async (id: LayerId) => {
      const layer = record.layers.find((l) => l.id === id)
      if (!layer) return
      report(id)
      // A layer may carry supplement files under their own licence (the
      // structures fitted from the male model); they draw with the layer.
      const files = [layer.file, ...(layer.supplements ?? []).map((s) => s.file)]
      const gltfs = await Promise.all(files.map((file) => loader.loadAsync(anatomyModelUrl(file))))
      if (generation !== state.generation) return
      // Gather every mesh with its world transform, grouped by material.
      interface Source { mesh: THREE.Mesh; node: string; structure: ModelStructure | null; count: number; indexCount: number }
      const groups = new Map<number, { colour: number; baseOpacity: number; sources: Source[]; vertices: number; indices: number }>()
      const box = new THREE.Box3()
      for (const gltf of gltfs) {
        gltf.scene.updateMatrixWorld(true)
        gltf.scene.traverse((object) => {
          if (!(object as THREE.Mesh).isMesh) return
          const mesh = object as THREE.Mesh
          const node = (mesh.userData.name as string | undefined) ?? mesh.name
          const structure = byNode.get(node) ?? null
          const colour = structure ? colourFor(structure) : COLOURS.other
          const baseOpacity = structure ? baseOpacityFor(structure) : 1
          const materialKey = colour * 2 + (baseOpacity < 1 ? 1 : 0)
          let g = groups.get(materialKey)
          if (!g) {
            g = { colour, baseOpacity, sources: [], vertices: 0, indices: 0 }
            groups.set(materialKey, g)
          }
          const geometry = mesh.geometry as THREE.BufferGeometry
          const count = geometry.getAttribute('position').count
          const indexCount = geometry.index ? geometry.index.count : count
          g.sources.push({ mesh, node, structure, count, indexCount })
          g.vertices += count
          g.indices += indexCount
        })
      }
      const group = new THREE.Group()
      group.name = `${sex}-${id}`
      const merged: Merged[] = []
      const parts = new Map<string, Part>()
      const normalMatrix = new THREE.Matrix3()
      const v = new THREE.Vector3()
      for (const g of groups.values()) {
        const positions = new Float32Array(g.vertices * 3)
        const normals = new Float32Array(g.vertices * 3)
        const ids = new Float32Array(g.vertices)
        const highlight = new Uint8Array(g.vertices * 3)
        const index = new Uint32Array(g.indices)
        let vo = 0
        let io = 0
        const material = highlightMaterial(g.colour, g.baseOpacity)
        const m: Merged = { mesh: null as unknown as THREE.Mesh, material, positions, highlight: null as unknown as THREE.BufferAttribute, baseOpacity: g.baseOpacity, parts: [] }
        for (const s of g.sources) {
          const geometry = s.mesh.geometry as THREE.BufferGeometry
          const matrix = s.mesh.matrixWorld
          const flip = matrix.determinant() < 0
          const pos = geometry.getAttribute('position') as THREE.BufferAttribute
          let nor = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined
          if (!nor) {
            geometry.computeVertexNormals()
            nor = geometry.getAttribute('normal') as THREE.BufferAttribute
          }
          normalMatrix.getNormalMatrix(matrix)
          const partId = state.partsById.length
          const part: Part = { node: s.node, id: partId, structure: s.structure, merged: m, vertexStart: vo, vertexCount: s.count }
          state.partsById.push(part)
          parts.set(s.node, part)
          m.parts.push(part)
          for (let i = 0; i < s.count; i += 1) {
            v.fromBufferAttribute(pos, i).applyMatrix4(matrix)
            const o = (vo + i) * 3
            positions[o] = v.x; positions[o + 1] = v.y; positions[o + 2] = v.z
            box.expandByPoint(v)
            v.fromBufferAttribute(nor, i).applyMatrix3(normalMatrix).normalize()
            normals[o] = v.x; normals[o + 1] = v.y; normals[o + 2] = v.z
            ids[vo + i] = partId
          }
          if (geometry.index) {
            const src = geometry.index
            for (let i = 0; i < src.count; i += 3) {
              const a = src.getX(i) + vo, b = src.getX(i + 1) + vo, c = src.getX(i + 2) + vo
              index[io + i] = a
              index[io + i + 1] = flip ? c : b
              index[io + i + 2] = flip ? b : c
            }
          } else {
            for (let i = 0; i < s.count; i += 3) {
              index[io + i] = vo + i
              index[io + i + 1] = vo + (flip ? i + 2 : i + 1)
              index[io + i + 2] = vo + (flip ? i + 1 : i + 2)
            }
          }
          vo += s.count
          io += s.indexCount
          geometry.dispose()
        }
        const geometry = new THREE.BufferGeometry()
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
        geometry.setAttribute('aId', new THREE.BufferAttribute(ids, 1))
        const highlightAttribute = new THREE.BufferAttribute(highlight, 3, true)
        highlightAttribute.setUsage(THREE.DynamicDrawUsage)
        geometry.setAttribute('aHighlight', highlightAttribute)
        geometry.setIndex(new THREE.BufferAttribute(index, 1))
        geometry.computeBoundingSphere()
        const mesh = new THREE.Mesh(geometry, material)
        mesh.frustumCulled = false
        m.mesh = mesh
        m.highlight = highlightAttribute
        group.add(mesh)
        merged.push(m)
      }
      // Sheets draw after the opaque meshes of the layer.
      merged.sort((a, b) => b.baseOpacity - a.baseOpacity)
      merged.forEach((mm, i) => { mm.mesh.renderOrder = i })
      const labels = buildLabels(labelGroups(structures, id), parts)
      const index = LAYER_ORDER.indexOf(id)
      const { depth: d, seeThrough: xray } = latest.current
      const target = layerTarget(index, d, xray)
      const layerRecord: LayerRecord = {
        id, group, merged, parts, labels, box,
        opacity: latest.current.reducedMotion ? target : 0, target,
      }
      for (const mm of merged) applyOpacity(mm.material, layerRecord.opacity)
      group.visible = layerRecord.opacity > 0.001
      state.scene.add(group)
      state.layers.set(id, layerRecord)
      if (!state.bodyBox) state.bodyBox = box.clone()
      else state.bodyBox.union(box)
      if (!state.framed && (id === 'skin' || id === 'skeleton')) frameBody(state)
      loaded.push(id)
      state.needsRender = true
      state.layoutDirty = true
      applyHighlight(state, latest.current.selectedKey, latest.current.selectedNode, latest.current.highlightOrgan)
    }

    ;(async () => {
      try {
        for (const id of LOAD_ORDER) {
          if (generation !== state.generation) return
          await loadOne(id)
        }
        if (generation === state.generation) report(null)
      } catch (error) {
        if (generation === state.generation) report(null, error instanceof Error ? error.message : String(error))
      }
    })()
  }, [sex, manifest, structures])

  // ---- Depth / see-through / labels ------------------------------------------
  useEffect(() => {
    const state = refs.current
    if (!state) return
    LAYER_ORDER.forEach((id, index) => {
      const record = state.layers.get(id)
      if (!record) return
      record.target = layerTarget(index, depth, seeThrough)
      if (record.target > 0) record.group.visible = true
    })
    state.needsRender = true
    state.layoutDirty = true
    setExpanded(null)
  }, [depth, seeThrough])

  useEffect(() => {
    const state = refs.current
    if (!state) return
    state.layoutDirty = true
    state.needsRender = true
  }, [labelsOn, labelQuery, selectedKey, highlightOrgan])

  // ---- Highlight -------------------------------------------------------------
  useEffect(() => {
    const state = refs.current
    if (!state) return
    applyHighlight(state, selectedKey, selectedNode, highlightOrgan)
  }, [selectedNode, selectedKey, highlightOrgan, sex])

  // ---- Reset view ------------------------------------------------------------
  useEffect(() => {
    const state = refs.current
    if (!state || resetToken === 0) return
    state.framed = false
    frameBody(state)
  }, [resetToken])

  // ---- Full screen in / out: refit the distance to the new stage, keep the rotation
  const fullscreenSeen = useRef(fullscreen)
  useEffect(() => {
    const state = refs.current
    if (!state || fullscreenSeen.current === fullscreen) return
    fullscreenSeen.current = fullscreen
    // The stage resizes a frame later; refit once the observer has measured it.
    const id = window.setTimeout(() => {
      if (state.framed && state.bodyBox) fitDistance(state, true)
    }, 60)
    return () => window.clearTimeout(id)
  }, [fullscreen])

  useEffect(() => {
    const state = refs.current
    if (state) state.controls.enableDamping = !reducedMotion
  }, [reducedMotion])

  return (
    <div className="anatomy-viewer" ref={mountRef}>
      <svg className="anatomy-diagram-leaders anatomy-viewer-leaders" ref={leadersRef} aria-hidden="true">
        {!compact && shown.map((p) => (
          <line
            key={p.key}
            ref={(element) => {
              if (element) lineElements.current.set(p.key, element)
              else lineElements.current.delete(p.key)
            }}
            x1={p.lx}
            y1={p.ly}
            x2={p.lx}
            y2={p.ly}
          />
        ))}
      </svg>
      <div className="anatomy-pins" ref={overlayRef} aria-label="Labels of the current layer">
        {shown.map((item) => {
          const active = (selectedKey !== null && item.group.key === selectedKey) || (highlightOrgan !== null && item.organ === highlightOrgan)
          const isExpanded = !compact || expanded === item.key || active
          return (
            <button
              key={item.key}
              type="button"
              className={`anatomy-pin${isExpanded ? ' is-expanded' : ''}${active ? ' is-active' : ''}${item.group.fitted ? ' is-fitted' : ''}${!compact && item.side === 'left' ? ' is-margin-left' : ''}`}
              style={compact ? undefined : { transform: `translate(${item.lx.toFixed(1)}px, ${item.ly.toFixed(1)}px)` }}
              ref={(element) => {
                if (element) labelElements.current.set(item.key, element)
                else labelElements.current.delete(item.key)
              }}
              aria-label={item.group.fitted ? `${item.label} (fitted from the male model)` : item.label}
              title={item.group.fitted ? `${item.label} (fitted from the male model)` : item.label}
              onClick={(event) => {
                event.stopPropagation()
                if (compact && expanded !== item.key && !active) {
                  setExpanded(item.key)
                  return
                }
                onLabelOpen(item.structure)
              }}
            >
              <span className="anatomy-pin-dot" aria-hidden="true" />
              <span className="anatomy-pin-label">{compact ? item.label : plateText(item)}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/** The plate's short form of a label: a muscle plate does not repeat the
    word "muscle" on every line (the full name stays in the title and the
    accessible name). */
function plateText(item: { label: string; group: LabelGroup }): string {
  if (item.group.layer !== 'muscles') return item.label
  return item.label.replace(/ muscle(?= \(|$)/, '')
}

/** Write the highlight colour of every structure that is selected, in the
    picked group or in the highlighted organ; clear the rest. */
function applyHighlight(state: SceneRefs, selectedKey: string | null, selectedNode: string | null, highlightOrgan: string | null): void {
  const bytes = (c: THREE.Color): [number, number, number] => [
    Math.min(255, Math.round(c.r * 255)), Math.min(255, Math.round(c.g * 255)), Math.min(255, Math.round(c.b * 255)),
  ]
  const selected = bytes(HIGHLIGHT.selected)
  const group = bytes(HIGHLIGHT.group)
  const organ = bytes(HIGHLIGHT.organ)
  for (const record of state.layers.values()) {
    for (const m of record.merged) {
      const array = m.highlight.array as Uint8Array
      let dirty = m.mesh.userData.highlighted === true
      let any = false
      if (dirty) array.fill(0)
      if (selectedNode || highlightOrgan || selectedKey) {
        for (const part of m.parts) {
          const structure = part.structure
          const isSelected = selectedNode !== null && part.node === selectedNode
          const inGroup = selectedKey !== null && structure !== null && `${structure.layer}:${groupNameOf(structure.name)}` === selectedKey
          const inOrgan = highlightOrgan !== null && structure?.organ === highlightOrgan
          if (!isSelected && !inOrgan && !inGroup) continue
          const colour = isSelected ? selected : inGroup ? group : organ
          const start = part.vertexStart * 3
          const end = start + part.vertexCount * 3
          for (let i = start; i < end; i += 3) {
            array[i] = colour[0]; array[i + 1] = colour[1]; array[i + 2] = colour[2]
          }
          any = true
          dirty = true
        }
      }
      if (dirty) {
        m.highlight.needsUpdate = true
        m.mesh.userData.highlighted = any
      }
    }
  }
  state.needsRender = true
}

/** The camera distance at which the body's box fills the stage (height or width, whichever binds). */
function fitDistanceFor(state: SceneRefs): number {
  const size = state.bodyBox!.getSize(new THREE.Vector3())
  const tanHalf = Math.tan((FOV * Math.PI) / 360)
  const byHeight = size.y / 2 / tanHalf
  const byWidth = Math.max(size.x, size.z) / 2 / (tanHalf * Math.max(0.2, state.camera.aspect))
  return Math.max(byHeight, byWidth) * 1.12
}

/** Refit the distance only: the rotation and target stay. A resize keeps the
    reader's zoom ratio; full screen in/out (`reset`) refits like Reset view. */
function fitDistance(state: SceneRefs, reset = false): void {
  if (!state.bodyBox) return
  const distance = fitDistanceFor(state)
  const direction = state.camera.position.clone().sub(state.controls.target)
  const current = direction.length()
  if (current < 1e-6) return
  const previous = (state.camera.userData.fitDistance as number | undefined) ?? current
  const ratio = reset ? 1 : current / previous
  state.camera.position.copy(state.controls.target).add(direction.multiplyScalar((distance * ratio) / current))
  state.camera.userData.fitDistance = distance
  state.camera.near = distance / 100
  state.camera.far = distance * 20
  state.camera.updateProjectionMatrix()
  state.controls.minDistance = distance * 0.08
  state.controls.maxDistance = distance * 2.5
  state.controls.update()
  state.needsRender = true
  state.layoutDirty = true
}

function frameBody(state: SceneRefs): void {
  if (!state.bodyBox) return
  const centre = state.bodyBox.getCenter(new THREE.Vector3())
  const distance = fitDistanceFor(state)
  state.camera.userData.fitDistance = distance
  state.camera.near = distance / 100
  state.camera.far = distance * 20
  state.camera.updateProjectionMatrix()
  state.camera.position.set(centre.x, centre.y, centre.z + distance)
  state.controls.target.copy(centre)
  state.controls.minDistance = distance * 0.08
  state.controls.maxDistance = distance * 2.5
  state.controls.update()
  state.framed = true
  state.needsRender = true
  state.layoutDirty = true
}
