import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

import { BodyPanel, MoonPanel } from '../components/space/BodyPanels'
import { Unavailable } from '../components/viz/primitives'
import { DATA_BASE_URL } from '../config'
import {
  loadMoons,
  loadNomenclature,
  useSpaceBodies,
  type MoonRecord,
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
      const hits = raycaster.intersectObjects(clickable, false)
      const hit = hits[0]
      if (hit) {
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
              ref={mountRef}
              className="mt-3 h-[34rem] overflow-hidden rounded-lg border"
              style={{ borderColor: 'var(--border)' }}
              aria-label="3D Solar System viewport. Use the Jump-to list for keyboard access to each body."
              role="img"
            />
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
                  {moonList.slice(0, 60).map((moon) => (
                    <li key={moon.name}>
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
  const [features, setFeatures] = useState<
    { name: string; lat: number; lon: number; dKm: number }[]
  >([])
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

    const loader = new THREE.TextureLoader()
    if (body.texture) {
      loader.load(`${DATA_BASE_URL}/${body.texture}`, (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace
        material.map = texture
        material.color.set(0xffffff)
        material.needsUpdate = true
      })
    }

    // Progressive Trek upgrade: level 2 (1024x512) then 3 then 4 as the
    // camera closes in. Each level is assembled from WMTS tiles onto a
    // canvas and swapped in as the globe texture.
    let bestLevel = 0
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
            if (loaded === cols * rows) {
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

    // Feature markers (IAU gazetteer) on the sphere surface.
    const markerGroup = new THREE.Group()
    globe.add(markerGroup)
    const addMarkers = (
      list: { name: string; lat: number; lon: number; dKm: number }[],
    ) => {
      markerGroup.clear()
      for (const feature of list.slice(0, 40)) {
        const phi = ((90 - feature.lat) * Math.PI) / 180
        const theta = ((feature.lon + 90) * Math.PI) / 180
        const position = new THREE.Vector3(
          Math.sin(phi) * Math.cos(theta),
          Math.cos(phi),
          -Math.sin(phi) * Math.sin(theta),
        )
        const dot = new THREE.Mesh(
          new THREE.SphereGeometry(0.004, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xffd479 }),
        )
        dot.position.copy(position.clone().multiplyScalar(1.002))
        markerGroup.add(dot)
        const label = labelSprite(feature.name, true)
        label.scale.multiplyScalar(0.28)
        label.position.copy(position.clone().multiplyScalar(1.03))
        markerGroup.add(label)
      }
    }
    markersRef.current = addMarkers

    let disposed = false
    const animate = () => {
      if (disposed) return
      requestAnimationFrame(animate)
      controls.update()
      const distance = camera.position.length()
      markerGroup.visible = distance < 2.2
      if (body.trek) {
        if (distance < 1.35) upgrade(4)
        else if (distance < 1.7) upgrade(3)
        else if (distance < 2.4) upgrade(2)
      }
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
    const observer = new ResizeObserver(onResize)
    observer.observe(mount)

    return () => {
      disposed = true
      observer.disconnect()
      controls.dispose()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [body])

  const markersRef = useRef<
    (list: { name: string; lat: number; lon: number; dKm: number }[]) => void
  >(() => {})
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
          {body.trek ? ' (zoom in for NASA Trek detail)' : ''}
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
      <div
        ref={mountRef}
        className="min-h-0 flex-1 overflow-hidden rounded-lg"
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose()
        }}
      />
      <p className="pt-2 text-[11px] text-white/70">
        {body.trek
          ? `${body.trek.credit}${tileLevel > 0 ? ` · streaming tile level ${tileLevel}` : ''} · Named features: IAU Gazetteer of Planetary Nomenclature (USGS)`
          : 'Texture: Solar System Scope (CC BY 4.0)'}
      </p>
    </div>
  )
}

export default SolarSystemPage
