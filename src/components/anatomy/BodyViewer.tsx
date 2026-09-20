import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'

import { canvasPixelRatio } from '../../lib/device'
import {
  LAYER_ORDER,
  anatomyModelUrl,
  type LayerId,
  type ModelManifest,
  type ModelStructure,
  type Sex,
} from '../../lib/anatomy'

/**
 * The 3-D body (round 12, DATA_DECISIONS.md §62).
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
 * structure under the pointer. Pins for the entries of the current layer
 * are projected every frame into an HTML overlay.
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

export interface Pin {
  organ: string
  label: string
}

interface Props {
  sex: Sex
  manifest: ModelManifest
  structures: ModelStructure[]
  depth: number
  seeThrough: boolean
  selectedNode: string | null
  highlightOrgan: string | null
  organNames: Map<string, string>
  onPick: (structure: ModelStructure | null) => void
  onPinOpen: (organ: string) => void
  onLoadState: (state: LoadState) => void
  resetToken: number
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

interface LayerRecord {
  id: LayerId
  group: THREE.Group
  materials: THREE.MeshStandardMaterial[]
  meshes: THREE.Mesh[]
  /** Anchor per organ entry: centre of the union box of its meshes. */
  anchors: Map<string, THREE.Vector3>
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
}

function disposeLayer(record: LayerRecord): void {
  record.group.removeFromParent()
  for (const mesh of record.meshes) mesh.geometry.dispose()
  for (const material of record.materials) material.dispose()
}

export default function BodyViewer({
  sex,
  manifest,
  structures,
  depth,
  seeThrough,
  selectedNode,
  highlightOrgan,
  organNames,
  onPick,
  onPinOpen,
  onLoadState,
  resetToken,
  reducedMotion,
  compact,
}: Props) {
  const mountRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const refs = useRef<SceneRefs | null>(null)
  const pinElements = useRef(new Map<string, HTMLElement>())
  const [pins, setPins] = useState<Pin[]>([])
  const [expandedPin, setExpandedPin] = useState<string | null>(null)
  const latest = useRef({ depth, seeThrough, onPick, onLoadState, reducedMotion, structures, organNames })
  latest.current = { depth, seeThrough, onPick, onLoadState, reducedMotion, structures, organNames }

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
    }
    refs.current = state

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
      const hit = state.raycaster.intersectObjects(candidates, true)[0]
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
    }
    const observer = new ResizeObserver(resize)
    observer.observe(mount)

    // Render loop: damping, opacity fades, pin projection.
    const centre = new THREE.Vector3()
    const toCamera = new THREE.Vector3()
    const projected = new THREE.Vector3()
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
          const translucent = record.opacity < 0.999
          for (const material of record.materials) {
            material.opacity = record.opacity
            material.transparent = translucent
            material.depthWrite = !translucent
            material.needsUpdate = false
          }
          record.group.visible = record.opacity > 0.001
        }
      }
      renderer.render(scene, camera)

      // Pins: project the current layer's anchors; hide those on the far side.
      const overlay = overlayRef.current
      const current = state.layers.get(LAYER_ORDER[latest.current.depth] ?? 'skin')
      if (overlay && current && state.bodyBox) {
        state.bodyBox.getCenter(centre)
        toCamera.copy(camera.position).sub(centre).normalize()
        const w = overlay.clientWidth
        const h = overlay.clientHeight
        const radius = state.bodyBox.getSize(new THREE.Vector3()).length() / 2
        const placed: { element: HTMLElement; x: number; y: number }[] = []
        for (const [organ, element] of pinElements.current) {
          const anchor = current.anchors.get(organ)
          if (!anchor) {
            element.style.display = 'none'
            continue
          }
          projected.copy(anchor).sub(centre)
          const facing = projected.dot(toCamera) / Math.max(radius, 1e-6)
          projected.copy(anchor).project(camera)
          const visible = facing > -0.12 && projected.z < 1 && Math.abs(projected.x) < 1.05 && Math.abs(projected.y) < 1.05
          element.style.display = visible ? '' : 'none'
          if (visible) {
            const x = ((projected.x + 1) / 2) * w
            const y = ((1 - projected.y) / 2) * h
            element.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`
            placed.push({ element, x, y })
          }
        }
        // Declutter: labels are laid out top to bottom; one whose box would
        // overlap an already placed label collapses to its dot (hover or
        // the active entry still shows it). Cheap for a few dozen pins.
        placed.sort((a, b) => a.y - b.y || a.x - b.x)
        const boxes: { x0: number; y0: number; x1: number; y1: number }[] = []
        for (const pin of placed) {
          const label = pin.element.querySelector<HTMLElement>('.anatomy-pin-label')
          const width = (label?.offsetWidth || 90) + 30
          const box = { x0: pin.x - 11, y0: pin.y - 13, x1: pin.x + width, y1: pin.y + 13 }
          const collides = boxes.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0)
          const active = pin.element.classList.contains('is-active')
          if (collides && !active) pin.element.classList.add('is-collapsed')
          else {
            pin.element.classList.remove('is-collapsed')
            boxes.push(box)
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
    setPins([])
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
      // A layer may carry supplement files under their own licence (round
      // 12: the female stomach and oesophagus); they draw with the layer.
      const files = [layer.file, ...(layer.supplements ?? []).map((s) => s.file)]
      const gltfs = await Promise.all(files.map((file) => loader.loadAsync(anatomyModelUrl(file))))
      if (generation !== state.generation) return
      const group = new THREE.Group()
      for (const gltf of gltfs) group.add(gltf.scene)
      group.name = `${sex}-${id}`
      const materials = new Map<number, THREE.MeshStandardMaterial>()
      const meshes: THREE.Mesh[] = []
      const organBoxes = new Map<string, THREE.Box3>()
      const box = new THREE.Box3()
      group.updateMatrixWorld(true)
      group.traverse((object) => {
        if (!(object as THREE.Mesh).isMesh) return
        const mesh = object as THREE.Mesh
        const node = (mesh.userData.name as string | undefined) ?? mesh.name
        mesh.userData.name = node
        const structure = byNode.get(node)
        const colour = structure ? colourFor(structure) : COLOURS.other
        let material = materials.get(colour)
        if (!material) {
          material = new THREE.MeshStandardMaterial({ color: colour, roughness: 0.72, metalness: 0 })
          materials.set(colour, material)
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
        if (structure?.organ) {
          const existing = organBoxes.get(structure.organ)
          if (existing) existing.union(world)
          else organBoxes.set(structure.organ, world)
        }
        meshes.push(mesh)
      })
      const anchors = new Map<string, THREE.Vector3>()
      for (const [organ, organBox] of organBoxes) anchors.set(organ, organBox.getCenter(new THREE.Vector3()))
      const index = LAYER_ORDER.indexOf(id)
      const { depth: d, seeThrough: xray } = latest.current
      const target = index > d ? 0 : xray && index === d && d > 0 ? TRANSLUCENT_OPACITY : 1
      const layerRecord: LayerRecord = {
        id, group, materials: [...materials.values()], meshes, anchors, box,
        opacity: latest.current.reducedMotion ? target : 0, target,
      }
      for (const material of layerRecord.materials) {
        material.opacity = layerRecord.opacity
        material.transparent = layerRecord.opacity < 0.999
        material.depthWrite = !material.transparent
      }
      group.visible = layerRecord.opacity > 0.001
      state.scene.add(group)
      state.layers.set(id, layerRecord)
      if (!state.bodyBox) state.bodyBox = box.clone()
      else state.bodyBox.union(box)
      if (!state.framed && (id === 'skin' || id === 'skeleton')) frameBody(state)
      loaded.push(id)
      if (LAYER_ORDER[latest.current.depth] === id) refreshPins(state, latest.current.depth, latest.current.organNames, setPins)
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

  // ---- Depth / see-through -------------------------------------------------
  useEffect(() => {
    const state = refs.current
    if (!state) return
    LAYER_ORDER.forEach((id, index) => {
      const record = state.layers.get(id)
      if (!record) return
      record.target = index > depth ? 0 : seeThrough && index === depth && depth > 0 ? TRANSLUCENT_OPACITY : 1
      if (record.target > 0) record.group.visible = true
    })
    refreshPins(state, depth, organNames, setPins)
    setExpandedPin(null)
  }, [depth, seeThrough, organNames])

  // ---- Highlight -------------------------------------------------------------
  useEffect(() => {
    const state = refs.current
    if (!state) return
    for (const mesh of state.highlighted) mesh.material = mesh.userData.baseMaterial as THREE.Material
    state.highlighted = []
    if (!selectedNode && !highlightOrgan) return
    for (const record of state.layers.values()) {
      for (const mesh of record.meshes) {
        const structure = mesh.userData.structure as ModelStructure | null
        const node = mesh.userData.name as string
        const isSelected = selectedNode !== null && node === selectedNode
        const inOrgan = highlightOrgan !== null && structure?.organ === highlightOrgan
        if (!isSelected && !inOrgan) continue
        const base = mesh.userData.baseMaterial as THREE.MeshStandardMaterial
        const glow = base.clone()
        glow.emissive = new THREE.Color(isSelected ? 0xffc83d : 0xffa65c)
        glow.emissiveIntensity = isSelected ? 0.75 : 0.35
        mesh.material = glow
        state.highlighted.push(mesh)
      }
    }
    return () => {
      // Materials cloned for the highlight are released when it changes.
      for (const mesh of state.highlighted) (mesh.material as THREE.Material).dispose()
    }
  }, [selectedNode, highlightOrgan, sex])

  // ---- Reset view ------------------------------------------------------------
  useEffect(() => {
    const state = refs.current
    if (!state || resetToken === 0) return
    state.framed = false
    frameBody(state)
  }, [resetToken])

  useEffect(() => {
    const state = refs.current
    if (state) state.controls.enableDamping = !reducedMotion
  }, [reducedMotion])

  return (
    <div className="anatomy-viewer" ref={mountRef}>
      <div className="anatomy-pins" ref={overlayRef} aria-label="Labels of the current layer">
        {pins.map((pin) => {
          const expanded = !compact || expandedPin === pin.organ
          return (
            <button
              key={pin.organ}
              type="button"
              className={`anatomy-pin${expanded ? ' is-expanded' : ''}${highlightOrgan === pin.organ ? ' is-active' : ''}`}
              ref={(element) => {
                if (element) pinElements.current.set(pin.organ, element)
                else pinElements.current.delete(pin.organ)
              }}
              aria-label={pin.label}
              title={pin.label}
              onClick={(event) => {
                event.stopPropagation()
                if (compact && expandedPin !== pin.organ) {
                  setExpandedPin(pin.organ)
                  return
                }
                onPinOpen(pin.organ)
              }}
            >
              <span className="anatomy-pin-dot" aria-hidden="true" />
              <span className="anatomy-pin-label">{pin.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function frameBody(state: SceneRefs): void {
  if (!state.bodyBox) return
  const size = state.bodyBox.getSize(new THREE.Vector3())
  const centre = state.bodyBox.getCenter(new THREE.Vector3())
  const height = Math.max(size.y, size.x, size.z)
  const distance = (height / 2 / Math.tan((FOV * Math.PI) / 360)) * 1.12
  state.camera.near = distance / 100
  state.camera.far = distance * 20
  state.camera.updateProjectionMatrix()
  state.camera.position.set(centre.x, centre.y, centre.z + distance)
  state.controls.target.copy(centre)
  state.controls.minDistance = distance * 0.12
  state.controls.maxDistance = distance * 2.5
  state.controls.update()
  state.framed = true
}

function refreshPins(
  state: SceneRefs,
  depth: number,
  organNames: Map<string, string>,
  setPins: (pins: Pin[]) => void,
): void {
  const record = state.layers.get(LAYER_ORDER[depth] ?? 'skin')
  if (!record) {
    setPins([])
    return
  }
  const next: Pin[] = []
  for (const organ of record.anchors.keys()) {
    const label = organNames.get(organ)
    if (label) next.push({ organ, label })
  }
  next.sort((a, b) => a.label.localeCompare(b.label))
  setPins(next)
}
