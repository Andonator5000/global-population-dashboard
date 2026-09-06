import { geoDistance, geoPath, type GeoPermissibleObjects } from 'd3-geo'
import { select } from 'd3-selection'
// Side-effect import: gives d3 selections a .transition() so button zoom
// can ease through the same zoom behaviour (round-2 §35).
import 'd3-transition'
import { zoom, zoomIdentity, type D3ZoomEvent } from 'd3-zoom'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { feature } from 'topojson-client'

import {
  loadAdmin1Labels,
  loadDetailLayer,
  loadPlaces,
  type Admin1Label,
  type DetailCollection,
  type PlacePoint,
} from '../lib/mapdetail'
import { TerrainRenderer } from '../lib/terrain'

import {
  CONTINENTS,
  DEFAULT_MAP_PALETTE,
  type BaseViewKey,
  type ContinentKey,
  type MapPaletteKey,
  type ProjectionKey,
} from '../config'
import { createProjection, fitProjection } from '../lib/projection'
import type {
  CountryGeometryProperties,
  CountryTopology,
  MapMarker,
  PopulationRow,
} from '../types'

const VIEW_WIDTH = 1000
const VIEW_HEIGHT = 480

/**
 * Zoom ceiling. Raised from 12 (2026-08-23, maintainer request): at 12x the
 * smaller island nations were still marker dots with no visible name. 48x is
 * deep enough to read Caribbean and Pacific microstates while the 110m
 * geometry still holds up (it is generalised, so beyond this it turns to
 * obvious straight-line artifacts).
 */
const MAX_ZOOM = 48

/**
 * Point markers carry their name label WITHOUT hover once the zoom passes
 * this factor. At world zoom 250 marker names would be unreadable soup; by
 * 3x the map is regional and the labels have room.
 */
const MARKER_LABEL_MIN_ZOOM = 3

/**
 * Marker radius for entities with no polygon at 110m. The visible dot is small
 * so it does not imply an area it does not have; the transparent hit ring is
 * 12px (24px target) so it is actually clickable and touch-reachable.
 */
const MARKER_RADIUS = 3
const MARKER_HIT_RADIUS = 12

export interface HoverTarget {
  iso3: string
  name: string
  continent: ContinentKey
  contested: boolean
  isMarker: boolean
}

interface WorldMapProps {
  topology: CountryTopology
  markers: MapMarker[]
  populationByIso3: Map<string, PopulationRow>
  projectionKey: ProjectionKey
  /** 'country' outlines each entity; 'continent' groups them. */
  mode: 'country' | 'continent'
  hovered: HoverTarget | null
  onHover: (target: HoverTarget | null) => void
  onSelect: (target: HoverTarget) => void
  /** Continent highlighted in continent mode; null means none. */
  activeContinent: ContinentKey | null
  onActiveContinentChange: (continent: ContinentKey | null) => void
  /** Colour direction for country fills (Phase 2.4); 'atlas' by default. */
  paletteDirection?: MapPaletteKey
  /**
   * Base view (Phase 4): 'political' is the colour-coded atlas; 'satellite'
   * renders Blue Marble terrain imagery beneath transparent country shapes.
   * Continent mode ignores it -- region fills ARE that mode's identity.
   */
  baseView?: BaseViewKey
  /**
   * Round-2 §36: content for the country popover. When provided (country
   * mode only), hovering a country shows a small card at the cursor with
   * this content; on touch, tapping PINS it (with a close control) instead
   * of navigating, and navigation happens through the content's own
   * "More info" link. The caller supplies the content so the map component
   * stays ignorant of routes and figures.
   */
  renderPopover?: (target: HoverTarget) => React.ReactNode
}

/** Zoom thresholds for the detail layers (Phase 4). Each names the factor
 *  at which a layer is fetched AND shown; fetch happens once per session. */
const DETAIL_ZOOM = {
  water50: 2,
  places: 3,
  admin1: 5,
  admin1Labels: 6,
  water10: 12,
  waterLabels: 12,
} as const

interface DetailData {
  admin1Lines?: DetailCollection
  lakes50?: DetailCollection
  lakes10?: DetailCollection
  rivers50?: DetailCollection
  rivers10?: DetailCollection
  admin1Labels?: Admin1Label[]
  places?: PlacePoint[]
}

interface DetailLabel {
  key: string
  text: string
  x: number
  y: number
  /** view-units font size before the 1/sqrt(k) zoom easing */
  size: number
  kind: 'admin1' | 'place' | 'capital' | 'water'
}

interface CountryShape {
  iso3: string
  name: string
  continent: ContinentKey
  contested: boolean
  d: string
  centroid: [number, number]
  /** Projected on-screen area in px² at zoom 1, for label visibility. */
  areaPx: number
}

/**
 * A shape's name label is visible without hover once its projected area,
 * scaled by the square of the zoom factor, clears this. At world zoom that
 * shows the large countries; zooming in reveals progressively smaller ones,
 * so the map never turns into 250 overlapping strings.
 */
const LABEL_MIN_AREA_PX2 = 900

/**
 * Neutral land colour for the globe view, mirroring the LIGHT --map-land.
 * The globe is sunlit land on a dark ocean in BOTH themes, so the dark
 * theme's land neutral (L 0.34) would sink into the ocean (L 0.31).
 */
const GLOBE_LAND_NEUTRAL = 'oklch(84% 0.014 250)'

interface FocusTarget extends HoverTarget {
  x: number
  y: number
}

type Direction = 'up' | 'down' | 'left' | 'right'

/**
 * Nearest target in a compass direction, by centroid.
 *
 * Candidates must lie in the requested direction; among those, the score
 * favours a small step along the axis of travel and penalises drift across it,
 * so pressing Right from Spain reaches France rather than something far north.
 */
function nearestInDirection(
  targets: FocusTarget[],
  fromIndex: number,
  direction: Direction,
): number {
  const origin = targets[fromIndex]
  if (!origin) return fromIndex
  let best = fromIndex
  let bestScore = Infinity

  targets.forEach((candidate, index) => {
    if (index === fromIndex) return
    const dx = candidate.x - origin.x
    const dy = candidate.y - origin.y
    const along =
      direction === 'right' ? dx
      : direction === 'left' ? -dx
      : direction === 'down' ? dy
      : -dy
    if (along <= 0) return
    const across = Math.abs(
      direction === 'left' || direction === 'right' ? dy : dx,
    )
    const score = along + across * 2.5
    if (score < bestScore) {
      bestScore = score
      best = index
    }
  })
  return best
}

export function WorldMap({
  topology,
  markers,
  populationByIso3,
  projectionKey,
  mode,
  hovered,
  onHover,
  onSelect,
  activeContinent,
  onActiveContinentChange,
  paletteDirection = DEFAULT_MAP_PALETTE,
  baseView = 'political',
  renderPopover,
}: WorldMapProps) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const behaviourRef = useRef<ReturnType<typeof zoom<SVGSVGElement, unknown>> | null>(null)
  const nodeRefs = useRef(new Map<string, SVGGraphicsElement>())
  const [transform, setTransform] = useState(() => zoomIdentity)
  const [isFullscreen, setIsFullscreen] = useState(false)

  const isGlobe = projectionKey === 'globe'
  /**
   * Globe orientation: [lambda, phi] in degrees, driven by dragging. A slight
   * initial tilt so the first view is not dead-on the equator/meridian cross.
   */
  const [rotation, setRotation] = useState<[number, number]>([-10, -20])
  /** Active pointers; the globe rotates only under exactly one. */
  const dragPointers = useRef(new Map<number, { x: number; y: number }>())
  /** Set once a drag moves far enough that the trailing click must not select. */
  const dragSuppressesClick = useRef(false)
  /**
   * Roving tabindex.
   *
   * Only ONE country carries tabindex=0 at a time; the rest are -1 and are
   * reached with the arrow keys. Before this, the map exposed 241 tab stops
   * and a keyboard user had to press Tab 241 times to get past it — measured,
   * not estimated. A composite widget is one stop; you navigate inside it.
   */
  const [activeIndex, setActiveIndex] = useState(0)

  /**
   * TopoJSON decoding is independent of rotation and zoom, but it used to sit
   * inside the projection memo below -- meaning every pointermove that spun
   * the globe re-decoded all 250 geometries before projecting them. Hoisted
   * so a drag only pays for projection, not for parsing.
   */
  const collection = useMemo(
    () =>
      feature(
        topology as never,
        topology.objects.countries as never,
      ) as unknown as {
        features: { properties: CountryGeometryProperties; geometry: unknown }[]
      },
    [topology],
  )

  const { shapes, sphere, markerPoints, projection } = useMemo(() => {
    const base = createProjection(projectionKey)
    if (isGlobe) base.rotate([rotation[0], rotation[1], 0])
    const projection = fitProjection(base, VIEW_WIDTH, VIEW_HEIGHT)
    const path = geoPath(projection)

    /** On the globe, points past the horizon project onto the near side and
        must be culled by great-circle distance from the view centre. */
    const pointVisible = (coordinates: [number, number]) =>
      !isGlobe ||
      geoDistance(coordinates, [-rotation[0], -rotation[1]]) <= Math.PI / 2

    const built: CountryShape[] = []
    for (const item of collection.features) {
      const d = path(item as unknown as GeoPermissibleObjects)
      if (!d) continue
      const centroid = path.centroid(item as unknown as GeoPermissibleObjects)
      built.push({
        iso3: item.properties.iso3,
        name: item.properties.name,
        continent: item.properties.continent,
        contested: item.properties.contested,
        d,
        centroid: [centroid[0], centroid[1]],
        areaPx: path.area(item as unknown as GeoPermissibleObjects),
      })
    }

    const points = markers
      .map((marker) => {
        if (!pointVisible(marker.coordinates)) return null
        const xy = projection(marker.coordinates)
        return xy ? { marker, x: xy[0], y: xy[1] } : null
      })
      .filter((v): v is { marker: MapMarker; x: number; y: number } => v !== null)

    return {
      shapes: built,
      sphere: path({ type: 'Sphere' }) ?? '',
      markerPoints: points,
      projection,
    }
  }, [collection, markers, projectionKey, isGlobe, rotation])

  // ---- Phase 4: detail layers, terrain, and the satellite base view ------

  /** Which imagery base is live, if any: satellite (Blue Marble, dark) or
      terrain (hypsometric relief, light). Political fills otherwise.
      Continent mode always uses its region fills. */
  const imagery =
    mode === 'country' && baseView !== 'political' ? baseView : null
  const satellite = imagery !== null
  const [detail, setDetail] = useState<DetailData>({})
  const detailRequested = useRef(new Set<string>())

  /**
   * Globe rotation invalidates every projected detail path, and regenerating
   * ~13k simplified features per drag frame would kill the spin. So the
   * detail layers follow the rotation with a short settle delay: they hide
   * while the sphere is actively turning and reproject 160 ms after it
   * stops. Zoom does NOT invalidate them -- the zoom <g> scales the strings.
   */
  const [settledRotation, setSettledRotation] = useState(rotation)
  const rotationSettled =
    settledRotation[0] === rotation[0] && settledRotation[1] === rotation[1]
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledRotation(rotation), 160)
    return () => window.clearTimeout(timer)
  }, [rotation])

  /** Fetch each layer the first time the zoom crosses its threshold. */
  useEffect(() => {
    const k = transform.k
    const want = (
      key: string,
      threshold: number,
      loader: () => Promise<unknown>,
      assign: (data: never) => Partial<DetailData>,
    ) => {
      if (k < threshold || detailRequested.current.has(key)) return
      detailRequested.current.add(key)
      loader()
        .then((data) => setDetail((prev) => ({ ...prev, ...assign(data as never) })))
        .catch(() => detailRequested.current.delete(key))
    }
    want('lakes50', DETAIL_ZOOM.water50, () => loadDetailLayer('lakes-50m'),
      (data) => ({ lakes50: data }))
    want('rivers50', DETAIL_ZOOM.water50, () => loadDetailLayer('rivers-50m'),
      (data) => ({ rivers50: data }))
    want('places', DETAIL_ZOOM.places, loadPlaces, (data) => ({ places: data }))
    want('admin1', DETAIL_ZOOM.admin1, () => loadDetailLayer('admin1-lines'),
      (data) => ({ admin1Lines: data }))
    want('admin1Labels', DETAIL_ZOOM.admin1Labels, loadAdmin1Labels,
      (data) => ({ admin1Labels: data }))
    want('lakes10', DETAIL_ZOOM.water10, () => loadDetailLayer('lakes-10m'),
      (data) => ({ lakes10: data }))
    want('rivers10', DETAIL_ZOOM.water10, () => loadDetailLayer('rivers-10m'),
      (data) => ({ rivers10: data }))
  }, [transform.k])

  /**
   * Projected path strings for the loaded vector layers. Recomputed only on
   * settle (see above); d3's geoPath clips to the visible hemisphere on the
   * globe, so the strings stay a fraction of the source size.
   */
  const detailPaths = useMemo(() => {
    if (!rotationSettled) return null
    const k = transform.k
    const path = geoPath(projection)
    const draw = (collection: DetailCollection | undefined) =>
      collection ? path(collection as unknown as GeoPermissibleObjects) ?? '' : ''
    const use10m = k >= DETAIL_ZOOM.water10
    return {
      lakes: draw(use10m ? detail.lakes10 ?? detail.lakes50 : detail.lakes50),
      rivers: draw(use10m ? detail.rivers10 ?? detail.rivers50 : detail.rivers50),
      admin1: k >= DETAIL_ZOOM.admin1 ? draw(detail.admin1Lines) : '',
    }
    // transform.k is deliberately bucketed by the DETAIL_ZOOM comparisons
    // above; including it raw would reproject on every wheel tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rotationSettled,
    settledRotation,
    projection,
    detail,
    transform.k >= DETAIL_ZOOM.water10,
    transform.k >= DETAIL_ZOOM.admin1,
  ])

  /** Previous render's country labels, seeding detail-label collision. */
  const countryLabelSeed = useRef<
    { name: string; x: number; y: number; emphasized: boolean }[]
  >([])

  /**
   * Zoom-progressive labels with collision culling: country names (already
   * placed by visibleLabels below) seed the occupied set, then capitals,
   * admin-1 names, towns by scalerank, and finally water names claim space
   * in that order. Everything is compared in screen pixels.
   */
  const detailLabels = useMemo(() => {
    if (!rotationSettled || mode === 'continent') return []
    const k = transform.k
    if (k < DETAIL_ZOOM.places) return []
    const placed: { x: number; y: number; w: number; h: number }[] = []
    const labels: DetailLabel[] = []

    const viewCenter: [number, number] = [-rotation[0], -rotation[1]]
    const projectPoint = (lon: number, lat: number): [number, number] | null => {
      if (isGlobe && geoDistance([lon, lat], viewCenter) > Math.PI / 2 - 1e-4) {
        return null
      }
      const point = projection([lon, lat])
      if (!point || !Number.isFinite(point[0])) return null
      // Into screen space (view coords times zoom) with the pan applied.
      const x = point[0] * k + transform.x
      const y = point[1] * k + transform.y
      if (x < -40 || x > VIEW_WIDTH + 40 || y < -20 || y > VIEW_HEIGHT + 20) {
        return null
      }
      return [point[0], point[1]]
    }

    const collides = (x: number, y: number, w: number, h: number) =>
      placed.some(
        (rect) =>
          Math.abs(rect.x - x) < (rect.w + w) / 2 &&
          Math.abs(rect.y - y) < (rect.h + h) / 2,
      )

    const tryPlace = (
      key: string,
      text: string,
      lon: number,
      lat: number,
      size: number,
      kind: DetailLabel['kind'],
    ) => {
      if (labels.length >= 130) return
      const point = projectPoint(lon, lat)
      if (!point) return
      const screenSize = (size / Math.sqrt(k)) * k
      const w = text.length * screenSize * 0.62
      const h = screenSize * 1.5
      const sx = point[0] * k
      const sy = point[1] * k
      if (collides(sx, sy, w, h)) return
      placed.push({ x: sx, y: sy, w, h })
      labels.push({ key, text, x: point[0], y: point[1], size, kind })
    }

    // Seed with the country labels so nothing overprints them.
    for (const label of countryLabelSeed.current) {
      const screenSize = (label.emphasized ? 13 : 10) * Math.sqrt(k)
      placed.push({
        x: label.x * k,
        y: label.y * k,
        w: label.name.length * screenSize * 0.62,
        h: screenSize * 1.5,
      })
    }

    const places = detail.places ?? []
    for (const place of places) {
      const bonus = place.cap === 1 ? 2 : 0
      if (k < 3 + place.rank * 1.6 - bonus) continue
      tryPlace(
        `pl-${place.name}-${place.lon}`,
        place.name,
        place.lon,
        place.lat,
        place.cap === 1 ? 8.5 : 7.5,
        place.cap === 1 ? 'capital' : 'place',
      )
    }
    if (k >= DETAIL_ZOOM.admin1Labels) {
      for (const label of detail.admin1Labels ?? []) {
        tryPlace(
          `a1-${label.a0}-${label.name}`,
          label.name,
          label.lon,
          label.lat,
          8,
          'admin1',
        )
      }
    }
    if (k >= DETAIL_ZOOM.waterLabels) {
      const path = geoPath(projection)
      const nameWater = (collection: DetailCollection | undefined, prefix: string) => {
        for (const item of collection?.features ?? []) {
          const name = item.properties.name
          if (!name) continue
          const centroid = path.centroid(item as unknown as GeoPermissibleObjects)
          if (!Number.isFinite(centroid[0])) continue
          const inverted = projection.invert?.(centroid)
          if (!inverted) continue
          tryPlace(`${prefix}-${name}-${centroid[0].toFixed(1)}`, name,
            inverted[0], inverted[1], 7, 'water')
        }
      }
      nameWater(detail.lakes10 ?? detail.lakes50, 'lk')
      nameWater(detail.rivers10 ?? detail.rivers50, 'rv')
    }
    return labels
    // Bucketing k to quarter steps keeps this from re-running per wheel tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    rotationSettled,
    settledRotation,
    projection,
    detail,
    mode,
    isGlobe,
    Math.round(transform.k * 4),
    Math.round(transform.x / 8),
    Math.round(transform.y / 8),
  ])

  // ---- terrain canvas (satellite view) ----------------------------------

  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<TerrainRenderer | null>(null)
  const [tileVersion, setTileVersion] = useState(0)
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  })

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setContainerSize({
        w: entry.contentRect.width,
        h: entry.contentRect.height,
      })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!satellite) return
    const renderer = new TerrainRenderer(
      () => setTileVersion((v) => v + 1),
      imagery === 'terrain' ? 'geo/terrain-hypso' : 'geo/terrain',
    )
    rendererRef.current = renderer
    return () => {
      renderer.destroy()
      rendererRef.current = null
    }
  }, [satellite, imagery])

  useEffect(() => {
    if (!satellite) return
    const canvas = canvasRef.current
    const renderer = rendererRef.current
    if (!canvas || !renderer) return
    const { w, h } = containerSize
    if (w < 2 || h < 2) return
    // 1.75 caps the buffer on high-density screens: terrain is imagery, not
    // text, and the extra pixels cost more than they show.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.75)
    const bufferW = Math.round(w * dpr)
    const bufferH = Math.round(h * dpr)
    if (canvas.width !== bufferW) canvas.width = bufferW
    if (canvas.height !== bufferH) canvas.height = bufferH
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const scale = Math.min(w / VIEW_WIDTH, h / VIEW_HEIGHT)
    renderer.render(
      ctx,
      projection,
      rotation,
      transform,
      {
        scale,
        offsetX: (w - VIEW_WIDTH * scale) / 2,
        offsetY: (h - VIEW_HEIGHT * scale) / 2,
        dpr,
      },
      w,
      h,
      sphere,
      // Resolved ocean colour: canvas cannot use CSS custom properties.
      getComputedStyle(canvas).getPropertyValue('--map-ocean') || '#0b2740',
      isGlobe,
    )
  }, [
    satellite,
    projection,
    rotation,
    transform,
    containerSize,
    sphere,
    isGlobe,
    tileVersion,
  ])

  const attribution =
    imagery === 'satellite'
      ? 'Imagery: NASA Blue Marble (Aug 2004) · Borders, water, places: Natural Earth'
      : imagery === 'terrain'
        ? 'Terrain: Natural Earth cross-blended hypso & shaded relief (public domain)'
        : 'Boundaries, water and places: Natural Earth (public domain)'

  // ---- Round-2 §35: canvas-rendered drag frames + inertia ----------------
  //
  // The old path was: pointermove -> setRotation -> React re-render ->
  // re-project and reconcile ~250 SVG paths, EVERY frame. That is what made
  // the globe sluggish. Now, while a drag (or its inertia) is live, the
  // rotation lives in a ref and each frame is painted onto a canvas with
  // d3's context renderer (a few ms for the whole world); the SVG is
  // hidden for the duration and React is not involved at all. On release,
  // ONE setRotation commits the final orientation and the interactive SVG
  // returns — hover, click, keyboard and screen-reader behaviour are
  // untouched because the SVG they live on never changed, it only sat out
  // the animation.
  const dragCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const rotationRef = useRef<[number, number]>(rotation)
  const isDragRendering = useRef(false)
  const restoreAfterCommit = useRef(false)
  const lastFrameDelta = useRef({ dx: 0, dy: 0 })
  const inertiaFrame = useRef<number | null>(null)
  const dragFills = useRef<{
    fills: string[]
    ocean: string
    stroke: string
  }>({ fills: [], ocean: '#0b2740', stroke: '#0b2740' })

  useEffect(() => {
    if (!isDragRendering.current) rotationRef.current = rotation
  }, [rotation])

  /** Swap the SVG back in only AFTER React committed the final rotation,
      or the old orientation would flash for one frame. */
  useEffect(() => {
    if (!restoreAfterCommit.current) return
    restoreAfterCommit.current = false
    if (svgRef.current) svgRef.current.style.visibility = ''
    if (dragCanvasRef.current) dragCanvasRef.current.style.display = 'none'
  }, [rotation])

  const layoutFor = useCallback((w: number, h: number) => {
    const scale = Math.min(w / VIEW_WIDTH, h / VIEW_HEIGHT)
    return {
      scale,
      offsetX: (w - VIEW_WIDTH * scale) / 2,
      offsetY: (h - VIEW_HEIGHT * scale) / 2,
      dpr: Math.min(window.devicePixelRatio || 1, 1.75),
    }
  }, [])

  /** Resolve every CSS-variable fill once per drag; canvases cannot read
      custom properties, and 250 getComputedStyle calls per FRAME would
      recreate the jank this exists to remove. */
  const buildDragFills = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const styles = getComputedStyle(svg)
    const readVar = (name: string, fallback: string) =>
      styles.getPropertyValue(name).trim() || fallback
    const fills = collection.features.map((item) => {
      const props = item.properties
      if (satellite) return 'transparent'
      if (mode === 'continent') {
        return readVar(`--region-${props.continent}`, GLOBE_LAND_NEUTRAL)
      }
      if (!populationByIso3.get(props.iso3)?.available) {
        return 'oklch(92% 0.003 250)'
      }
      return readVar(
        `--fill-globe-${paletteDirection}-${props.iso3}`,
        GLOBE_LAND_NEUTRAL,
      )
    })
    dragFills.current = {
      fills,
      ocean: readVar('--map-ocean', '#0b2740'),
      stroke:
        imagery === 'satellite'
          ? 'rgba(255, 255, 255, 0.78)'
          : imagery === 'terrain'
            ? 'rgba(92, 71, 48, 0.7)'
            : readVar('--map-ocean', '#0b2740'),
    }
  }, [collection, satellite, imagery, mode, populationByIso3, paletteDirection])

  const drawDragFrame = useCallback(() => {
    const container = containerRef.current
    const canvas = dragCanvasRef.current
    if (!container || !canvas) return
    const w = container.clientWidth
    const h = container.clientHeight
    if (w < 2 || h < 2) return
    const { scale, offsetX, offsetY, dpr } = layoutFor(w, h)
    const bufferW = Math.round(w * dpr)
    const bufferH = Math.round(h * dpr)
    if (canvas.width !== bufferW) canvas.width = bufferW
    if (canvas.height !== bufferH) canvas.height = bufferH
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const [lambda, phi] = rotationRef.current
    const base = createProjection('globe')
    base.rotate([lambda, phi, 0])
    const frameProjection = fitProjection(base, VIEW_WIDTH, VIEW_HEIGHT)

    // Satellite imagery keeps tracking the finger: the terrain renderer is
    // driven imperatively here because no React render happens mid-drag.
    if (satellite && rendererRef.current && canvasRef.current) {
      const terrainCtx = canvasRef.current.getContext('2d')
      if (terrainCtx) {
        const sphereD =
          geoPath(frameProjection)({ type: 'Sphere' } as GeoPermissibleObjects) ?? ''
        rendererRef.current.render(
          terrainCtx, frameProjection, rotationRef.current, transform,
          { scale, offsetX, offsetY, dpr }, w, h, sphereD,
          dragFills.current.ocean, true,
        )
      }
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, bufferW, bufferH)
    const view = dpr * scale
    ctx.setTransform(
      view * transform.k, 0, 0, view * transform.k,
      dpr * (offsetX + scale * transform.x),
      dpr * (offsetY + scale * transform.y),
    )
    const path = geoPath(frameProjection, ctx)
    if (!satellite) {
      ctx.beginPath()
      path({ type: 'Sphere' } as GeoPermissibleObjects)
      ctx.fillStyle = dragFills.current.ocean
      ctx.fill()
    }
    ctx.lineJoin = 'round'
    ctx.lineWidth = (satellite ? 0.75 : 0.5) / transform.k
    ctx.strokeStyle = dragFills.current.stroke
    collection.features.forEach((item, index) => {
      ctx.beginPath()
      path(item as unknown as GeoPermissibleObjects)
      const fill = dragFills.current.fills[index]
      if (fill && fill !== 'transparent') {
        ctx.fillStyle = fill
        ctx.fill()
      }
      ctx.stroke()
    })
  }, [collection, satellite, transform, layoutFor])

  const beginDragRender = useCallback(() => {
    if (isDragRendering.current) return
    isDragRendering.current = true
    // The popover would hover over a spinning globe pointing at nothing;
    // one setState here, before frames leave React, is fine.
    setPopover(null)
    buildDragFills()
    if (svgRef.current) svgRef.current.style.visibility = 'hidden'
    if (dragCanvasRef.current) dragCanvasRef.current.style.display = 'block'
  }, [buildDragFills])

  const endDragRender = useCallback(() => {
    if (!isDragRendering.current) return
    isDragRendering.current = false
    restoreAfterCommit.current = true
    setRotation([rotationRef.current[0], rotationRef.current[1]])
  }, [])

  const cancelInertia = useCallback(() => {
    if (inertiaFrame.current !== null) {
      cancelAnimationFrame(inertiaFrame.current)
      inertiaFrame.current = null
    }
  }, [])

  /** Momentum after release: the last frame's delta decays at 7% per
      frame, so the globe has weight. Skipped under reduced motion. */
  const startInertia = useCallback(() => {
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches
    let { dx, dy } = lastFrameDelta.current
    if (reduced || Math.hypot(dx, dy) < 3) {
      endDragRender()
      return
    }
    const step = () => {
      dx *= 0.93
      dy *= 0.93
      const sensitivity = 0.5625 / Math.sqrt(zoomLevel.current)
      rotationRef.current = [
        rotationRef.current[0] + dx * sensitivity,
        Math.max(-90, Math.min(90, rotationRef.current[1] - dy * sensitivity)),
      ]
      drawDragFrame()
      if (Math.hypot(dx, dy) < 0.4) {
        inertiaFrame.current = null
        endDragRender()
        return
      }
      inertiaFrame.current = requestAnimationFrame(step)
    }
    inertiaFrame.current = requestAnimationFrame(step)
  }, [drawDragFrame, endDragRender])

  useEffect(() => () => cancelInertia(), [cancelInertia])

  /** Every focusable entity, ordered west-to-east so Tab order is sensible. */
  const focusTargets: FocusTarget[] = useMemo(() => {
    const list: FocusTarget[] = [
      ...shapes.map((shape) => ({
        iso3: shape.iso3,
        name: shape.name,
        continent: shape.continent,
        contested: shape.contested,
        isMarker: false,
        x: shape.centroid[0],
        y: shape.centroid[1],
      })),
      ...markerPoints.map(({ marker, x, y }) => ({
        iso3: marker.iso3,
        name: marker.name,
        continent: marker.continent,
        contested: marker.contested,
        isMarker: true,
        x,
        y,
      })),
    ].filter((t) => Number.isFinite(t.x) && Number.isFinite(t.y))
    list.sort((a, b) => a.x - b.x || a.y - b.y)
    return list
  }, [shapes, markerPoints])

  const indexByIso3 = useMemo(() => {
    const map = new Map<string, number>()
    focusTargets.forEach((target, index) => {
      if (!map.has(target.iso3)) map.set(target.iso3, index)
    })
    return map
  }, [focusTargets])

  /**
   * Set by keyboard navigation, consumed by the effect below.
   *
   * Focusing straight from the handler (even inside requestAnimationFrame)
   * races React's commit: the tabindex moves to the new country but the
   * browser keeps focus on the old one. Deferring to an effect guarantees the
   * DOM is committed before we move focus.
   */
  const pendingFocus = useRef<string | null>(null)

  const moveTo = useCallback(
    (index: number) => {
      const target = focusTargets[index]
      if (!target) return
      setActiveIndex(index)
      pendingFocus.current = target.iso3
      onHover(target)
      if (mode === 'continent') onActiveContinentChange(target.continent)
    },
    [focusTargets, mode, onHover, onActiveContinentChange],
  )

  useEffect(() => {
    const iso3 = pendingFocus.current
    if (!iso3) return
    pendingFocus.current = null
    nodeRefs.current.get(iso3)?.focus()
  })

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const directions: Record<string, Direction> = {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      }
      const direction = directions[event.key]
      if (direction) {
        event.preventDefault()
        moveTo(nearestInDirection(focusTargets, activeIndex, direction))
        return
      }
      if (event.key === 'Home') {
        event.preventDefault()
        moveTo(0)
        return
      }
      if (event.key === 'End') {
        event.preventDefault()
        moveTo(focusTargets.length - 1)
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        const target = focusTargets[activeIndex]
        if (target) onSelect(target)
      }
    },
    [activeIndex, focusTargets, moveTo, onSelect],
  )

  // Zoom and pan. d3-zoom owns the gesture; React owns the rendered transform.
  //
  // In GLOBE mode the single-pointer drag is repurposed for rotation (below),
  // so d3-zoom is filtered down to wheel and two-finger pinch only -- it must
  // not also pan while a drag is spinning the sphere.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, MAX_ZOOM])
      .translateExtent([
        [0, 0],
        [VIEW_WIDTH, VIEW_HEIGHT],
      ])
      .filter((event) => {
        if (!isGlobe) {
          // d3-zoom's default filter.
          return (!event.ctrlKey || event.type === 'wheel') && !event.button
        }
        if (event.type === 'wheel') return true
        if (event.type.startsWith('touch')) {
          return (event as TouchEvent).touches.length >= 2
        }
        return false
      })
      .on('zoom', (event: D3ZoomEvent<SVGSVGElement, unknown>) => {
        setTransform(event.transform)
      })
    behaviourRef.current = behaviour
    const selection = select(svg)
    selection.call(behaviour)
    selection.on('dblclick.zoom', null)
    return () => {
      selection.on('.zoom', null)
      behaviourRef.current = null
    }
  }, [isGlobe])

  /** The +/- buttons drive the same d3-zoom behaviour as wheel and pinch,
      eased over 200ms (round-2 §35) unless the reader asked for reduced
      motion. Wheel and pinch stay direct — they are already continuous. */
  const zoomBy = useCallback((factor: number) => {
    const svg = svgRef.current
    const behaviour = behaviourRef.current
    if (!svg || !behaviour) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      behaviour.scaleBy(select(svg), factor)
      return
    }
    select(svg).transition().duration(200).call(behaviour.scaleBy, factor)
  }, [])

  // Fullscreen state tracks the DOM, not a local boolean, so Esc (which
  // exits fullscreen without clicking our button) stays in sync.
  useEffect(() => {
    const onChange = () =>
      setIsFullscreen(document.fullscreenElement === containerRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const toggleFullscreen = useCallback(() => {
    const container = containerRef.current
    if (!container) return
    if (document.fullscreenElement === container) {
      void document.exitFullscreen()
    } else {
      void container.requestFullscreen()
    }
  }, [])

  /**
   * Globe rotation by dragging -- pointer events, so mouse and touch share
   * one code path. Only exactly one active pointer rotates (a second finger
   * hands the gesture to d3-zoom's pinch). A drag that actually moved
   * suppresses the click it releases into, or letting go of the sphere would
   * open whichever country the pointer happened to stop on.
   */
  const handleGlobePointerDown = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      // A fresh press is never a leftover drag, so the click suppression
      // resets on EVERY projection. It used to reset only on the globe
      // path -- spin the globe (flag set true), switch to a flat view, and
      // the stale flag swallowed every click on the flat map: countries
      // became unopenable until the page reloaded.
      if (event.isPrimary) dragSuppressesClick.current = false
      lastPointerType.current = event.pointerType
      // Grabbing a spinning globe stops it (and continues the drag-render
      // session from wherever the inertia had carried it).
      cancelInertia()
      if (!isGlobe) return
      dragPointers.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      })
    },
    [isGlobe, cancelInertia],
  )

  /**
   * Drag deltas accumulate here and are applied ONCE per animation frame.
   *
   * Touch screens deliver pointermove at up to 120-240 Hz; applying each one
   * through setState forced a full reprojection render per event -- several
   * renders per painted frame, all but one thrown away. That was the
   * sluggishness on touch. Batching to requestAnimationFrame renders exactly
   * once per frame with the summed delta, so the sphere tracks the finger at
   * the display's own rate.
   */
  const pendingDrag = useRef({ dx: 0, dy: 0 })
  const dragFrame = useRef<number | null>(null)
  const zoomLevel = useRef(1)
  zoomLevel.current = transform.k

  useEffect(
    () => () => {
      if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current)
    },
    [],
  )

  const handleGlobePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!isGlobe) return
      const tracked = dragPointers.current.get(event.pointerId)
      if (!tracked || dragPointers.current.size !== 1) return
      const dx = event.clientX - tracked.x
      const dy = event.clientY - tracked.y
      if (!dragSuppressesClick.current && Math.hypot(dx, dy) < 4) return
      if (!dragSuppressesClick.current) {
        dragSuppressesClick.current = true
        // From here the gesture is a drag, never a click, so capturing the
        // pointer costs nothing and keeps the spin alive when the finger
        // wanders off the svg mid-gesture. Guarded: a pointer can be gone
        // by the time the frame runs (and synthetic events have no id).
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* capture is an optimisation, never a requirement */
        }
      }
      dragPointers.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      })
      pendingDrag.current.dx += dx
      pendingDrag.current.dy += dy
      if (dragFrame.current !== null) return
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = null
        const { dx: fdx, dy: fdy } = pendingDrag.current
        pendingDrag.current = { dx: 0, dy: 0 }
        // Round-2 §35: rotation stays in a ref and the frame goes straight
        // to canvas — React sees nothing until the gesture ends.
        beginDragRender()
        lastFrameDelta.current = { dx: fdx, dy: fdy }
        // Degrees per CSS pixel, eased down as the zoom tightens.
        // 0.25 -> 0.375 -> 0.5625 (2026-08-24): raised 50% twice on
        // maintainer request; the spin should track a finger briskly.
        const sensitivity = 0.5625 / Math.sqrt(zoomLevel.current)
        rotationRef.current = [
          rotationRef.current[0] + fdx * sensitivity,
          Math.max(
            -90,
            Math.min(90, rotationRef.current[1] - fdy * sensitivity),
          ),
        ]
        drawDragFrame()
      })
    },
    [isGlobe, beginDragRender, drawDragFrame],
  )

  const handleGlobePointerEnd = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      dragPointers.current.delete(event.pointerId)
      // Last finger up while a drag-render session is live: hand off to
      // inertia (which commits the final rotation when it stops).
      if (dragPointers.current.size === 0 && isDragRendering.current) {
        startInertia()
      }
    },
    [startInertia],
  )

  // ---- Round-2 §36: country popover --------------------------------------
  const [popover, setPopover] = useState<{
    target: HoverTarget
    x: number
    y: number
    pinned: boolean
  } | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  /** pointerType of the most recent pointerdown; click events do not carry
      one reliably, and touch must pin the popover instead of navigating. */
  const lastPointerType = useRef('mouse')

  const popoverActive = renderPopover !== undefined && mode === 'country'

  const containerPoint = useCallback(
    (event: { clientX: number; clientY: number }): [number, number] => {
      const rect = containerRef.current?.getBoundingClientRect()
      return rect
        ? [event.clientX - rect.left, event.clientY - rect.top]
        : [0, 0]
    },
    [],
  )

  const showHoverPopover = useCallback(
    (target: HoverTarget, event: React.PointerEvent) => {
      if (!popoverActive || event.pointerType !== 'mouse') return
      const [x, y] = containerPoint(event)
      // A pinned (touch) popover holds until dismissed; hover never
      // replaces it.
      setPopover((prev) =>
        prev?.pinned ? prev : { target, x, y, pinned: false },
      )
    },
    [popoverActive, containerPoint],
  )

  /** Select, unless the pointer was busy spinning the globe. On touch the
      tap pins the popover instead — navigation is its "More info" link. */
  const selectUnlessDragging = useCallback(
    (target: HoverTarget, event?: React.MouseEvent) => {
      if (dragSuppressesClick.current) return
      if (
        popoverActive &&
        lastPointerType.current === 'touch' &&
        event !== undefined
      ) {
        const [x, y] = containerPoint(event)
        setPopover({ target, x, y, pinned: true })
        return
      }
      onSelect(target)
    },
    [onSelect, popoverActive, containerPoint],
  )

  const strokeWidth = 0.5 / transform.k
  const isDimmed = (continent: ContinentKey) =>
    mode === 'continent' && activeContinent !== null && continent !== activeContinent

  // One colour system for EVERY projection (2026-08-16): dark blue ocean
  // with sunlit light land fills in both themes -- land sits tiers of
  // lightness above the ocean (min contrast 4.36, gated in
  // build-map-palette.mjs), so a blue country can never be mistaken for
  // water. Since 2026-08-24 the area OUTSIDE the projected sphere is black
  // space on the flat views too (maintainer request) -- the ocean stops at
  // the planet's edge on every projection, not just the globe.
  const waterFill = 'var(--map-ocean)'
  const backgroundFill = 'var(--map-space)'
  const landStroke = 'var(--map-ocean)'
  const landNeutral = GLOBE_LAND_NEUTRAL
  const noDataFill = 'oklch(92% 0.003 250)'

  // Continent view (Phase 2.4): each continent is ONE cohesive region --
  // every member takes the continent's region fill, the country strokes
  // match it so internal borders drop away, and the continent label carries
  // identity. Hover/focus emphasises a whole continent by dimming the rest,
  // never by recolouring a single country.
  function fillFor(shape: CountryShape): string {
    const row = populationByIso3.get(shape.iso3)
    if (mode === 'continent') {
      return `var(--region-${shape.continent}, ${GLOBE_LAND_NEUTRAL})`
    }
    // Satellite view: the imagery IS the fill. 'transparent' (never 'none')
    // keeps the whole shape a pointer target, so hover/click/keyboard work
    // exactly as in the political view; the hovered country reads as a
    // translucent accent wash over the terrain.
    if (satellite) {
      return hovered?.iso3 === shape.iso3
        ? 'var(--map-accent-fill)'
        : 'transparent'
    }
    if (!row?.available) return noDataFill
    if (hovered?.iso3 === shape.iso3) return 'var(--map-accent-fill)'
    return `var(--fill-globe-${paletteDirection}-${shape.iso3}, ${GLOBE_LAND_NEUTRAL})`
  }

  /** Country borders must read on imagery, where the dark ocean stroke
   *  vanishes: light strokes on the dark satellite, dark warm strokes on
   *  the light terrain relief (round-2 §37). */
  const countryStroke =
    imagery === 'satellite'
      ? 'rgba(255, 255, 255, 0.78)'
      : imagery === 'terrain'
        ? 'rgba(92, 71, 48, 0.7)'
        : landStroke
  const countryStrokeWidth = satellite ? strokeWidth * 1.5 : strokeWidth
  void landNeutral

  const tabIndexFor = (iso3: string) =>
    indexByIso3.get(iso3) === activeIndex ? 0 : -1

  /**
   * Name labels visible WITHOUT hover: every shape whose zoom-scaled area
   * clears the threshold gets its name drawn at its centroid, so the world
   * view labels the large countries and zooming in reveals smaller ones.
   * The hovered/focused entity is always labelled regardless of size (that
   * includes markers, which have no area).
   */
  const visibleLabels = useMemo(() => {
    // Continent mode carries continent labels instead; per-country names
    // would fight them and imply country-level interaction.
    if (mode === 'continent') return []
    const k2 = transform.k * transform.k
    // The key must be STABLE and UNIQUE per drawn shape, not per iso3: two
    // polygons share iso3 SOM (Somalia + Somaliland) and CYP. Keying labels
    // by iso3 alone gave React duplicate keys, and panning while zoomed left
    // stale label nodes behind -- the "Somalia multiplies" bug.
    const labels: { key: string; iso3: string; name: string; x: number; y: number; emphasized: boolean }[] = []
    shapes.forEach((shape, index) => {
      const isHovered = hovered?.iso3 === shape.iso3
      if (!isHovered && shape.areaPx * k2 < LABEL_MIN_AREA_PX2) return
      if (!Number.isFinite(shape.centroid[0])) return
      labels.push({
        key: `shape-${shape.iso3}-${index}`,
        iso3: shape.iso3,
        name: shape.name,
        x: shape.centroid[0],
        y: shape.centroid[1],
        emphasized: isHovered,
      })
    })
    // Marker entities (no polygon at 110m) get their names once the zoom is
    // regional -- before this, an island nation's name existed only on hover,
    // which on touch meant only after tapping the dot.
    const labelMarkers = transform.k >= MARKER_LABEL_MIN_ZOOM
    for (const { marker, x, y } of markerPoints) {
      const isHovered = hovered?.iso3 === marker.iso3
      if (!labelMarkers && !isHovered) continue
      labels.push({
        key: `marker-${marker.iso3}`,
        iso3: marker.iso3,
        name: marker.name,
        x,
        y: y - 6 / Math.sqrt(transform.k),
        emphasized: isHovered,
      })
    }
    return labels
  }, [shapes, markerPoints, hovered, transform.k, mode])
  countryLabelSeed.current = visibleLabels

  const registerNode = (iso3: string) => (node: SVGGraphicsElement | null) => {
    if (node) nodeRefs.current.set(iso3, node)
    else nodeRefs.current.delete(iso3)
  }

  const controlButtonStyle: React.CSSProperties = {
    background: 'var(--surface-raised)',
    color: 'var(--text)',
    border: '1px solid var(--border)',
  }

  // ---- Round-2 §36: control tooltips + optional zoom slider --------------
  const [sliderVisible, setSliderVisible] = useState(() => {
    try {
      return sessionStorage.getItem('map-zoom-slider') === '1'
    } catch {
      return false
    }
  })
  const toggleSlider = useCallback(() => {
    setSliderVisible((visible) => {
      const next = !visible
      try {
        sessionStorage.setItem('map-zoom-slider', next ? '1' : '0')
      } catch {
        /* per-session convenience only */
      }
      return next
    })
  }, [])

  /** Continuous zoom for the slider — absolute, no easing (the handle IS
      the easing). */
  const zoomTo = useCallback((k: number) => {
    const svg = svgRef.current
    const behaviour = behaviourRef.current
    if (!svg || !behaviour) return
    behaviour.scaleTo(select(svg), Math.max(1, Math.min(MAX_ZOOM, k)))
  }, [])

  const sliderLink = (
    <button type="button" className="underline underline-offset-2" onClick={toggleSlider}>
      {sliderVisible ? 'Hide slider' : 'Show slider'}
    </button>
  )

  return (
    <div
      ref={containerRef}
      className="relative"
      style={{ background: backgroundFill }}
    >
      {/* Map controls: zoom without a wheel or pinch, and fullscreen. They
          live OUTSIDE the svg so they are ordinary buttons for keyboard and
          screen reader users. */}
      <div className="absolute right-3 top-3 z-10 flex flex-col gap-1.5">
        {/* Tooltips (round-2 §36): shown on hover AND focus-within, and
            hoverable themselves so the Show/Hide-slider link inside stays
            reachable. Buttons keep their aria-labels; tooltips are the
            sighted-pointer duplicate, so aria-hidden. */}
        <div className="map-ctl relative">
          <button
            type="button"
            aria-label="Zoom in"
            className="h-8 w-8 rounded text-lg leading-none"
            style={controlButtonStyle}
            onClick={() => zoomBy(1.5)}
          >
            +
          </button>
          <div className="map-tooltip">
            <span className="map-tooltip-bubble">Zoom in · {sliderLink}</span>
          </div>
        </div>
        {sliderVisible && (
          <input
            type="range"
            className="map-zoom-slider self-center"
            min={0}
            max={100}
            step={1}
            value={Math.round(
              (Math.log(transform.k) / Math.log(MAX_ZOOM)) * 100,
            )}
            onChange={(event) =>
              zoomTo(
                Math.exp(
                  (Math.log(MAX_ZOOM) * Number(event.target.value)) / 100,
                ),
              )
            }
            aria-label="Zoom level"
            aria-orientation="vertical"
          />
        )}
        <div className="map-ctl relative">
          <button
            type="button"
            aria-label="Zoom out"
            className="h-8 w-8 rounded text-lg leading-none"
            style={controlButtonStyle}
            onClick={() => zoomBy(1 / 1.5)}
          >
            −
          </button>
          <div className="map-tooltip">
            <span className="map-tooltip-bubble">Zoom out · {sliderLink}</span>
          </div>
        </div>
        <div className="map-ctl relative">
        <button
          type="button"
          aria-label={isFullscreen ? 'Exit full screen' : 'View full screen'}
          aria-pressed={isFullscreen}
          className="flex h-8 w-8 items-center justify-center rounded"
          style={controlButtonStyle}
          onClick={toggleFullscreen}
        >
          {/* Inline SVG, not a glyph: the exit icon used to be U+1F87C,
              which most Windows/Android system fonts have no glyph for --
              so the button appeared EMPTY exactly while fullscreen. */}
          <svg
            viewBox="0 0 16 16"
            className="h-4 w-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            {isFullscreen ? (
              <>
                {/* Arrows pointing inward: leave fullscreen. */}
                <path d="M6 2v4H2" />
                <path d="M10 2v4h4" />
                <path d="M6 14v-4H2" />
                <path d="M10 14v-4h4" />
              </>
            ) : (
              <>
                {/* Corner brackets pointing outward: enter fullscreen. */}
                <path d="M2 6V2h4" />
                <path d="M14 6V2h-4" />
                <path d="M2 10v4h4" />
                <path d="M14 10v4h-4" />
              </>
            )}
          </svg>
        </button>
          <div className="map-tooltip">
            <span className="map-tooltip-bubble">
              {isFullscreen ? 'Exit full screen' : 'Full screen'}
            </span>
          </div>
        </div>
      </div>

      {/* Attribution (Phase 4): required for the NASA imagery, honest for
          Natural Earth. Rendered as chrome, not data, and kept out of the
          pointer path. */}
      <div
        className="pointer-events-none absolute bottom-1.5 right-1.5 z-10 rounded px-1.5 py-0.5 text-[10px] leading-tight"
        style={{
          background: 'rgba(10, 14, 20, 0.55)',
          color: 'rgba(255, 255, 255, 0.85)',
        }}
      >
        {attribution}
      </div>

      {/* Terrain canvas: BELOW the svg in paint order, so every interactive
          surface stays untouched SVG. Mounted only in satellite view. */}
      {satellite && (
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full"
          aria-hidden="true"
        />
      )}

      {/* Drag-frame canvas (round-2 §35): paints the globe while a drag or
          its inertia is live, standing in for the hidden SVG. Inert. */}
      <canvas
        ref={dragCanvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ display: 'none' }}
        aria-hidden="true"
      />

      {/* Country popover (round-2 §36): near the cursor/tap point, flipped
          away from whichever edges are close; pinned (touch) popovers sit
          ABOVE the tap so the finger never covers them. */}
      {popover && popoverActive && renderPopover && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label={`${popover.target.name} quick facts`}
          className="map-popover absolute z-20"
          style={(() => {
            const w = containerSize.w || 1
            const h = containerSize.h || 1
            const style: React.CSSProperties = {}
            if (popover.pinned) {
              style.left = Math.max(8, Math.min(popover.x - 110, w - 248))
              style.bottom = Math.min(h - 8, h - popover.y + 16)
            } else {
              if (popover.x < w * 0.55) style.left = popover.x + 14
              else style.right = w - popover.x + 14
              if (popover.y < h - 180) style.top = popover.y + 12
              else style.bottom = h - popover.y + 12
            }
            return style
          })()}
        >
          <div className="flex items-start gap-1.5">
            <div className="min-w-0 flex-1">
              {renderPopover(popover.target)}
            </div>
            <button
              type="button"
              aria-label="Close"
              className="popover-close"
              onClick={() => setPopover(null)}
            >
              ×
            </button>
          </div>
        </div>
      )}

    <svg
      ref={svgRef}
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      className={
        // `relative` matters: the terrain canvas is absolutely positioned,
        // and only a positioned svg is guaranteed to paint above it.
        isFullscreen
          ? 'relative h-full w-full touch-none'
          : 'relative h-auto w-full touch-none'
      }
      role="group"
      aria-label={
        `World map, ${isGlobe ? 'globe view' : 'equal-area projection'}, ` +
        `${imagery ? `${imagery} base, ` : ''}` +
        `${focusTargets.length} entities. ` +
        `Use the arrow keys to move between countries and Enter to open one. ` +
        `Home and End jump to the westernmost and easternmost.`
      }
      style={{
        background: satellite ? 'transparent' : backgroundFill,
        cursor: isGlobe ? 'grab' : undefined,
      }}
      onPointerLeave={(event) => {
        dragPointers.current.delete(event.pointerId)
        onHover(null)
        // Keep the popover if the pointer is moving INTO it (to reach its
        // "More info" link); clear otherwise, unless a tap pinned it.
        const into = popoverRef.current?.contains(
          event.relatedTarget as Node | null,
        )
        if (!into) setPopover((prev) => (prev?.pinned ? prev : null))
      }}
      onClick={(event) => {
        // A click on open water or space dismisses a pinned popover.
        if (event.target === event.currentTarget) setPopover(null)
      }}
      onPointerDown={handleGlobePointerDown}
      onPointerMove={handleGlobePointerMove}
      onPointerUp={handleGlobePointerEnd}
      onPointerCancel={handleGlobePointerEnd}
      onKeyDown={handleKeyDown}
    >
      <defs>
        {/* Hatch marks contested entities so their status is never carried by
            colour alone -- required for CVD readers and forced-colors mode. */}
        <pattern
          id="contested-hatch"
          width="6"
          height="6"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="6" height="6" fill="transparent" />
          <line
            x1="0" y1="0" x2="0" y2="6"
            stroke={landStroke}
            strokeWidth="1.6"
            opacity="0.75"
          />
        </pattern>
      </defs>

      <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
        {/* The ocean disc/outline lives INSIDE the zoom transform: outside
            it, zooming scaled the landmasses while the globe's blue circle
            stayed fixed -- land visibly outgrew its own planet. */}
        <path
          d={sphere}
          fill={satellite ? 'transparent' : waterFill}
          onClick={() => setPopover(null)}
        />
        {shapes.map((shape, index) => {
          const row = populationByIso3.get(shape.iso3)
          const dimmed = isDimmed(shape.continent)
          const target: HoverTarget = {
            iso3: shape.iso3,
            name: shape.name,
            continent: shape.continent,
            contested: shape.contested,
            isMarker: false,
          }
          return (
            <path
              // Key on identity + position in the feature list, NEVER on the
              // path string: a d-derived key changes every rotation frame,
              // which remounts all ~250 nodes per frame instead of updating
              // one attribute (and duplicate iso3s -- SOM, CYP -- collide).
              key={`${shape.iso3}-${index}`}
              ref={registerNode(shape.iso3)}
              d={shape.d}
              fill={fillFor(shape)}
              fillOpacity={
                satellite && hovered?.iso3 === shape.iso3 ? 0.45 : 1
              }
              stroke={mode === 'continent' ? fillFor(shape) : countryStroke}
              strokeWidth={countryStrokeWidth}
              strokeLinejoin="round"
              opacity={dimmed ? 0.45 : 1}
              tabIndex={tabIndexFor(shape.iso3)}
              role="link"
              aria-label={
                mode === 'continent'
                  ? `${shape.name}, ${CONTINENTS[shape.continent]}. Open continent page.`
                  : row?.available
                    ? `${shape.name}. Open country page.`
                    : `${shape.name}. No population data available. Open country page.`
              }
              className="map-target"
              onPointerEnter={(event) => {
                onHover(target)
                showHoverPopover(target, event)
              }}
              onFocus={() => {
                const index = indexByIso3.get(shape.iso3)
                if (index !== undefined) setActiveIndex(index)
                onHover(target)
                if (mode === 'continent') onActiveContinentChange(shape.continent)
              }}
              onClick={(event) => selectUnlessDragging(target, event)}
            />
          )
        })}

        {/* Phase 4 detail layers: lakes, rivers, admin-1 borders. Inert to
            pointers (the country beneath keeps the hit target) and hidden
            while the globe is actively spinning -- they reproject on settle
            (see detailPaths). Zoom-gated so the world view stays clean. */}
        {detailPaths && mode === 'country' && (
          <g pointerEvents="none" aria-hidden="true">
            {transform.k >= DETAIL_ZOOM.water50 && detailPaths.lakes && (
              <path
                d={detailPaths.lakes}
                fill={waterFill}
                fillOpacity={satellite ? 0.5 : 0.92}
                stroke="none"
              />
            )}
            {transform.k >= DETAIL_ZOOM.water50 && detailPaths.rivers && (
              <path
                d={detailPaths.rivers}
                fill="none"
                stroke={waterFill}
                strokeOpacity={satellite ? 0.55 : 0.8}
                strokeWidth={0.6 / transform.k}
                strokeLinecap="round"
              />
            )}
            {detailPaths.admin1 && (
              <path
                d={detailPaths.admin1}
                fill="none"
                stroke={
                  imagery === 'satellite'
                    ? 'rgba(255, 255, 255, 0.55)'
                    : imagery === 'terrain'
                      ? 'rgba(92, 71, 48, 0.5)'
                      : landStroke
                }
                strokeOpacity={satellite ? 1 : 0.45}
                strokeWidth={0.32 / transform.k}
                strokeLinejoin="round"
              />
            )}
          </g>
        )}

        {/* Contested overlay, drawn above fills and inert to pointer events so
            it never steals the hit target from the country beneath it. */}
        {shapes
          .map((shape, index) => ({ shape, index }))
          .filter(({ shape }) => shape.contested)
          .map(({ shape, index }) => (
            <path
              key={`hatch-${shape.iso3}-${index}`}
              d={shape.d}
              fill="url(#contested-hatch)"
              stroke="none"
              pointerEvents="none"
              opacity={isDimmed(shape.continent) ? 0.4 : 1}
            />
          ))}

        {markerPoints.map(({ marker, x, y }) => {
          const focused = hovered?.iso3 === marker.iso3
          const target: HoverTarget = {
            iso3: marker.iso3,
            name: marker.name,
            continent: marker.continent,
            contested: marker.contested,
            isMarker: true,
          }
          return (
            <g
              key={marker.iso3}
              ref={registerNode(marker.iso3)}
              transform={`translate(${x},${y})`}
              tabIndex={tabIndexFor(marker.iso3)}
              role="link"
              aria-label={`${marker.name}. Too small to draw at this scale; shown as a marker. Open country page.`}
              className="map-target"
              onPointerEnter={(event) => {
                onHover(target)
                showHoverPopover(target, event)
              }}
              onFocus={() => {
                const index = indexByIso3.get(marker.iso3)
                if (index !== undefined) setActiveIndex(index)
                onHover(target)
              }}
              onClick={(event) => selectUnlessDragging(target, event)}
            >
              <circle
                r={MARKER_HIT_RADIUS / transform.k}
                fill="transparent"
                stroke="none"
              />
              <circle
                r={(focused ? MARKER_RADIUS + 1.5 : MARKER_RADIUS) / transform.k}
                fill={focused ? 'var(--map-accent-fill)' : landNeutral}
                stroke={landStroke}
                strokeWidth={strokeWidth}
              />
            </g>
          )
        })}

        {/* Country name labels, visible by default for shapes large enough
            at the current zoom; the hovered entity is always labelled and
            emphasized. The side readout panel remains the accessible surface
            (aria-live, keyboard parity); these are visual duplicates and are
            aria-hidden so screen readers do not hear every name twice.
            On the globe (light land in both themes) labels are dark text
            with a light halo; flat views follow the theme. */}
        {visibleLabels.map((label) => (
          <text
            key={label.key}
            x={label.x}
            y={label.y}
            textAnchor="middle"
            pointerEvents="none"
            aria-hidden="true"
            // Dividing by k would hold labels at a constant on-screen size
            // while the land grows under them, which reads as "the names
            // stay tiny" on a phone. Dividing by sqrt(k) instead lets the
            // on-screen size grow with the square root of the zoom: at 4x
            // zoom names are twice as big, at 9x three times -- larger, but
            // never billboard-sized.
            fontSize={(label.emphasized ? 13 : 10) / Math.sqrt(transform.k)}
            style={{
              // Land is light in every view now, so labels are dark text
              // with a light halo regardless of theme.
              fill: 'oklch(20% 0.01 250)',
              paintOrder: 'stroke',
              stroke: GLOBE_LAND_NEUTRAL,
              strokeWidth: (label.emphasized ? 3.5 : 2.5) / Math.sqrt(transform.k),
              strokeLinejoin: 'round',
              fontWeight: label.emphasized ? 600 : 500,
            }}
          >
            {label.name}
          </text>
        ))}

        {/* Phase 4 detail labels: capitals, towns, states/provinces and water
            names, zoom-progressive and collision-culled against the country
            names (see detailLabels). Visual duplicates of nothing a screen
            reader needs -- the readout panel stays the accessible surface --
            so the group is aria-hidden like the country labels above. */}
        {detailLabels.length > 0 && (
          <g pointerEvents="none" aria-hidden="true">
            {detailLabels.map((label) => {
              const fontSize = label.size / Math.sqrt(transform.k)
              const isPlace = label.kind === 'place' || label.kind === 'capital'
              const dark = imagery === 'satellite'
              const fill =
                label.kind === 'water'
                  ? dark
                    ? 'oklch(88% 0.05 240)'
                    : 'oklch(42% 0.08 250)'
                  : dark
                    ? 'oklch(97% 0 0)'
                    : 'oklch(28% 0.01 250)'
              const halo = dark
                ? 'oklch(22% 0.02 250)'
                : GLOBE_LAND_NEUTRAL
              return (
                <g key={label.key}>
                  {isPlace && (
                    <circle
                      cx={label.x}
                      cy={label.y}
                      r={
                        (label.kind === 'capital' ? 1.6 : 1.1) /
                        Math.sqrt(transform.k)
                      }
                      fill={fill}
                      stroke={halo}
                      strokeWidth={0.5 / Math.sqrt(transform.k)}
                    />
                  )}
                  <text
                    x={label.x}
                    y={
                      isPlace
                        ? label.y - 2.4 / Math.sqrt(transform.k)
                        : label.y
                    }
                    textAnchor="middle"
                    fontSize={fontSize}
                    fontStyle={label.kind === 'water' ? 'italic' : undefined}
                    style={{
                      fill,
                      paintOrder: 'stroke',
                      stroke: halo,
                      strokeWidth: 2 / Math.sqrt(transform.k),
                      strokeLinejoin: 'round',
                      fontWeight: label.kind === 'capital' ? 600 : 400,
                    }}
                  >
                    {label.text}
                  </text>
                </g>
              )
            })}
          </g>
        )}

        {/* Continent labels. Identity comes from label + position, never hue --
            seven categorical fills cannot clear the all-pairs CVD floors, so
            the map uses emphasis plus text instead. */}
        {mode === 'continent' &&
          (Object.keys(CONTINENTS) as ContinentKey[]).map((key) => {
            const members = shapes.filter((shape) => shape.continent === key)
            if (members.length === 0) return null
            const x =
              members.reduce((sum, s) => sum + s.centroid[0], 0) / members.length
            const y =
              members.reduce((sum, s) => sum + s.centroid[1], 0) / members.length
            if (!Number.isFinite(x) || !Number.isFinite(y)) return null
            return (
              <text
                key={`label-${key}`}
                x={x}
                y={y}
                textAnchor="middle"
                pointerEvents="none"
                fontSize={12 / Math.sqrt(transform.k)}
                style={{
                  fill: 'oklch(20% 0.01 250)',
                  paintOrder: 'stroke',
                  stroke: GLOBE_LAND_NEUTRAL,
                  strokeWidth: 3 / Math.sqrt(transform.k),
                  strokeLinejoin: 'round',
                  fontWeight: 600,
                }}
              >
                {CONTINENTS[key]}
              </text>
            )
          })}
      </g>

      {/* Deliberately no <svg><title> here (2026-09-05, maintainer request):
          browsers render it as a native tooltip over the whole map, which
          surfaced on every country hover in fullscreen. The accessible name
          is the aria-label on this <svg> (which wins over <title> for the
          name anyway), and the focused country announces itself through the
          per-shape aria-labels. */}
    </svg>
    </div>
  )
}
