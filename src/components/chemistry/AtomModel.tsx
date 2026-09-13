import { useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'

/**
 * Animated Bohr-model schematic of one atom (§47.3): a nucleus cluster and
 * one ring per principal shell, populated from the electron configuration
 * (shell occupancy per n, computed in the ETL). Mouse / touch orbit via
 * OrbitControls; the rings precess at different rates so the model reads
 * as three-dimensional. NOT to scale and NOT a depiction of orbitals —
 * the caption in ElementPanel says so.
 *
 * prefers-reduced-motion starts the model paused; a play/pause control
 * is always present. The whole module is React.lazy-loaded so three.js
 * stays out of the page chunk until a panel opens.
 */

const PROTON = 0xd9604c
const NEUTRON = 0x8c919b
const RING = 0x7b8290
const ELECTRON = 0x3987e5
const ELECTRON_GLOW = 0x9ec5f4

function nucleonCount(z: number, massNumber: number | null): { protons: number; neutrons: number } {
  // A visual cluster capped at ~48 spheres; the ratio p:n is kept.
  const a = massNumber ?? Math.round(z * (z < 20 ? 2 : 2.4))
  const cap = 48
  if (a <= cap) return { protons: z, neutrons: Math.max(0, a - z) }
  const protons = Math.max(1, Math.round((z / a) * cap))
  return { protons, neutrons: cap - protons }
}

export default function AtomModel({
  z,
  symbol,
  shells,
  massNumber,
}: {
  z: number
  symbol: string
  shells: number[]
  massNumber: number | null
}) {
  const host = useRef<HTMLDivElement>(null)
  const [reduced] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [playing, setPlaying] = useState(!reduced)
  const playingRef = useRef(playing)
  playingRef.current = playing

  useEffect(() => {
    const element = host.current
    if (!element) return
    const width = element.clientWidth || 320
    const height = width
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200)
    const outer = 2.2 + shells.length * 1.15
    camera.position.set(outer * 1.35, outer * 0.75, outer * 1.35)
    camera.lookAt(0, 0, 0)

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(width, height)
    renderer.setClearColor(0x000000, 0)
    element.appendChild(renderer.domElement)
    renderer.domElement.setAttribute('role', 'img')
    renderer.domElement.setAttribute(
      'aria-label',
      `Bohr-model schematic of ${symbol}: nucleus with ${shells.length} electron shell${shells.length === 1 ? '' : 's'} holding ${shells.join(', ')} electrons`,
    )

    scene.add(new THREE.AmbientLight(0xffffff, 1.4))
    const key = new THREE.DirectionalLight(0xffffff, 1.6)
    key.position.set(5, 8, 6)
    scene.add(key)

    // Nucleus: a jittered ball of small spheres.
    const nucleus = new THREE.Group()
    const { protons, neutrons } = nucleonCount(z, massNumber)
    const total = protons + neutrons
    const nucleonRadius = 0.22
    const ballRadius = Math.max(0.28, nucleonRadius * Math.cbrt(total) * 1.15)
    const geometry = new THREE.SphereGeometry(nucleonRadius, 14, 10)
    const protonMaterial = new THREE.MeshStandardMaterial({ color: PROTON, roughness: 0.55 })
    const neutronMaterial = new THREE.MeshStandardMaterial({ color: NEUTRON, roughness: 0.6 })
    let seed = z * 9973
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    for (let i = 0; i < total; i += 1) {
      const mesh = new THREE.Mesh(geometry, i < protons ? protonMaterial : neutronMaterial)
      const r = ballRadius * Math.cbrt(rand())
      const theta = rand() * Math.PI * 2
      const phi = Math.acos(2 * rand() - 1)
      mesh.position.set(
        r * Math.sin(phi) * Math.cos(theta),
        r * Math.sin(phi) * Math.sin(theta),
        r * Math.cos(phi),
      )
      nucleus.add(mesh)
    }
    scene.add(nucleus)

    // Shells: a thin ring per n, tilted progressively, each carrying its electrons.
    const shellGroups: { group: THREE.Group; speed: number }[] = []
    const electronGeometry = new THREE.SphereGeometry(0.11, 12, 8)
    const electronMaterial = new THREE.MeshStandardMaterial({
      color: ELECTRON,
      emissive: ELECTRON_GLOW,
      emissiveIntensity: 0.35,
      roughness: 0.4,
    })
    shells.forEach((count, index) => {
      const radius = ballRadius + 1.0 + index * 1.15
      const group = new THREE.Group()
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(radius, 0.018, 6, 96),
        new THREE.MeshBasicMaterial({ color: RING, transparent: true, opacity: 0.75 }),
      )
      group.add(ring)
      for (let i = 0; i < count; i += 1) {
        const angle = (i / count) * Math.PI * 2
        const electron = new THREE.Mesh(electronGeometry, electronMaterial)
        electron.position.set(Math.cos(angle) * radius, Math.sin(angle) * radius, 0)
        group.add(electron)
      }
      group.rotation.x = (index % 2 === 0 ? 1 : -1) * (0.35 + index * 0.22)
      group.rotation.y = index * 0.5
      scene.add(group)
      shellGroups.push({ group, speed: 0.9 / (index + 1) })
    })

    const controls = new OrbitControls(camera, renderer.domElement)
    controls.enableDamping = true
    controls.enablePan = false
    controls.minDistance = outer * 0.8
    controls.maxDistance = outer * 3

    let frame = 0
    let last = performance.now()
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      if (playingRef.current) {
        shellGroups.forEach(({ group, speed }) => {
          group.rotation.z += dt * speed
        })
        nucleus.rotation.y += dt * 0.25
        scene.rotation.y += dt * 0.12
      }
      controls.update()
      renderer.render(scene, camera)
    }
    frame = requestAnimationFrame(tick)

    const resize = new ResizeObserver(() => {
      const size = element.clientWidth
      if (size > 0) renderer.setSize(size, size)
    })
    resize.observe(element)

    return () => {
      cancelAnimationFrame(frame)
      resize.disconnect()
      controls.dispose()
      renderer.dispose()
      geometry.dispose()
      electronGeometry.dispose()
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose()
          const material = object.material
          if (Array.isArray(material)) material.forEach((m) => m.dispose())
          else material.dispose()
        }
      })
      if (renderer.domElement.parentNode === element) element.removeChild(renderer.domElement)
    }
  }, [z, symbol, shells, massNumber])

  return (
    <div className="relative">
      <div ref={host} className="aspect-square w-full" />
      <button
        type="button"
        onClick={() => setPlaying((value) => !value)}
        aria-pressed={playing}
        className="absolute right-2 top-2 rounded border px-2 py-0.5 text-xs"
        style={{
          borderColor: 'var(--border)',
          background: 'var(--surface-raised)',
          color: 'var(--text)',
        }}
      >
        {playing ? 'Pause' : 'Play'}
      </button>
      {reduced && !playing && (
        <p
          className="absolute bottom-2 left-2 text-[10px]"
          style={{ color: 'var(--text-muted)' }}
        >
          Paused (reduced motion). Drag to orbit.
        </p>
      )}
    </div>
  )
}
