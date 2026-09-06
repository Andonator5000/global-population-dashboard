import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import { BodyPanel, MoonPanel } from '../components/space/BodyPanels'
import { Unavailable } from '../components/viz/primitives'
import { DATA_BASE_URL } from '../config'
import {
  featureTypeGloss,
  loadMoons,
  loadNomenclature,
  useSpaceBodies,
  type MoonRecord,
  type NomenclatureFeature,
  type SpaceBody,
} from '../lib/space'

/**
 * /space/solar-system — the interactive 3D Solar System (round-2 §41),
 * replacing the static SVG diagram.
 *
 * A three.js scene: orbit/rotate/zoom with mouse and touch, animated
 * orbits with play/pause and a time-scale control, the labelled
 * true-vs-compressed scale toggle, click-to-fly-to any body, belts as
 * particle fields, and the major moons of the selected planet in orbit
 * around it. Selecting a body opens the data panel; "Open 3D globe"
 * switches to a navigable textured globe of that body — and for the
 * Moon, Mars, Venus and Mercury the globe streams NASA Solar System
 * Treks tiles for deep zoom (a documented runtime exception, §41.2) and
 * overlays named IAU features. prefers-reduced-motion starts the scene
 * paused.
 *
 * The whole page is code-split (React.lazy in App.tsx) so three.js never
 * weighs down the rest of the site.
 */

const AU_UNITS_TRUE = 1.15
const MIN_AU = 0.28
const MAX_AU = 72

const BODY_COLORS: Record<string, number> = {
  sun: 0xf3c54c, mercury: 0x9c9489, venus: 0xd9b98a, earth: 0x4a7fc1,
  mars: 0xb5623c, jupiter: 0xc4a077, saturn: 0xd9c391, uranus: 0x8fc4cc,
  neptune: 0x4c6fbf, pluto: 0xb9a48e, ceres: 0x8f8a82, eris: 0xcfcac2,
  haumea: 0xc9c3ba, makemake: 0xb58d6c, moon: 0xa6a6a6,
}

const SPEEDS = [
  { label: '1 day/s', daysPerSecond: 1 },
  { label: '10 days/s', daysPerSecond: 10 },
  { label: '100 days/s', daysPerSecond: 100 },
  { label: '1 year/s', daysPerSecond: 365.25 },
] as const

function orbitRadius(au: number, mode: 'compressed' | 'true'): number {
  const clamped = Math.max(MIN_AU, Math.min(MAX_AU, au))
  if (mode === 'true') return clamped * AU_UNITS_TRUE
  return 8 + 30 * (Math.log(clamped / MIN_AU) / Math.log(MAX_AU / MIN_AU))
}

function bodyRadius(
  radiusKm: number | null | undefined,
  mode: 'compressed' | 'true',
): number {
  if (!radiusKm) return 0.3
  if (mode === 'true') {
    return Math.max(0.02, (radiusKm / 149_597_870.7) * AU_UNITS_TRUE)
  }
  return Math.max(0.32, Math.min(2.1, 0.052 * Math.cbrt(radiusKm)))
}

function labelSprite(text: string, small = false): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const scale = 2
  const font = `${(small ? 11 : 13) * scale}px "Public Sans", sans-serif`
  const ctx = canvas.getContext('2d')!
  ctx.font = font
  const width = Math.ceil(ctx.measureText(text).width) + 12 * scale
  canvas.width = width
  canvas.height = 20 * scale
  const ctx2 = canvas.getContext('2d')!
  ctx2.font = font
  ctx2.fillStyle = 'rgba(8, 10, 16, 0.55)'
  ctx2.fillRect(0, 0, canvas.width, canvas.height)
  ctx2.fillStyle = 'rgba(255, 255, 255, 0.92)'
  ctx2.textBaseline = 'middle'
  ctx2.fillText(text, 6 * scale, canvas.height / 2)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: texture, depthTest: false }),
  )
  sprite.scale.set(canvas.width / (30 * scale), canvas.height / (30 * scale), 1)
  return sprite
}

interface SceneBody {
  body: SpaceBody
  mesh: THREE.Mesh
  pivot: THREE.Group
  au: number
  periodDays: number
  angle: number
}

// ---- card grid (round-2 feedback: a card per body under the 3D view) ----

const KIND_LABEL: Record<SpaceBody['kind'], string> = {
  star: 'star',
  planet: 'planet',
  dwarf: 'dwarf planet',
  moon: 'moon',
}

function fmtSci(value: number | null | undefined, unit: string): string {
  if (value == null) return 'not available'
  const exponent = Math.floor(Math.log10(Math.abs(value)))
  const mantissa = value / 10 ** exponent
  return `${mantissa.toFixed(2)}×10${superscript(exponent)} ${unit}`
}

function superscript(n: number): string {
  const digits: Record<string, string> = {
    '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
    '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻',
  }
  return String(n).split('').map((c) => digits[c] ?? c).join('')
}

function fmtKm(value: number | null | undefined): string {
  return value == null ? 'not available' : `${value.toLocaleString()} km`
}

function fmtHours(value: number | null | undefined): string {
  if (value == null) return 'not available'
  const abs = Math.abs(value)
  const note = value < 0 ? ' (retrograde)' : ''
  if (abs >= 48) return `${(abs / 24).toFixed(1)} days${note}`
  return `${abs.toFixed(1)} h${note}`
}

function fmtPeriod(days: number | null | undefined): string {
  if (days == null) return 'not available'
  if (days >= 365.25 * 2) return `${(days / 365.25).toFixed(1)} years`
  return `${days.toLocaleString(undefined, { maximumFractionDigits: 1 })} days`
}

function BodyCard({
  body,
  onFlyTo,
  onGlobe,
}: {
  body: SpaceBody
  onFlyTo: () => void
  onGlobe: (() => void) | null
}) {
  const facts: [string, string][] = [
    ['Radius', fmtKm(body.facts.equatorialRadiusKm)],
    ['Mass', fmtSci(body.facts.massKg, 'kg')],
    ['Day', fmtHours(body.facts.rotationPeriodHours)],
    ...(body.id === 'sun'
      ? ([] as [string, string][])
      : ([
          ['Year', fmtPeriod(body.facts.orbitalPeriodDays)],
          [
            'Distance',
            body.facts.semimajorAxisAu != null
              ? `${body.facts.semimajorAxisAu.toLocaleString(undefined, {
                  maximumFractionDigits: 2,
                })} AU`
              : 'not available',
          ],
        ] as [string, string][])),
    ...(body.moonCount != null && body.kind !== 'moon'
      ? ([[
          'Moons',
          body.moonCount.toLocaleString(),
        ]] as [string, string][])
      : []),
  ]
  return (
    <article
      className="flex h-full flex-col overflow-hidden rounded-xl border"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface-raised)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {body.image ? (
        <img
          src={body.image.url}
          alt={`${body.name} — ${body.image.title ?? 'NASA portrait'}`}
          loading="lazy"
          className="h-36 w-full object-cover"
        />
      ) : (
        <div
          className="flex h-36 w-full items-center justify-center text-xs"
          style={{ background: 'var(--surface-sunken)', color: 'var(--text-muted)' }}
        >
          no free portrait available
        </div>
      )}
      <div className="flex flex-1 flex-col px-4 py-3">
        <h3 className="flex items-baseline gap-2 text-base font-semibold">
          {body.name}
          <span
            className="font-sans text-[10px] font-normal uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            {KIND_LABEL[body.kind]}
          </span>
        </h3>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
          {facts.map(([label, value]) => (
            <div key={label} className="contents">
              <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
              <dd className="text-right tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
        {body.image && (
          <p className="mt-1.5 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {body.image.credit}
          </p>
        )}
        <p className="mt-auto flex flex-wrap gap-x-3 gap-y-1 pt-2.5 text-xs">
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={onFlyTo}
          >
            Fly to it above
          </button>
          {onGlobe && (
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={onGlobe}
            >
              3D globe
            </button>
          )}
          <a
            className="underline underline-offset-2"
            href={body.links.wikipedia}
            target="_blank"
            rel="noreferrer"
          >
            Wikipedia
          </a>
          {body.image && (
            <a
              className="underline underline-offset-2"
              href={body.image.page}
              target="_blank"
              rel="noreferrer"
            >
              NASA image
            </a>
          )}
        </p>
      </div>
    </article>
  )
}

export function SolarSystemPage() {
  const state = useSpaceBodies()
  const [mode, setMode] = useState<'compressed' | 'true'>('compressed')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [selectedMoon, setSelectedMoon] = useState<MoonRecord | null>(null)
  const [globeBodyId, setGlobeBodyId] = useState<string | null>(null)
  const [playing, setPlaying] = useState(
    () => !window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [speedIndex, setSpeedIndex] = useState(1)
  const [moonList, setMoonList] = useState<MoonRecord[] | null>(null)

  const mountRef = useRef<HTMLDivElement | null>(null)
  const viewportRef = useRef<HTMLDivElement | null>(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const sceneApiRef = useRef<{ zoom: (factor: number) => void } | null>(null)
  /** Moon meshes currently in the scene, for picking (round-2 feedback:
      clicking a moon should open its panel like clicking a planet). */
  const moonClickable = useRef<THREE.Object3D[]>([])
  const moonByUuid = useRef(new Map<string, MoonRecord>())
  const selectMoonRef = useRef<(moon: MoonRecord) => void>(() => {})
  const sceneBodies = useRef<SceneBody[]>([])
  const controlsRef = useRef<OrbitControls | null>(null)
  const flyTarget = useRef<THREE.Vector3 | null>(null)
  const playingRef = useRef(playing)
  playingRef.current = playing
  const speedRef = useRef<number>(SPEEDS[1]!.daysPerSecond)
  speedRef.current = SPEEDS[speedIndex]?.daysPerSecond ?? 10
  const selectRef = useRef<(id: string) => void>(() => {})
  const selectedIdRef = useRef<string | null>(null)

  const file = state.status === 'ready' ? state.data : null
  const bodies = useMemo(() => file?.bodies ?? [], [file])
  const byId = useMemo(
    () => new Map(bodies.map((body) => [body.id, body])),
    [bodies],
  )
  const selected = selectedId ? byId.get(selectedId) : undefined
  const globeBody = globeBodyId ? byId.get(globeBodyId) : undefined

  // Moons of the selected planet, for the in-scene majors and the list.
  useEffect(() => {
    setSelectedMoon(null)
    setMoonList(null)
    if (!selected || !selected.moonCount || selected.kind === 'moon') return
    let cancelled = false
    loadMoons(selected.id)
      .then((data) => {
        if (!cancelled) setMoonList(data.moons)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [selected])

  const select = useCallback((id: string) => {
    setSelectedId(id)
    const entry = sceneBodies.current.find((b) => b.body.id === id)
    if (entry) {
      const position = new THREE.Vector3()
      entry.mesh.getWorldPosition(position)
      flyTarget.current = position
    }
  }, [])
  selectRef.current = select
  selectMoonRef.current = (moon) => setSelectedMoon(moon)

  useEffect(() => {
    const onChange = () => setIsFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // ---- the scene ---------------------------------------------------------
  useEffect(() => {
    const mount = mountRef.current
    if (!mount || bodies.length === 0) return

    const width = mount.clientWidth
    const height = mount.clientHeight
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.setSize(width, height)
    mount.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x05070d)
    const camera = new THREE.PerspectiveCamera(50, width / height, 0.01, 4000)
    camera.position.set(0, 26, 46)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.maxDistance = 400
    controls.minDistance = 0.2
    controlsRef.current = controls
    sceneApiRef.current = {
      zoom: (factor: number) => {
        const offset = camera.position.clone().sub(controls.target)
        offset.setLength(
          Math.max(
            controls.minDistance,
            Math.min(controls.maxDistance, offset.length() * factor),
          ),
        )
        camera.position.copy(controls.target).add(offset)
      },
    }

    scene.add(new THREE.AmbientLight(0xffffff, 0.35))
    const sunLight = new THREE.PointLight(0xfff2d5, 3000, 0, 2)
    scene.add(sunLight)

    const textureLoader = new THREE.TextureLoader()
    const loadBodyTexture = (body: SpaceBody) => {
      if (!body.texture) return null
      const texture = textureLoader.load(`${DATA_BASE_URL}/${body.texture}`)
      texture.colorSpace = THREE.SRGBColorSpace
      return texture
    }

    const entries: SceneBody[] = []
    const clickable: THREE.Object3D[] = []
    const idOf = new Map<string, string>()

    // Stars: a cheap dusting so space is not a void.
    {
      const starGeo = new THREE.BufferGeometry()
      const positions = new Float32Array(1200 * 3)
      for (let i = 0; i < positions.length; i += 1) {
        positions[i] = (Math.random() - 0.5) * 1600
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      scene.add(
        new THREE.Points(
          starGeo,
          new THREE.PointsMaterial({ color: 0x8890a0, size: 0.7, sizeAttenuation: false }),
        ),
      )
    }

    for (const body of bodies) {
      if (body.kind === 'moon') continue
      const isSun = body.id === 'sun'
      const au = body.facts.semimajorAxisAu ?? 0
      const radius = isSun
        ? mode === 'true'
          ? bodyRadius(body.facts.equatorialRadiusKm, 'true')
          : 3
        : bodyRadius(body.facts.equatorialRadiusKm, mode)
      const texture = loadBodyTexture(body)
      const material = isSun
        ? new THREE.MeshBasicMaterial({
            map: texture ?? null,
            color: texture ? 0xffffff : (BODY_COLORS[body.id] ?? 0x999999),
          })
        : new THREE.MeshStandardMaterial({
            map: texture ?? null,
            color: texture ? 0xffffff : (BODY_COLORS[body.id] ?? 0x999999),
            roughness: 0.9,
          })
      const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 40, 24), material)
      const pivot = new THREE.Group()
      pivot.add(mesh)
      scene.add(pivot)
      const angle = Math.random() * Math.PI * 2
      if (!isSun) {
        mesh.position.x = orbitRadius(au, mode)
        pivot.rotation.y = angle
        // Orbit line.
        const ring = new THREE.RingGeometry(
          orbitRadius(au, mode) - 0.02,
          orbitRadius(au, mode) + 0.02,
          128,
        )
        ring.rotateX(-Math.PI / 2)
        scene.add(
          new THREE.Mesh(
            ring,
            new THREE.MeshBasicMaterial({
              color: 0x2c3448,
              side: THREE.DoubleSide,
              transparent: true,
              opacity: 0.8,
            }),
          ),
        )
      }
      if (body.id === 'saturn') {
        const ringTexture = textureLoader.load(
          `${DATA_BASE_URL}/space/textures/saturn-ring.png`,
        )
        ringTexture.colorSpace = THREE.SRGBColorSpace
        const ringGeo = new THREE.RingGeometry(radius * 1.25, radius * 2.2, 96)
        // Map the strip texture radially.
        const pos = ringGeo.attributes.position!
        const uv = ringGeo.attributes.uv!
        const v3 = new THREE.Vector3()
        for (let i = 0; i < pos.count; i += 1) {
          v3.fromBufferAttribute(pos as THREE.BufferAttribute, i)
          const t = (v3.length() - radius * 1.25) / (radius * 0.95)
          uv.setXY(i, t, 0.5)
        }
        const ringMesh = new THREE.Mesh(
          ringGeo,
          new THREE.MeshBasicMaterial({
            map: ringTexture,
            side: THREE.DoubleSide,
            transparent: true,
          }),
        )
        ringMesh.rotation.x = -Math.PI / 2 + 0.45
        mesh.add(ringMesh)
      }
      const label = labelSprite(body.name)
      label.position.y = radius + 0.9
      mesh.add(label)
      clickable.push(mesh)
      idOf.set(mesh.uuid, body.id)
      entries.push({
        body,
        mesh,
        pivot,
        au,
        periodDays: body.facts.orbitalPeriodDays ?? 0,
        angle,
      })
    }
    sceneBodies.current = entries

    // Belts as particle annuli (labelled regions).
    const makeBelt = (innerAu: number, outerAu: number, name: string, y: number) => {
      const count = 1400
      const positions = new Float32Array(count * 3)
      for (let i = 0; i < count; i += 1) {
        const angle = Math.random() * Math.PI * 2
        const r =
          orbitRadius(innerAu, mode) +
          Math.random() * (orbitRadius(outerAu, mode) - orbitRadius(innerAu, mode))
        positions[i * 3] = Math.cos(angle) * r
        positions[i * 3 + 1] = (Math.random() - 0.5) * 0.8
        positions[i * 3 + 2] = Math.sin(angle) * r
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
      scene.add(
        new THREE.Points(
          geometry,
          new THREE.PointsMaterial({ color: 0x777264, size: 0.05 }),
        ),
      )
      const beltLabel = labelSprite(name, true)
      beltLabel.position.set(
        (orbitRadius(innerAu, mode) + orbitRadius(outerAu, mode)) / 2,
        y,
        0,
      )
      scene.add(beltLabel)
    }
    for (const region of file?.regions ?? []) {
      makeBelt(region.innerAu, region.outerAu, region.name, 1.6)
    }

    // Major moons of the selected planet get added dynamically below via
    // a group we clear and refill.
    const moonGroup = new THREE.Group()
    scene.add(moonGroup)

    // Picking.
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    let downAt = 0
    const onPointerDown = () => {
      downAt = performance.now()
    }
    const onClick = (event: MouseEvent) => {
      // A drag is not a click.
      if (performance.now() - downAt > 250) return
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointer, camera)
      const hits = raycaster.intersectObjects(
        [...clickable, ...moonClickable.current],
        false,
      )
      const hit = hits[0]
      if (hit) {
        const moon = moonByUuid.current.get(hit.object.uuid)
        if (moon) {
          selectMoonRef.current(moon)
          return
        }
        const id = idOf.get(hit.object.uuid)
        if (id) selectRef.current(id)
      }
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('click', onClick)

    let disposed = false
    let last = performance.now()
    const animate = () => {
      if (disposed) return
      requestAnimationFrame(animate)
      const now = performance.now()
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (playingRef.current) {
        for (const entry of entries) {
          if (entry.periodDays > 0) {
            entry.angle +=
              ((Math.PI * 2) / entry.periodDays) * speedRef.current * dt
            entry.pivot.rotation.y = entry.angle
          }
          entry.mesh.rotation.y += dt * 0.1
        }
      }
      if (flyTarget.current) {
        // Recompute (bodies move) and glide the view toward the target.
        const id = selectedIdRef.current
        const entry = entries.find((b) => b.body.id === id)
        if (entry) entry.mesh.getWorldPosition(flyTarget.current)
        controls.target.lerp(flyTarget.current, 0.08)
        if (controls.target.distanceTo(flyTarget.current) < 0.05) {
          flyTarget.current = null
        }
      }
      controls.update()
      renderer.render(scene, camera)
    }
    animate()

    const onResize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const resizeObserver = new ResizeObserver(onResize)
    resizeObserver.observe(mount)

    moonGroupRef.current = { group: moonGroup, textureLoader }

    return () => {
      disposed = true
      sceneApiRef.current = null
      resizeObserver.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('click', onClick)
      controls.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose()
          const material = object.material as THREE.Material
          material.dispose()
        }
      })
    }
    // mode/bodies changes rebuild the whole scene deliberately.
  }, [bodies, mode, file])

  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  // Major moons of the selected planet, in scene.
  const moonGroupRef = useRef<{
    group: THREE.Group
    textureLoader: THREE.TextureLoader
  } | null>(null)
  useEffect(() => {
    const holder = moonGroupRef.current
    if (!holder) return
    holder.group.clear()
    moonClickable.current = []
    moonByUuid.current.clear()
    if (!selected || !moonList) return
    const entry = sceneBodies.current.find((b) => b.body.id === selected.id)
    if (!entry) return
    const majors = moonList.filter((m) => m.major && m.aKm).slice(0, 8)
    const planetR = (entry.mesh.geometry as THREE.SphereGeometry).parameters.radius
    const aValues = majors.map((m) => m.aKm ?? 1)
    const minA = Math.min(...aValues)
    const maxA = Math.max(...aValues)
    majors.forEach((moon, index) => {
      const t =
        maxA > minA
          ? Math.log((moon.aKm ?? minA) / minA) / Math.log(maxA / minA)
          : 0.5
      const distance = planetR * (1.8 + t * 3.2)
      const moonMesh = new THREE.Mesh(
        new THREE.SphereGeometry(
          Math.max(0.06, planetR * 0.1 * Math.cbrt((moon.radiusKm ?? 500) / 1000)),
          16,
          12,
        ),
        new THREE.MeshStandardMaterial({ color: 0xcfd6dd, roughness: 0.9 }),
      )
      const angle = (index / majors.length) * Math.PI * 2
      moonMesh.position.set(
        Math.cos(angle) * distance,
        0,
        Math.sin(angle) * distance,
      )
      const label = labelSprite(moon.name, true)
      label.position.y = 0.35
      moonMesh.add(label)
      entry.mesh.add(moonMesh)
      holder.group.attach(moonMesh)
      moonClickable.current.push(moonMesh)
      moonByUuid.current.set(moonMesh.uuid, moon)
    })
  }, [selected, moonList])

  const scaleNote =
    mode === 'compressed'
      ? 'Compressed view: distances on a logarithmic scale, bodies enlarged — NOT to scale.'
      : 'True-distance view: distances linear; at this scale most bodies are sub-pixel dots (that is the honest point). Labels mark their positions.'

  return (
    <div className="mx-auto max-w-7xl px-6 py-10">
      <header>
        <p
          className="font-sans text-xs font-medium uppercase tracking-widest"
          style={{ color: 'var(--text-muted)' }}
        >
          Space
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Solar System
        </h1>
        <p
          className="mt-2 max-w-3xl text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          An interactive 3D model — drag to orbit, scroll or pinch to zoom,
          click any body to fly to it. Figures come from NASA's planetary
          fact sheets and JPL Solar System Dynamics, each with source and
          vintage in the panel; a figure a source does not publish says so.
        </p>
      </header>

      {state.status === 'error' && (
        <div className="mt-6">
          <Unavailable what="Solar System data" source="NASA NSSDC and JPL SSD" />
        </div>
      )}
      {state.status === 'loading' && (
        <p className="mt-6" style={{ color: 'var(--text-muted)' }}>
          Loading the Solar System…
        </p>
      )}

      {file && (
        <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem]">
          <div>
            <div className="flex flex-wrap items-center gap-3 text-sm">
              <fieldset className="flex items-center gap-2">
                <legend className="sr-only">Scale mode</legend>
                <span style={{ color: 'var(--text-muted)' }}>Scale</span>
                {(['compressed', 'true'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={mode === value}
                    onClick={() => setMode(value)}
                    className="rounded border px-2.5 py-1"
                    style={{
                      borderColor: 'var(--border)',
                      background:
                        mode === value ? 'var(--control-selected-bg)' : 'transparent',
                      color:
                        mode === value
                          ? 'var(--control-selected-text)'
                          : 'inherit',
                    }}
                  >
                    {value === 'compressed' ? 'Compressed' : 'True distance'}
                  </button>
                ))}
              </fieldset>
              <button
                type="button"
                aria-pressed={playing}
                onClick={() => setPlaying((value) => !value)}
                className="rounded border px-2.5 py-1"
                style={{ borderColor: 'var(--border)' }}
              >
                {playing ? 'Pause orbits' : 'Play orbits'}
              </button>
              <label className="flex items-center gap-2">
                <span style={{ color: 'var(--text-muted)' }}>Speed</span>
                <select
                  value={speedIndex}
                  onChange={(event) => setSpeedIndex(Number(event.target.value))}
                  className="rounded border px-2 py-1"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--surface-raised)',
                    color: 'var(--text)',
                  }}
                >
                  {SPEEDS.map((speed, index) => (
                    <option key={speed.label} value={index}>
                      {speed.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-2">
                <span style={{ color: 'var(--text-muted)' }}>Jump to</span>
                <select
                  value={selectedId && !selectedMoon ? selectedId : ''}
                  onChange={(event) => {
                    if (event.target.value) select(event.target.value)
                  }}
                  className="rounded border px-2 py-1"
                  style={{
                    borderColor: 'var(--border)',
                    background: 'var(--surface-raised)',
                    color: 'var(--text)',
                  }}
                >
                  <option value="">a body…</option>
                  {bodies
                    .filter((body) => body.kind !== 'moon')
                    .map((body) => (
                      <option key={body.id} value={body.id}>
                        {body.name}
                        {body.kind === 'dwarf' ? ' (dwarf planet)' : ''}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              {scaleNote}
            </p>
            <div
              ref={viewportRef}
              className={`relative mt-3 overflow-hidden rounded-lg border ${
                isFullscreen ? 'h-full' : ''
              }`}
              style={{ borderColor: 'var(--border)', background: '#05070d' }}
            >
              <div
                ref={mountRef}
                className={isFullscreen ? 'h-full' : 'h-[34rem]'}
                aria-label="3D Solar System viewport. Use the Jump-to list for keyboard access to each body."
                role="img"
              />
              <div className="absolute right-2 top-2 flex flex-col gap-1.5">
                <button
                  type="button"
                  aria-label="Zoom in"
                  title="Zoom in"
                  className="h-8 w-8 rounded border border-white/30 bg-black/60 text-base leading-none text-white"
                  onClick={() => sceneApiRef.current?.zoom(0.7)}
                >
                  +
                </button>
                <button
                  type="button"
                  aria-label="Zoom out"
                  title="Zoom out"
                  className="h-8 w-8 rounded border border-white/30 bg-black/60 text-base leading-none text-white"
                  onClick={() => sceneApiRef.current?.zoom(1 / 0.7)}
                >
                  −
                </button>
                <button
                  type="button"
                  aria-label={isFullscreen ? 'Exit full screen' : 'Full screen'}
                  title={isFullscreen ? 'Exit full screen' : 'Full screen'}
                  className="h-8 w-8 rounded border border-white/30 bg-black/60 text-sm leading-none text-white"
                  onClick={() => {
                    if (document.fullscreenElement) {
                      void document.exitFullscreen()
                    } else {
                      void viewportRef.current?.requestFullscreen()
                    }
                  }}
                >
                  {isFullscreen ? '🗗' : '⛶'}
                </button>
              </div>
            </div>
            <p className="mt-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
              Textures: Solar System Scope (CC BY 4.0) · Figures: NASA
              NSSDC (archived, Horizons-checked) and JPL SSD.
            </p>

            {selected && moonList && moonList.length > 0 && (
              <div className="mt-4">
                <h2 className="text-base">
                  Moons of {selected.name}{' '}
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    ({moonList.length} known — majors shown in orbit above)
                  </span>
                </h2>
                <ul className="mt-1 flex flex-wrap gap-1.5 text-xs">
                  {moonList.slice(0, 60).map((moon, index) => (
                    // JPL's catalogue can repeat a name (Puck appears
                    // twice); the index keeps keys unique.
                    <li key={`${moon.name}-${index}`}>
                      <button
                        type="button"
                        className="rounded border px-1.5 py-0.5"
                        style={{
                          borderColor: 'var(--border)',
                          background:
                            selectedMoon?.name === moon.name
                              ? 'var(--control-selected-bg)'
                              : moon.major
                                ? 'var(--surface-sunken)'
                                : 'transparent',
                        }}
                        onClick={() => setSelectedMoon(moon)}
                      >
                        {moon.name}
                      </button>
                    </li>
                  ))}
                  {moonList.length > 60 && (
                    <li style={{ color: 'var(--text-muted)' }}>
                      +{moonList.length - 60} more minor moons
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>

          <aside>
            <div
              className="rounded-xl border px-5 py-5 lg:sticky lg:top-4"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface-raised)',
                boxShadow: 'var(--shadow-card)',
              }}
            >
              {!selected && (
                <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                  Click a body — or use the jump list — for its figures,
                  portrait, story and moons.
                </p>
              )}
              {selected && selectedMoon && (
                <MoonPanel moon={selectedMoon} planet={selected} />
              )}
              {selected && !selectedMoon && (
                <BodyPanel
                  body={selected}
                  onViewGlobe={
                    selected.texture || selected.trek
                      ? () => setGlobeBodyId(selected.id)
                      : undefined
                  }
                />
              )}
            </div>
          </aside>
        </div>
      )}

      {file && (
        <section className="mt-10" aria-label="All bodies, card by card">
          <h2 className="text-xl font-semibold tracking-tight">
            The bodies, card by card
          </h2>
          <p
            className="mt-1 max-w-3xl text-sm"
            style={{ color: 'var(--text-muted)' }}
          >
            An alternative to the 3D view: every major body with its NASA
            portrait and headline figures. “Fly to it above” selects it in
            the scene, where the side panel carries the full figures with
            their sources and vintages.
          </p>
          <ul className="mt-4 grid list-none gap-4 p-0 sm:grid-cols-2 lg:grid-cols-3">
            {bodies.map((body) => (
              <li key={body.id} className="m-0">
                <BodyCard
                  body={body}
                  onFlyTo={() => {
                    select(body.kind === 'moon' ? 'earth' : body.id)
                    if (body.kind === 'moon') {
                      const moon = moonList?.find((m) => m.name === body.name)
                      if (moon) setSelectedMoon(moon)
                    }
                    viewportRef.current?.scrollIntoView({
                      behavior: 'smooth',
                      block: 'center',
                    })
                  }}
                  onGlobe={
                    body.texture || body.trek
                      ? () => setGlobeBodyId(body.id)
                      : null
                  }
                />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Portraits: NASA Image and Video Library, credited per card ·
            Figures: NASA NSSDC fact sheets (archived, Horizons-checked) and
            JPL SSD, sourced per figure in the panel.
          </p>
        </section>
      )}

      {globeBody && (
        <BodyGlobe body={globeBody} onClose={() => setGlobeBodyId(null)} />
      )}
    </div>
  )
}

/**
 * Navigable 3D globe of one body (round-2 §41): spin and zoom with mouse
 * or finger. Trek bodies progressively swap in NASA Solar System Treks
 * tiles as you zoom (streamed; credited on screen) and overlay named IAU
 * surface features from the gazetteer.
 */
function BodyGlobe({ body, onClose }: { body: SpaceBody; onClose: () => void }) {
  const mountRef = useRef<HTMLDivElement | null>(null)
  const [features, setFeatures] = useState<NomenclatureFeature[]>([])
  const [activeFeature, setActiveFeature] = useState<NomenclatureFeature | null>(
    null,
  )
  const [tileLevel, setTileLevel] = useState(0)

  // Escape closes from anywhere — the canvas swallows focus otherwise.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!body.trek) return
    let cancelled = false
    loadNomenclature(body.id)
      .then((data) => {
        if (!cancelled) setFeatures(data.features)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [body])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return
    const width = mount.clientWidth
    const height = mount.clientHeight
    const renderer = new THREE.WebGLRenderer({ antialias: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.setSize(width, height)
    mount.appendChild(renderer.domElement)
    const scene = new THREE.Scene()
    scene.background = new THREE.Color(0x05070d)
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 50)
    camera.position.set(0, 0, 2.8)
    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.enablePan = false
    controls.minDistance = 1.12
    controls.maxDistance = 5

    scene.add(new THREE.AmbientLight(0xffffff, 1.1))
    const light = new THREE.DirectionalLight(0xffffff, 1.6)
    light.position.set(5, 2, 3)
    scene.add(light)

    const material = new THREE.MeshStandardMaterial({
      color: 0xbbbbbb,
      roughness: 1,
    })
    const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), material)
    scene.add(globe)

    // Round-2 feedback ("very low resolution"): the globe loads the 8k
    // variant where one is committed (Sun, Earth, Jupiter, Saturn); the
    // 2k paints first as a placeholder so the sphere is never blank.
    const loader = new THREE.TextureLoader()
    let sssApplied: '2k' | '8k' | null = null
    if (body.texture) {
      loader.load(`${DATA_BASE_URL}/${body.texture}`, (texture) => {
        if (sssApplied === '8k') return
        sssApplied = '2k'
        texture.colorSpace = THREE.SRGBColorSpace
        material.map = texture
        material.color.set(0xffffff)
        material.needsUpdate = true
      })
    }
    if (body.texture8k) {
      loader.load(`${DATA_BASE_URL}/${body.texture8k}`, (texture) => {
        sssApplied = '8k'
        texture.colorSpace = THREE.SRGBColorSpace
        material.map = texture
        material.color.set(0xffffff)
        material.needsUpdate = true
      })
    }

    // Saturn keeps its rings in the globe view too (round-2 feedback).
    if (body.id === 'saturn') {
      const ringTexture = loader.load(
        `${DATA_BASE_URL}/space/textures/saturn-ring.png`,
      )
      ringTexture.colorSpace = THREE.SRGBColorSpace
      const ringGeo = new THREE.RingGeometry(1.25, 2.2, 96)
      const ringPos = ringGeo.attributes.position!
      const ringUv = ringGeo.attributes.uv!
      const v3 = new THREE.Vector3()
      for (let i = 0; i < ringPos.count; i += 1) {
        v3.fromBufferAttribute(ringPos as THREE.BufferAttribute, i)
        ringUv.setXY(i, (v3.length() - 1.25) / 0.95, 0.5)
      }
      const ringMesh = new THREE.Mesh(
        ringGeo,
        new THREE.MeshBasicMaterial({
          map: ringTexture,
          side: THREE.DoubleSide,
          transparent: true,
        }),
      )
      ringMesh.rotation.x = -Math.PI / 2 + 0.45
      scene.add(ringMesh)
    }

    // Progressive Trek upgrade. Levels 2 (1024x512) and 3 (4096x2048)
    // are requested IMMEDIATELY — round-2 feedback: the globe should be
    // sharp on open, not only after zooming — and level 4 (8192x4096)
    // streams in when the camera closes. Each level is assembled from
    // WMTS tiles onto a canvas; completions can land out of order, so a
    // lower level finishing late must never overwrite a higher one.
    let bestLevel = 0 // highest level requested
    let appliedLevel = 0 // highest level actually on the material
    const upgrade = (level: number) => {
      if (!body.trek || level <= bestLevel) return
      bestLevel = level
      const cols = 2 ** (level + 1)
      const rows = 2 ** level
      const canvas = document.createElement('canvas')
      canvas.width = cols * 256
      canvas.height = rows * 256
      const ctx = canvas.getContext('2d')!
      let loaded = 0
      for (let row = 0; row < rows; row += 1) {
        for (let col = 0; col < cols; col += 1) {
          const img = new Image()
          img.crossOrigin = 'anonymous'
          img.onload = () => {
            ctx.drawImage(img, col * 256, row * 256, 256, 256)
            loaded += 1
            if (loaded === cols * rows && level > appliedLevel) {
              appliedLevel = level
              const texture = new THREE.CanvasTexture(canvas)
              texture.colorSpace = THREE.SRGBColorSpace
              material.map = texture
              material.color.set(0xffffff)
              material.needsUpdate = true
              setTileLevel(level)
            }
          }
          img.onerror = () => {
            loaded += 1
          }
          img.src = `${body.trek!.urlTemplate}/${level}/${row}/${col}.${body.trek!.ext}`
        }
      }
    }

    // Feature markers (IAU gazetteer) on the sphere surface. Labels sit
    // with their BOTTOM edge on the anchor point just above the terrain
    // (sprite.center), so they read as pinned rather than floating
    // (round-2 feedback); each marker carries an invisible hit sphere so
    // clicking a label's dot opens the feature card.
    const markerGroup = new THREE.Group()
    globe.add(markerGroup)
    const featureHits: THREE.Object3D[] = []
    const featureByUuid = new Map<string, NomenclatureFeature>()
    const addMarkers = (list: NomenclatureFeature[]) => {
      markerGroup.clear()
      featureHits.length = 0
      featureByUuid.clear()
      for (const feature of list.slice(0, 40)) {
        const phi = ((90 - feature.lat) * Math.PI) / 180
        const theta = ((feature.lon + 90) * Math.PI) / 180
        const position = new THREE.Vector3(
          Math.sin(phi) * Math.cos(theta),
          Math.cos(phi),
          -Math.sin(phi) * Math.sin(theta),
        )
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.005, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xffd479 }),
        )
        dot.position.copy(position.clone().multiplyScalar(1.002))
        markerGroup.add(dot)
        const hit = new THREE.Mesh(
          new THREE.SphereGeometry(0.03, 8, 6),
          new THREE.MeshBasicMaterial({ visible: false }),
        )
        hit.position.copy(dot.position)
        markerGroup.add(hit)
        featureHits.push(hit)
        featureByUuid.set(hit.uuid, feature)
        const label = labelSprite(feature.name, true)
        label.scale.multiplyScalar(0.26)
        label.center.set(0.5, 0)
        label.position.copy(position.clone().multiplyScalar(1.006))
        markerGroup.add(label)
      }
    }
    markersRef.current = addMarkers

    // Click a marker -> feature card (drag is not a click).
    const raycaster = new THREE.Raycaster()
    const pointerNdc = new THREE.Vector2()
    let downAt = 0
    const onPointerDown = () => {
      downAt = performance.now()
    }
    const onClick = (event: MouseEvent) => {
      if (performance.now() - downAt > 250) return
      const rect = renderer.domElement.getBoundingClientRect()
      pointerNdc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
      pointerNdc.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
      raycaster.setFromCamera(pointerNdc, camera)
      const hit = raycaster.intersectObjects(featureHits, false)[0]
      if (hit) {
        const feature = featureByUuid.get(hit.object.uuid)
        if (feature) setActiveFeature(feature)
      }
    }
    renderer.domElement.addEventListener('pointerdown', onPointerDown)
    renderer.domElement.addEventListener('click', onClick)

    let disposed = false
    const animate = () => {
      if (disposed) return
      requestAnimationFrame(animate)
      controls.update()
      const distance = camera.position.length()
      markerGroup.visible = distance < 2.2
      if (body.trek && distance < 1.45) upgrade(4)
      renderer.render(scene, camera)
    }
    upgrade(2)
    upgrade(3)
    animate()

    const onResize = () => {
      const w = mount.clientWidth
      const h = mount.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(onResize)
    observer.observe(mount)

    return () => {
      disposed = true
      observer.disconnect()
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('click', onClick)
      controls.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [body])

  const markersRef = useRef<(list: NomenclatureFeature[]) => void>(() => {})
  useEffect(() => {
    markersRef.current(features)
  }, [features])

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`3D globe of ${body.name}`}
      className="fixed inset-0 z-50 flex flex-col p-3 sm:p-6"
      style={{ background: 'rgba(4, 6, 10, 0.92)' }}
    >
      <div className="flex items-center justify-between gap-3 pb-2 text-sm text-white">
        <p className="font-medium">
          {body.name} — drag to spin, scroll or pinch to zoom
          {body.trek
            ? ' · NASA Trek detail streams in; click a named feature for its story'
            : ''}
        </p>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-white/40 px-2.5 py-1"
          autoFocus
        >
          Close (Esc)
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          ref={mountRef}
          className="h-full overflow-hidden rounded-lg"
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
          }}
        />
        {activeFeature && (
          <aside
            className="absolute bottom-3 left-3 max-w-xs rounded-lg border border-white/25 p-3 text-xs text-white"
            style={{ background: 'rgba(10, 13, 20, 0.92)' }}
            aria-label={`About ${activeFeature.name}`}
          >
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm font-semibold">{activeFeature.name}</p>
              <button
                type="button"
                aria-label="Close feature card"
                className="rounded border border-white/30 px-1.5 leading-tight"
                onClick={() => setActiveFeature(null)}
              >
                ×
              </button>
            </div>
            <p className="mt-1 text-white/85">
              {activeFeature.type}
              {featureTypeGloss(activeFeature.type)
                ? ` — ${featureTypeGloss(activeFeature.type)}`
                : ''}
              {' · '}
              {activeFeature.dKm.toLocaleString()} km across
            </p>
            {activeFeature.origin && (
              <p className="mt-1.5 text-white/85">{activeFeature.origin}</p>
            )}
            <p className="mt-1.5 text-white/60">
              {activeFeature.approved
                ? `Name approved by the IAU in ${activeFeature.approved}`
                : 'IAU-approved name'}
              {activeFeature.culture ? ` · origin: ${activeFeature.culture}` : ''}
            </p>
            {activeFeature.link && (
              <p className="mt-1.5">
                <a
                  className="underline underline-offset-2"
                  href={activeFeature.link.replace(/^http:/, 'https:')}
                  target="_blank"
                  rel="noreferrer"
                >
                  USGS Gazetteer entry →
                </a>
              </p>
            )}
          </aside>
        )}
      </div>
      <p className="pt-2 text-[11px] text-white/70">
        {body.trek
          ? `${body.trek.credit}${tileLevel > 0 ? ` · streaming tile level ${tileLevel}` : ''} · Named features: IAU Gazetteer of Planetary Nomenclature (USGS)`
          : 'Texture: Solar System Scope (CC BY 4.0)'}
      </p>
    </div>
  )
}

export default SolarSystemPage
