import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

import { canvasPixelRatio } from '../../lib/device'
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
 * The 3-D body (round 12, DATA_DECISIONS.md §65; round 13, §66).
 *
 * One registered model per sex, six layers ordered bone -> flesh, every
 * structure its own named mesh. The depth control shows layers 0..depth;
 * the layer AT the depth is the one the reader is looking at, and with
 * "see-through" on it is drawn translucent so the layer beneath shows
 * through it, in the same model space, so the layers sit flush.
 *
 * Orbit: one finger / left drag rotates, pinch / wheel zooms, two-finger
 * / right drag pans (OrbitControls with damping). A tap or click that did
 * not drag raycasts the visible, non-translucent layers and reports the
 * structure under the pointer.
 *
 * Labels (round 13): every named structure group of the labelled layer
 * has a label anchored at its bounding-box centre (both sides merged when
 * they sit together, "Humerus (left)" / "(right)" when apart). Which
 * labels show depends on the zoom: a label is a candidate when its
 * structure would span at least LABEL_MIN_PX on screen, candidates are
 * ranked by that size (entries with a site organ entry first, structures
 * that the diagram ID pass never sees from outside last) and placed
 * greedily without overlaps up to a cap, so at rest the major parts of
 * the layer are named and zooming in names progressively everything. A
 * search string bypasses the density rule and shows every match.
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
const LABEL_MIN_PX = { desktop: 14, compact: 20 }
const LABEL_MAX = { desktop: 40, compact: 18 }
const LABEL_SEARCH_MAX = 80
const LAYOUT_INTERVAL_MS = 90

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

interface LabelRecord extends LabelItem {
  /** For a side pair: 'left' | 'right'; for the merged pair label: 'both'. */
  pair: 'left' | 'right' | 'both' | null
  /** Priority tier: 0 curated major part, 1 structure, 2 sub-part. */
  tier: number
  anchor: THREE.Vector3
  /** Bounding-box diagonal in metres (the fallback size when the diagram pass never saw it). */
  size: number
  /** Visible area in the diagram ID pass as the side of an equivalent square, in
      metres: the importance a reader perceives (a rib cage outranks a ligament of
      the same length); null when no diagram data is available. */
  blob: number | null
}

interface LayerRecord {
  id: LayerId
  group: THREE.Group
  materials: THREE.MeshStandardMaterial[]
  meshes: THREE.Mesh[]
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
  raycaster: THREE.Raycaster
  layers: Map<LayerId, LayerRecord>
  bodyBox: THREE.Box3 | null
  framed: boolean
  generation: number
  lastFrame: number
  highlighted: THREE.Mesh[]
  layoutDirty: boolean
  lastLayout: number
  shownKeys: string
  flipped: Set<string>
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
  for (const mesh of record.meshes) mesh.geometry.dispose()
  for (const material of record.materials) material.dispose()
}

/** The label set of a layer: one per structure group, or one per side when apart. */
function buildLabels(
  groups: LabelGroup[],
  boxes: Map<string, THREE.Box3>,
  visibility: Map<string, number> | null,
  metresPerDiagramPixel: number,
): LabelRecord[] {
  const out: LabelRecord[] = []
  const make = (key: string, label: string, group: LabelGroup, nodes: ModelStructure[], pair: LabelRecord['pair'] = null): void => {
    const box = new THREE.Box3()
    let px = 0
    for (const s of nodes) {
      const b = boxes.get(s.node)
      if (b) box.union(b)
      if (visibility) px += visibility.get(s.node) ?? 0
    }
    if (box.isEmpty()) return
    out.push({
      key,
      label,
      group,
      nodes: nodes.map((s) => s.node),
      organ: group.organ,
      structure: nodes[0]!,
      pair,
      tier: labelPriority(group.layer, group.name, group.organ),
      anchor: box.getCenter(new THREE.Vector3()),
      size: box.getSize(new THREE.Vector3()).length(),
      blob: visibility ? Math.sqrt(px / 2) * metresPerDiagramPixel : null,
    })
  }
  for (const group of groups) {
    const left = group.nodes.filter((s) => structureSide(s.name) === 'left')
    const right = group.nodes.filter((s) => structureSide(s.name) === 'right')
    const unsided = group.nodes.filter((s) => structureSide(s.name) === null)
    if (left.length && right.length && unsided.length === 0) {
      const lb = new THREE.Box3()
      const rb = new THREE.Box3()
      for (const s of left) { const b = boxes.get(s.node); if (b) lb.union(b) }
      for (const s of right) { const b = boxes.get(s.node); if (b) rb.union(b) }
      if (!lb.isEmpty() && !rb.isEmpty()) {
        const gap = Math.max(lb.min.x - rb.max.x, rb.min.x - lb.max.x)
        const width = Math.max(lb.max.x - lb.min.x, rb.max.x - rb.min.x)
        if (gap > 0.05 && gap > width * 0.6) {
          make(`${group.key}:left`, `${group.name} (left)`, group, left, 'left')
          make(`${group.key}:right`, `${group.name} (right)`, group, right, 'right')
          // The merged form, used when the two would collide on screen.
          make(`${group.key}:both`, `${group.name} (left/right)`, group, group.nodes, 'both')
          continue
        }
      }
    }
    make(group.key, group.name, group, group.nodes)
  }
  return out
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
  const refs = useRef<SceneRefs | null>(null)
  const labelElements = useRef(new Map<string, HTMLElement>())
  const [shown, setShown] = useState<LabelRecord[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const latest = useRef({ depth, seeThrough, onPick, onLoadState, reducedMotion, structures, labelsOn, labelQuery, selectedKey, highlightOrgan, compact, diagrams, sex })
  latest.current = { depth, seeThrough, onPick, onLoadState, reducedMotion, structures, labelsOn, labelQuery, selectedKey, highlightOrgan, compact, diagrams, sex }

  // ---- Scene lifetime -----------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const width = Math.max(1, mount.clientWidth)
    const height = Math.max(1, mount.clientHeight)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' })
    renderer.setPixelRatio(canvasPixelRatio())
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
    controls.dampingFactor = 0.08
    controls.enablePan = true
    controls.screenSpacePanning = true
    controls.rotateSpeed = 0.7
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
      raycaster: new THREE.Raycaster(),
      layers: new Map(),
      bodyBox: null,
      framed: false,
      generation: 0,
      lastFrame: performance.now(),
      highlighted: [],
      layoutDirty: true,
      lastLayout: 0,
      shownKeys: '',
      flipped: new Set(),
    }
    refs.current = state
    controls.addEventListener('change', () => {
      state.layoutDirty = true
    })

    // Picking: a press that neither travelled nor lingered is a pick.
    let press: { x: number; y: number; t: number; id: number } | null = null
    const onDown = (event: PointerEvent) => {
      if (!event.isPrimary) return
      press = { x: event.clientX, y: event.clientY, t: performance.now(), id: event.pointerId }
    }
    const onUp = (event: PointerEvent) => {
      if (!press || press.id !== event.pointerId) return
      const moved = Math.hypot(event.clientX - press.x, event.clientY - press.y)
      const held = performance.now() - press.t
      press = null
      if (moved > 6 || held > 600) return
      const rect = renderer.domElement.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      state.raycaster.setFromCamera(ndc, camera)
      const { depth: d, seeThrough: xray, structures: list } = latest.current
      const candidates: THREE.Object3D[] = []
      LAYER_ORDER.forEach((id, index) => {
        if (index > d) return
        if (xray && index === d && d > 0) return
        const record = state.layers.get(id)
        if (record && record.group.visible) candidates.push(record.group)
      })
      // Prefer an opaque structure under the pointer over a translucent sheet.
      const hits = state.raycaster.intersectObjects(candidates, true)
      const hit = hits.find((h) => (((h.object as THREE.Mesh).material as THREE.Material)?.userData.baseOpacity ?? 1) >= 1) ?? hits[0]
      if (!hit) {
        latest.current.onPick(null)
        return
      }
      const node = (hit.object.userData.name as string | undefined) ?? hit.object.name
      const structure = list.find((s) => s.node === node) ?? null
      latest.current.onPick(structure)
    }
    const onCancel = () => {
      press = null
    }
    renderer.domElement.addEventListener('pointerdown', onDown)
    renderer.domElement.addEventListener('pointerup', onUp)
    renderer.domElement.addEventListener('pointercancel', onCancel)

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
      state.layoutDirty = true
    }
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    // Render loop: damping, opacity fades, label layout and projection.
    const projected = new THREE.Vector3()
    const toCamera = new THREE.Vector3()
    const radial = new THREE.Vector3()
    let frame = 0
    const tick = () => {
      frame = requestAnimationFrame(tick)
      const now = performance.now()
      const dt = Math.min(0.1, (now - state.lastFrame) / 1000)
      state.lastFrame = now
      controls.update()
      for (const record of state.layers.values()) {
        if (record.opacity !== record.target) {
          const step = latest.current.reducedMotion ? 1 : dt / FADE_SECONDS
          record.opacity = record.opacity < record.target
            ? Math.min(record.target, record.opacity + step)
            : Math.max(record.target, record.opacity - step)
          for (const material of record.materials) applyOpacity(material, record.opacity)
          record.group.visible = record.opacity > 0.001
        }
      }
      renderer.render(scene, camera)
      if ((now | 0) % 500 < 20) mount.dataset.cam = `${camera.position.distanceTo(controls.target).toFixed(3)} fit ${((camera.userData.fitDistance as number | undefined) ?? 0).toFixed(3)} aspect ${camera.aspect.toFixed(2)}`

      const overlay = overlayRef.current
      const { depth: d, seeThrough: xray, labelsOn: on, labelQuery: query, selectedKey: sel, highlightOrgan: organ, compact: small } = latest.current
      const labelled = state.layers.get(LAYER_ORDER[xray && d > 0 ? d - 1 : d] ?? 'skin')
      if (!overlay || !labelled || !state.bodyBox) return
      const w = overlay.clientWidth
      const h = overlay.clientHeight
      const centre = state.bodyBox.getCenter(new THREE.Vector3())

      // Layout (throttled): choose which labels to show for this camera.
      if (state.layoutDirty && now - state.lastLayout > LAYOUT_INTERVAL_MS) {
        state.layoutDirty = false
        state.lastLayout = now
        const q = query.trim().toLowerCase()
        const minPx = small ? LABEL_MIN_PX.compact : LABEL_MIN_PX.desktop
        const cap = q ? LABEL_SEARCH_MAX : small ? LABEL_MAX.compact : LABEL_MAX.desktop
        const tanHalf = Math.tan((camera.fov * Math.PI) / 360)
        const candidates: { item: LabelRecord; x: number; y: number; score: number; forced: boolean }[] = []
        if (on || q || sel || organ) {
          for (const item of labelled.labels) {
            const forced = sel !== null && item.group.key === sel
            const boosted = organ !== null && item.organ === organ
            if (!on && !q && !forced && !boosted) continue
            if (q && !item.label.toLowerCase().includes(q) && !forced) continue
            projected.copy(item.anchor).project(camera)
            if (projected.z >= 1 || Math.abs(projected.x) > 1.02 || Math.abs(projected.y) > 1.02) continue
            // Facing: is the anchor on the camera's side of the body's axis at that height?
            toCamera.copy(camera.position).sub(item.anchor).normalize()
            radial.set(item.anchor.x - centre.x, 0, item.anchor.z - centre.z)
            const r = radial.length()
            const facing = r < 0.03 ? 1 : radial.divideScalar(r).dot(toCamera)
            if (facing < (q ? -0.55 : -0.2) && !forced) continue
            const dist = camera.position.distanceTo(item.anchor)
            // Screen size: the visible blob from the diagram pass where it exists
            // (what a reader sees), else a third of the bounding box (thin or
            // hidden structures), both scaled by the camera distance.
            const pxPerMetre = (h / 2) / (dist * tanHalf)
            const px = item.blob !== null && item.blob > 0 ? item.blob * pxPerMetre : item.size * 0.33 * pxPerMetre
            if (!q && !forced && px < minPx * (item.tier === 0 ? 0.5 : 1)) continue
            const score = px * (item.organ ? 1.3 : 1) * (boosted ? 2.5 : 1) * (facing > 0.3 ? 1.2 : 1)
            candidates.push({ item, x: ((projected.x + 1) / 2) * w, y: ((1 - projected.y) / 2) * h, score: forced ? Infinity : score, forced })
          }
        }
        // Rank: forced first, then the curated tier (major parts before
        // structures before sub-parts), then by size on screen.
        candidates.sort((a, b) => (a.forced !== b.forced ? (a.forced ? -1 : 1) : a.item.tier !== b.item.tier ? a.item.tier - b.item.tier : b.score - a.score))
        // Side pairs: the merged "(left/right)" form stands in when the two
        // would collide on screen; otherwise the pair's labels are laid out
        // on opposite sides of their anchors so they never overlap.
        const byKey = new Map(candidates.map((c) => [c.item.key, c]))
        const skip = new Set<string>()
        for (const c of candidates) {
          if (c.item.pair !== 'both') continue
          const baseKey = c.item.key.slice(0, -':both'.length)
          const l = byKey.get(`${baseKey}:left`)
          const r = byKey.get(`${baseKey}:right`)
          if (l && r) {
            const collide = Math.abs(l.x - r.x) < c.item.label.length * 6.6 + 40 && Math.abs(l.y - r.y) < 30
            if (collide) { skip.add(l.item.key); skip.add(r.item.key) } else skip.add(c.item.key)
          } else skip.add(c.item.key)
        }
        const boxes: { x0: number; y0: number; x1: number; y1: number }[] = []
        const chosen: LabelRecord[] = []
        const flipped = new Set<string>()
        for (const c of candidates) {
          if (skip.has(c.item.key)) continue
          if (chosen.length >= cap && !c.forced) break
          const width = small && !c.forced ? 22 : c.item.label.length * 6.6 + 34
          // A pair's two labels face away from each other (text on the outer side).
          let flip = false
          if (c.item.pair === 'left' || c.item.pair === 'right') {
            const otherKey = `${c.item.key.slice(0, c.item.key.lastIndexOf(':'))}:${c.item.pair === 'left' ? 'right' : 'left'}`
            const other = byKey.get(otherKey)
            flip = other !== undefined && c.x < other.x
          }
          const box = flip ? { x0: c.x - width, y0: c.y - 14, x1: c.x + 12, y1: c.y + 14 } : { x0: c.x - 12, y0: c.y - 14, x1: c.x + width, y1: c.y + 14 }
          if (!c.forced && boxes.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)) continue
          boxes.push(box)
          chosen.push(c.item)
          if (flip) flipped.add(c.item.key)
        }
        const keys = chosen.map((c) => (flipped.has(c.key) ? `${c.key}!` : c.key)).join('|')
        if (keys !== state.shownKeys) {
          state.shownKeys = keys
          state.flipped = flipped
          setShown(chosen)
        }
      }

      // Project the shown labels every frame.
      for (const [key2, element] of labelElements.current) {
        const item = labelled.labels.find((l) => l.key === key2)
        if (!item) {
          element.style.display = 'none'
          continue
        }
        projected.copy(item.anchor).project(camera)
        const visible = projected.z < 1 && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05
        element.style.display = visible ? '' : 'none'
        if (visible) {
          const x = ((projected.x + 1) / 2) * w
          const y = ((1 - projected.y) / 2) * h
          element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
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
      for (const record of state.layers.values()) disposeLayer(record)
      state.layers.clear()
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
    state.bodyBox = null
    state.highlighted = []
    state.shownKeys = ''
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
      const group = new THREE.Group()
      for (const gltf of gltfs) group.add(gltf.scene)
      group.name = `${sex}-${id}`
      const materials = new Map<number, THREE.MeshStandardMaterial>()
      const meshes: THREE.Mesh[] = []
      const boxes = new Map<string, THREE.Box3>()
      const box = new THREE.Box3()
      group.updateMatrixWorld(true)
      group.traverse((object) => {
        if (!(object as THREE.Mesh).isMesh) return
        const mesh = object as THREE.Mesh
        const node = (mesh.userData.name as string | undefined) ?? mesh.name
        mesh.userData.name = node
        const structure = byNode.get(node)
        const colour = structure ? colourFor(structure) : COLOURS.other
        const baseOpacity = structure ? baseOpacityFor(structure) : 1
        const materialKey = colour * 2 + (baseOpacity < 1 ? 1 : 0)
        let material = materials.get(materialKey)
        if (!material) {
          material = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.72, metalness: 0 })
          material.userData.baseOpacity = baseOpacity
          materials.set(materialKey, material)
        }
        mesh.material = material
        mesh.userData.baseMaterial = material
        mesh.userData.structure = structure ?? null
        const geometry = mesh.geometry as THREE.BufferGeometry
        if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
        geometry.computeBoundingBox()
        geometry.computeBoundingSphere()
        const world = geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld)
        box.union(world)
        const existing = boxes.get(node)
        if (existing) existing.union(world)
        else boxes.set(node, world)
        meshes.push(mesh)
      })
      // Visibility hint from the diagram ID pass: seen from the front or back?
      const dg = latest.current.diagrams?.sexes[sex]
      let visibility: Map<string, number> | null = null
      if (dg) {
        visibility = new Map()
        for (const view of ['front', 'back']) {
          const table = dg.anchors[`${id}-${view}`]
          if (!table) continue
          for (const [node, a] of Object.entries(table)) visibility.set(node, (visibility.get(node) ?? 0) + a[0])
        }
      }
      const dgBox = dg?.box
      const metresPerPixel = dg && dgBox ? ((dgBox.max[1]! - dgBox.min[1]!) * 1.03) / (latest.current.diagrams?.heightPx ?? 1600) : 0.001
      const labels = buildLabels(labelGroups(structures, id), boxes, visibility, metresPerPixel)
      const index = LAYER_ORDER.indexOf(id)
      const { depth: d, seeThrough: xray } = latest.current
      const target = layerTarget(index, d, xray)
      const layerRecord: LayerRecord = {
        id, group, materials: [...materials.values()], meshes, labels, box,
        opacity: latest.current.reducedMotion ? target : 0, target,
      }
      for (const material of layerRecord.materials) applyOpacity(material, layerRecord.opacity)
      group.visible = layerRecord.opacity > 0.001
      state.scene.add(group)
      state.layers.set(id, layerRecord)
      if (!state.bodyBox) state.bodyBox = box.clone()
      else state.bodyBox.union(box)
      if (!state.framed && (id === 'skin' || id === 'skeleton')) frameBody(state)
      loaded.push(id)
      state.layoutDirty = true
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
    state.layoutDirty = true
    state.lastLayout = 0
    setExpanded(null)
  }, [depth, seeThrough])

  useEffect(() => {
    const state = refs.current
    if (!state) return
    state.layoutDirty = true
    state.lastLayout = 0
  }, [labelsOn, labelQuery, selectedKey, highlightOrgan])

  // ---- Highlight -------------------------------------------------------------
  useEffect(() => {
    const state = refs.current
    if (!state) return
    for (const mesh of state.highlighted) mesh.material = mesh.userData.baseMaterial as THREE.Material
    state.highlighted = []
    if (!selectedNode && !highlightOrgan && !selectedKey) return
    for (const record of state.layers.values()) {
      for (const mesh of record.meshes) {
        const structure = mesh.userData.structure as ModelStructure | null
        const node = mesh.userData.name as string
        const isSelected = selectedNode !== null && node === selectedNode
        const inGroup = selectedKey !== null && structure !== null && `${structure.layer}:${groupNameOf(structure.name)}` === selectedKey
        const inOrgan = highlightOrgan !== null && structure?.organ === highlightOrgan
        if (!isSelected && !inOrgan && !inGroup) continue
        const base = mesh.userData.baseMaterial as THREE.MeshStandardMaterial
        const glow = base.clone()
        glow.emissive = new THREE.Color(isSelected ? 0xffc83d : inGroup ? 0xffd27a : 0xffa65c)
        glow.emissiveIntensity = isSelected ? 0.75 : inGroup ? 0.5 : 0.35
        mesh.material = glow
        state.highlighted.push(mesh)
      }
    }
    return () => {
      // Materials cloned for the highlight are released when it changes.
      for (const mesh of state.highlighted) (mesh.material as THREE.Material).dispose()
    }
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
      <div className="anatomy-pins" ref={overlayRef} aria-label="Labels of the current layer">
        {shown.map((item) => {
          const active = (selectedKey !== null && item.group.key === selectedKey) || (highlightOrgan !== null && item.organ === highlightOrgan)
          const isExpanded = !compact || expanded === item.key || active
          return (
            <button
              key={item.key}
              type="button"
              className={`anatomy-pin${isExpanded ? ' is-expanded' : ''}${active ? ' is-active' : ''}${item.group.fitted ? ' is-fitted' : ''}${refs.current?.flipped.has(item.key) ? ' is-flip' : ''}`}
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
              <span className="anatomy-pin-label">{item.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
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
  state.layoutDirty = true
}
