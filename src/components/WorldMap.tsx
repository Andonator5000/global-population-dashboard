import {
  geoArea,
  geoBounds,
  geoCentroid,
  geoDistance,
  geoPath,
  type GeoPermissibleObjects,
} from 'd3-geo'
import { select } from 'd3-selection'
// Side-effect import: gives d3 selections a .transition() so button zoom
// can ease through the same zoom behaviour (round-2 §35).
import 'd3-transition'
import { zoom, zoomIdentity, type D3ZoomEvent } from 'd3-zoom'
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { feature, mesh } from 'topojson-client'

import {
  loadAdmin1Labels,
  loadDetailLayer,
  loadPlaces,
  type Admin1Label,
  type DetailCollection,
  type PlacePoint,
} from '../lib/mapdetail'
import { canvasPixelRatio } from '../lib/device'
import {
  GlobeGL,
  resolveCssColor,
  supportsWebGL2,
  type ImageryRenderer,
} from '../lib/globegl'
import { IMAGERY_GRADES } from '../lib/mapgrade'
import {
  buildPoliticalRaster,
  politicalRasterSignature,
  type PoliticalRasterSpec,
} from '../lib/politicalraster'
import { Canvas2DImagery } from '../lib/terrain'
import { GLOW_CSS, GLOW_REACH, drawGlowRing } from '../lib/globegl'
import {
  createSky,
  fovForDisc,
  loadSky,
  skyCentreForGlobe,
  type SkyData,
  type SkyRenderer,
} from '../lib/sky'
import { DATA_BASE_URL } from '../config'
import { ZoomControls } from './ZoomControls'

import {
  CONTINENTS,
  DEFAULT_MAP_PALETTE,
  type BaseViewKey,
  type ContinentKey,
  type MapPaletteKey,
  type ProjectionKey,
} from '../config'
import { createProjection, fitProjection, type Rotation } from '../lib/projection'
import * as versor from '../lib/versor'
import type {
  CountryGeometryProperties,
  CountryTopology,
  MapMarker,
  PopulationRow,
} from '../types'

const VIEW_WIDTH = 1000
const VIEW_HEIGHT = 480
/**
 * Round 5 (§53.1): on a phone the globe gets a SQUARE frame. The 1000×480
 * viewBox is right for a 2:1 equal-area world map, but it gave the globe
 * a disc 480 units tall in the middle of a wide strip — at 350 css px
 * that was a 168 px globe. A 1000×1000 viewBox fits the disc to the full
 * width, so the globe is as large as the screen allows. Flat projections
 * keep 1000×480.
 */
const VIEW_HEIGHT_COMPACT_GLOBE = 1000
/** Container widths below this get the phone layout: square globe,
 *  bottom sheet, thumb-sized controls. */
const COMPACT_MAX_WIDTH = 640
/** Initial orientation [lambda, phi, gamma]; the compass returns gamma to 0. */
const INITIAL_ROTATION: Rotation = [-10, -20, 0]

/**
 * Round 12 (section 62): the globe is dragged the way Google Earth is
 * dragged -- the place under the finger stays under the finger (versor
 * dragging, src/lib/versor.ts), so there is no degrees-per-pixel constant
 * any more: the pace is the disc's own geometry, exact at every zoom.
 * History for the record: 0.25 -> 0.375 -> 0.5625 -> 0.25 -> 0.375 deg/px
 * over rounds 6-9, each a compromise between "too slow" and "spins like
 * mad"; the compromise was the wrong model.
 *
 * Momentum is the last frame's rotation (a quaternion) applied again each
 * frame and shrunk by INERTIA_DECAY per 60 Hz frame (time-based, so a
 * 120 Hz phone coasts the same distance). A flick may start at most
 * INERTIA_MAX_DEG_PER_FRAME degrees per frame -- a hard flick carries the
 * globe well over half a turn and settles in about two seconds.
 */
const INERTIA_DECAY = 0.93
const INERTIA_MAX_DEG_PER_FRAME = 15
/** Below this per-frame angle the coast is over and the rotation commits. */
const INERTIA_STOP_DEG = 0.02
/** A release more than this long after the last movement is a hold, not
    a flick: no momentum. */
const INERTIA_STALE_MS = 80
/** Anchors sit inside the limb: a finger dragged past the edge keeps a
    stable point to hold on to. Fraction of the disc radius. Round 13: 0.985
    let a finger at the very edge, where a pixel is many degrees, whip the
    globe round; 0.95 keeps the outermost anchor a sane distance in. */
const DISC_CLAMP = 0.95
/** Atmosphere glow strength (round 13): the soft blue halo outside the
    limb, as Google Earth draws it. Shared by the GL pass, the SVG ring at
    rest on the political globe, and the 2-D fallbacks. */
const GLOBE_GLOW = 0.85
/** The halo's profile as [distance outside the limb in disc radii, alpha
    factor]: the same exp(-d / 0.06) fall-off the GL shader computes, so
    the political globe at rest and the imagery views agree. */
const GLOW_STOPS: [number, number][] = [0, 0.02, 0.04, 0.07, 0.1, 0.14, 0.2].map((d) => [
  d,
  Math.exp(-d / 0.06) * (1 - Math.min(1, d / 0.2)),
])
/** Sky field of view gain over the physically exact value (section 67).
    1 = exact: the orthographic Earth occults exactly the hemisphere behind
    it, so its limb is 90 degrees of sky. Wider values shrink the sky's scale
    until the limb passes 90 degrees and every visible star is culled behind
    the disc -- measured, not guessed: 1.5 painted nothing. */
const SKY_FOV_GAIN = 1
/** The most a single drag frame may turn the globe (degrees). Near the
    limb the exact solve asks for huge turns from small finger movements
    (the "spinning rapidly and uncontrollably" report, round 13); beyond
    this the frame moves the anchor as far as it can and re-anchors, so
    the globe follows the hand at a bounded pace instead of flying. */
const DRAG_MAX_DEG_PER_FRAME = 8
/** A single pointer must move this far (CSS px) before it is a drag. */
const DRAG_START_PX = 4

/**
 * Keep lambda in [-180, 180). The drag accumulates it without bound (a
 * few fast spins reach thousands of degrees) and d3 does not care -- but
 * the GPU does: mobile GPUs evaluate sin/cos of large arguments with
 * visibly reduced precision, and the imagery (inverse path, atan/asin)
 * and the outline lines (forward path, sin/cos) then land in different
 * places. That was the "white outlines drift when the globe spins fast"
 * report (section 54.2). Wrapped at every write of the rotation ref.
 */
function wrapLongitude(lambda: number): number {
  return ((((lambda + 180) % 360) + 360) % 360) - 180
}

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

/**
 * Political drag frames come from the GPU raster (section 51) up to this
 * zoom factor. Past it a raster texel (0.088 degrees) would span more
 * than ~1.5 screen pixels and the fill edges would visibly soften, so
 * deeper drags go back to vector frames -- but CULLED to the countries
 * whose bounds touch the viewport, which at 6x and beyond is a handful,
 * not 250. Either way a frame stays a few milliseconds.
 */
const RASTER_DRAG_MAX_ZOOM = 6

export interface HoverTarget {
  iso3: string
  name: string
  continent: ContinentKey
  contested: boolean
  isMarker: boolean
}

/** Imperative surface for the search box (round 5, §53.4). */
export interface WorldMapHandle {
  /** Rotate/zoom to an entity and open its sheet (or popover). */
  flyTo: (iso3: string) => void
  /** Level the globe so north is straight up, keeping the longitude under
   *  the centre and the zoom (round 9, section 59.3). */
  northUp: () => void
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
   * renders satellite imagery (EOX Sentinel-2 cloudless since round 6,
   * section 56) beneath transparent country shapes.
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
  /**
   * Round 5 (§53.2): on touch and on compact widths a tap no longer pins
   * a popover over the globe; it highlights the country and opens a
   * bottom sheet under the map with this content. `expanded` is the
   * swiped-up state (more detail); collapsed shows the headline only.
   */
  renderSheet?: (target: HoverTarget, expanded: boolean) => React.ReactNode
  /** Notified when the sheet's selection changes (null = closed). */
  onPick?: (target: HoverTarget | null) => void
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
/** Labels stop growing once they are this many times their zoom-1 size. */
const LABEL_GROWTH_CAP = 3

/**
 * Neutral land colour for the globe view, mirroring the LIGHT --map-land.
 * The globe is sunlit land on a dark ocean in BOTH themes, so the dark
 * theme's land neutral (L 0.34) would sink into the ocean (L 0.31).
 */
const GLOBE_LAND_NEUTRAL = 'oklch(84% 0.014 250)'

/**
 * Antique direction (round 3, DATA_DECISIONS section 48; maintainer pick
 * "A / Blaeu 1635"). The palette build emits its fills; these are the
 * SHEET colours -- parchment paper and sea, umber engraved linework --
 * measured from the Blaeu scan. Theme-invariant by design (a parchment
 * sheet does not change at night). Since round 4 (section 51.4) the
 * space past the projection edge is black in this direction too, like
 * every other view -- Andy's ruling: the surround is space, and the
 * parchment stops at the planet. `paper` survives as the label halo.
 * Literal hex (not CSS vars) because the drag-frame canvas needs
 * resolvable colours.
 */
const ANTIQUE = {
  paper: '#eddcbd',
  sea: '#e9dfca',
  line: '#594330',
  ink: '#422e1e',
  coast: '#b7a087',
  noData: '#ddd7c9',
  lineRgba: [89 / 255, 67 / 255, 48 / 255, 0.85] as [number, number, number, number],
}

interface FocusTarget extends HoverTarget {
  x: number
  y: number
}

interface LonLatWindow {
  lonMin: number
  lonMax: number
  latMin: number
  latMax: number
}

/**
 * Lon/lat extent of the viewport under a zoomed globe (section 51.2), from
 * inverting a coarse grid of screen points. Any sample that misses the
 * sphere means the limb is in view, and then nothing is culled (null):
 * a window that reaches the horizon has no cheap honest bound.
 */
function visibleLonLatWindow(
  projection: { invert?: (p: [number, number]) => [number, number] | null },
  transform: { x: number; y: number; k: number },
  cssW: number,
  cssH: number,
  scale: number,
  offsetX: number,
  offsetY: number,
): LonLatWindow | null {
  if (!projection.invert || transform.k < 1.5) return null
  const centre = projection.invert([
    ((cssW / 2 - offsetX) / scale - transform.x) / transform.k,
    ((cssH / 2 - offsetY) / scale - transform.y) / transform.k,
  ])
  if (!centre || !Number.isFinite(centre[0])) return null
  const centreLon = centre[0]
  let lonMin = Infinity
  let lonMax = -Infinity
  let latMin = Infinity
  let latMax = -Infinity
  for (let i = 0; i <= 4; i += 1) {
    for (let j = 0; j <= 3; j += 1) {
      const vx = (((cssW * i) / 4 - offsetX) / scale - transform.x) / transform.k
      const vy = (((cssH * j) / 3 - offsetY) / scale - transform.y) / transform.k
      const p = projection.invert([vx, vy])
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) return null
      let lon = p[0]
      while (lon - centreLon > 180) lon -= 360
      while (lon - centreLon < -180) lon += 360
      if (lon < lonMin) lonMin = lon
      if (lon > lonMax) lonMax = lon
      if (p[1] < latMin) latMin = p[1]
      if (p[1] > latMax) latMax = p[1]
    }
  }
  // d3's inverse is only exact on the front hemisphere; a screen point
  // just past the limb inverts to a near-side point instead of failing,
  // so pad generously. Culling only has to be safe, not tight.
  return { lonMin: lonMin - 3, lonMax: lonMax + 3, latMin: latMin - 3, latMax: latMax + 3 }
}

/** Per-feature geoBounds for a detail collection, computed once (WeakMap
 *  keyed by the collection object; the loaders cache collections). */
const detailBoundsCache = new WeakMap<object, [[number, number], [number, number]][]>()
function detailBounds(collection: DetailCollection): [[number, number], [number, number]][] {
  let bounds = detailBoundsCache.get(collection)
  if (!bounds) {
    bounds = collection.features.map((feature) =>
      geoBounds(feature as unknown as GeoPermissibleObjects),
    )
    detailBoundsCache.set(collection, bounds)
  }
  return bounds
}

/** Does a feature's geoBounds box touch the window? Longitudes are
 *  compared on the circle, so both antimeridian conventions work. */
function boundsTouch(
  bounds: [[number, number], [number, number]],
  window: LonLatWindow,
): boolean {
  const [[west, south], [east, north]] = bounds
  if (north < window.latMin || south > window.latMax) return false
  const spans: [number, number][] =
    west <= east ? [[west, east]] : [[west, 180], [-180, east]]
  for (const [a, b] of spans) {
    for (const shift of [-360, 0, 360]) {
      if (a + shift <= window.lonMax && b + shift >= window.lonMin) return true
    }
  }
  return false
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

export const WorldMap = forwardRef<WorldMapHandle, WorldMapProps>(function WorldMap({
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
  renderSheet,
  onPick,
}: WorldMapProps, handleRef) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  /** The stage: canvases + svg + overlay controls; what is measured. */
  const containerRef = useRef<HTMLDivElement | null>(null)
  /** The frame: stage + bottom sheet; what goes full screen (§53.3). */
  const frameRef = useRef<HTMLDivElement | null>(null)
  const behaviourRef = useRef<ReturnType<typeof zoom<SVGSVGElement, unknown>> | null>(null)
  const nodeRefs = useRef(new Map<string, SVGGraphicsElement>())
  const [transform, setTransform] = useState(() => zoomIdentity)
  /** The zoom transform as the drag/animation frames read it (round 9):
      React state lags a frame behind an animation that moves the pan. */
  const transformRef = useRef(transform)
  transformRef.current = transform
  const [nativeFullscreen, setNativeFullscreen] = useState(false)
  /** iOS Safari has no element fullscreen: "Explore globe" then pins the
      frame over the page with CSS instead (§53.3). */
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false)
  const isFullscreen = nativeFullscreen || pseudoFullscreen

  const isGlobe = projectionKey === 'globe'
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  })
  /** Phone layout (§53): decided by the stage's own width, seeded from the
      window before the first measurement so the first paint is right. */
  const compact =
    containerSize.w > 0
      ? containerSize.w < COMPACT_MAX_WIDTH
      : typeof window !== 'undefined' && window.innerWidth < COMPACT_MAX_WIDTH
  const viewW = VIEW_WIDTH
  const viewH = isGlobe && compact ? VIEW_HEIGHT_COMPACT_GLOBE : VIEW_HEIGHT
  /**
   * Globe orientation: [lambda, phi] in degrees, driven by dragging. A slight
   * initial tilt so the first view is not dead-on the equator/meridian cross.
   */
  const [rotation, setRotation] = useState<Rotation>(INITIAL_ROTATION)
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

  /**
   * Round 4 (section 51.2): spherical centroid and area of every feature,
   * computed ONCE. The settle after a drag used to run three full
   * geometry passes per country -- path(), path.centroid() and
   * path.area() -- to place and gate its label; the last two are now a
   * point projection and a multiplication (see the shapes memo).
   */
  const staticGeometry = useMemo(
    () =>
      collection.features.map((item) => ({
        centroid: geoCentroid(item as unknown as GeoPermissibleObjects),
        /** Steradians. */
        area: geoArea(item as unknown as GeoPermissibleObjects),
        /** [[west, south], [east, north]]; west > east straddles the
            antimeridian. Used to cull zoomed-in vector drag frames. */
        bounds: geoBounds(item as unknown as GeoPermissibleObjects),
      })),
    [collection],
  )

  /** Merged land outline, for the antique coast band (section 48). */
  const landFeature = useMemo(
    () =>
      topology.objects.land
        ? (feature(topology as never, topology.objects.land as never) as unknown)
        : null,
    [topology],
  )

  /**
   * Round 3 (§43): country outlines as great-circle line segments for the
   * WebGL drag frames. Shared borders come from the topology mesh once,
   * and every segment is subdivided to <= 1 degree along the great circle
   * -- the same arc d3 draws between two vertices -- so the GL lines land
   * exactly where the SVG strokes will when the drag ends.
   */
  const borderSegments = useMemo(() => {
    const lines = mesh(topology as never, topology.objects.countries as never)
    const out: number[] = []
    const rad = Math.PI / 180
    const push = (lon: number, lat: number) => {
      out.push(lon * rad, lat * rad)
    }
    for (const line of lines.coordinates as [number, number][][]) {
      for (let i = 1; i < line.length; i += 1) {
        const [lon0, lat0] = line[i - 1] as [number, number]
        const [lon1, lat1] = line[i] as [number, number]
        // Natural Earth splits Russia, Fiji and Antarctica at the
        // antimeridian and closes Antarctica along the pole; those cut
        // edges are data seams, not borders, and the GL pass (which now
        // draws the outlines at rest too, section 57.2) must not stroke a
        // line down the middle of the Pacific.
        if (Math.abs(lon0) >= 179.999 && Math.abs(lon1) >= 179.999) continue
        if (Math.abs(lat0) >= 89.999 && Math.abs(lat1) >= 89.999) continue
        const distance = geoDistance([lon0, lat0], [lon1, lat1]) / rad
        const pieces = Math.max(1, Math.ceil(distance))
        if (pieces === 1) {
          push(lon0, lat0)
          push(lon1, lat1)
          continue
        }
        // Slerp between the two unit vectors.
        const a = [
          Math.cos(lat0 * rad) * Math.cos(lon0 * rad),
          Math.cos(lat0 * rad) * Math.sin(lon0 * rad),
          Math.sin(lat0 * rad),
        ]
        const b = [
          Math.cos(lat1 * rad) * Math.cos(lon1 * rad),
          Math.cos(lat1 * rad) * Math.sin(lon1 * rad),
          Math.sin(lat1 * rad),
        ]
        const omega = Math.acos(
          Math.max(-1, Math.min(1, a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!)),
        )
        const so = Math.sin(omega)
        let prevLon = lon0
        let prevLat = lat0
        for (let k = 1; k <= pieces; k += 1) {
          const t = k / pieces
          const wa = so === 0 ? 1 - t : Math.sin((1 - t) * omega) / so
          const wb = so === 0 ? t : Math.sin(t * omega) / so
          const x = wa * a[0]! + wb * b[0]!
          const y = wa * a[1]! + wb * b[1]!
          const z = wa * a[2]! + wb * b[2]!
          const lon = k === pieces ? lon1 : Math.atan2(y, x) / rad
          const lat = k === pieces ? lat1 : Math.asin(Math.max(-1, Math.min(1, z))) / rad
          push(prevLon, prevLat)
          push(lon, lat)
          prevLon = lon
          prevLat = lat
        }
      }
    }
    return new Float32Array(out)
  }, [topology])

  /** The merged land outline is only drawn by the antique political
      sheet; its full geometry pass is skipped everywhere else. */
  const needLand =
    paletteDirection === 'antique' && mode === 'country' && baseView === 'political'

  const { shapes, sphere, landD, markerPoints, projection } = useMemo(() => {
    const base = createProjection(projectionKey)
    if (isGlobe) base.rotate(rotation)
    const projection = fitProjection(base, viewW, viewH)
    const path = geoPath(projection)
    const viewCenter: [number, number] = [-rotation[0], -rotation[1]]

    /** On the globe, points past the horizon project onto the near side and
        must be culled by great-circle distance from the view centre. */
    const pointVisible = (coordinates: [number, number]) =>
      !isGlobe || geoDistance(coordinates, viewCenter) <= Math.PI / 2

    // Projected area from the spherical area (section 51.2): every flat
    // projection here is equal-area, so px^2 = steradians x scale^2
    // exactly; on the orthographic globe a patch foreshortens by the
    // cosine of its angular distance from the view centre.
    const scale2 = projection.scale() * projection.scale()

    const built: CountryShape[] = []
    collection.features.forEach((item, index) => {
      const d = path(item as unknown as GeoPermissibleObjects)
      if (!d) return
      const stat = staticGeometry[index]!
      let centroid: [number, number]
      let areaPx: number
      const dist = isGlobe ? geoDistance(stat.centroid, viewCenter) : 0
      if (isGlobe && dist > Math.PI / 2 - 1e-6) {
        // Straddling the limb with its heart over the horizon: the label
        // must sit on the visible part, so this one still pays for the
        // planar centroid and area (a handful of countries per view).
        const pc = path.centroid(item as unknown as GeoPermissibleObjects)
        centroid = [pc[0], pc[1]]
        areaPx = path.area(item as unknown as GeoPermissibleObjects)
      } else {
        const p = projection(stat.centroid) ?? [NaN, NaN]
        centroid = [p[0], p[1]]
        areaPx = stat.area * scale2 * (isGlobe ? Math.cos(dist) : 1)
      }
      built.push({
        iso3: item.properties.iso3,
        name: item.properties.name,
        continent: item.properties.continent,
        contested: item.properties.contested,
        d,
        centroid,
        areaPx,
      })
    })

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
      landD:
        needLand && landFeature
          ? path(landFeature as GeoPermissibleObjects) ?? ''
          : '',
      markerPoints: points,
      projection,
    }
  }, [
    collection,
    staticGeometry,
    landFeature,
    needLand,
    markers,
    projectionKey,
    isGlobe,
    rotation,
    viewW,
    viewH,
  ])

  // ---- Phase 4: detail layers, terrain, and the satellite base view ------

  /** Which imagery base is live, if any: satellite (Sentinel-2, dark) or
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
    settledRotation[0] === rotation[0] &&
    settledRotation[1] === rotation[1] &&
    settledRotation[2] === rotation[2]
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
    // Round 10 (section 60): only the features whose bounds touch the
    // visible window are projected. At 18x the 10m rivers took 300 ms of
    // main thread per settle on a desktop -- seconds on a phone, which is
    // the "freezes so I can no longer move it" -- and nearly all of it was
    // geometry off screen.
    const window = visibleLonLatWindow(projection, transform, viewW, viewH, 1, 0, 0)
    const draw = (collection: DetailCollection | undefined) => {
      if (!collection) return ''
      if (!window) return path(collection as unknown as GeoPermissibleObjects) ?? ''
      const bounds = detailBounds(collection)
      const features = collection.features.filter((_, index) =>
        boundsTouch(bounds[index]!, window),
      )
      if (features.length === 0) return ''
      return path({ type: 'FeatureCollection', features } as unknown as GeoPermissibleObjects) ?? ''
    }
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
    Math.round(transform.x / 8),
    Math.round(transform.y / 8),
    viewW,
    viewH,
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
      if (x < -40 || x > viewW + 40 || y < -20 || y > viewH + 20) {
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
      const screenSize = size * Math.min(Math.sqrt(k), LABEL_GROWTH_CAP)
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
      const screenSize = (label.emphasized ? 13 : 10) * Math.min(Math.sqrt(k), LABEL_GROWTH_CAP)
      placed.push({
        x: label.x * k,
        y: label.y * k,
        w: label.name.length * screenSize * 0.62,
        h: screenSize * 1.5,
      })
    }

    const places = detail.places ?? []
    const window = visibleLonLatWindow(projection, transform, viewW, viewH, 1, 0, 0)
    for (const place of places) {
      const bonus = place.cap === 1 ? 2 : 0
      if (k < 3 + place.rank * 1.6 - bonus) continue
      // Cheap lon/lat window test before the projection (section 60).
      if (window && !boundsTouch([[place.lon, place.lat], [place.lon, place.lat]], window)) continue
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
        if (window && !boundsTouch([[label.lon, label.lat], [label.lon, label.lat]], window)) continue
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
        if (!collection) return
        const bounds = detailBounds(collection)
        for (const [index, item] of collection.features.entries()) {
          const name = item.properties.name
          if (!name) continue
          // path.centroid is a full geometry pass; skip what is off screen.
          if (window && !boundsTouch(bounds[index]!, window)) continue
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
  const rendererRef = useRef<ImageryRenderer | null>(null)
  /** Bumps when the active imagery's world base reaches the GPU; drives the
      loading pill only (tile arrivals repaint inside the renderer). */
  const [imageryVersion, setImageryVersion] = useState(0)

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

  /** Round 3 (§43): ONE imagery renderer for the component's lifetime.
      Its textures stay resident across Political / Satellite / Terrain
      switches, and both imagery sets' world bases are prefetched during
      idle time after first paint, so a second switch is immediate. WebGL2
      is the real renderer; the round-2 quad warp survives only as the
      fallback for browsers without it. */
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const initial = imagery === 'terrain' ? 'geo/terrain-hypso' : 'geo/terrain'
    const onReady = () => setImageryVersion((v) => v + 1)
    let renderer: ImageryRenderer
    try {
      renderer = supportsWebGL2()
        ? new GlobeGL(canvas, onReady, initial)
        : new Canvas2DImagery(canvas, onReady, initial)
    } catch (error) {
      console.warn('WebGL imagery unavailable, using the 2-D fallback:', error)
      renderer = new Canvas2DImagery(canvas, onReady, initial)
    }
    rendererRef.current = renderer
    renderer.setBorders(borderSegmentsRef.current)
    // A fresh renderer holds no raster: forget the previous one's (StrictMode
    // re-mounts this effect on the same component, and the refs survive).
    rasterOnGpu.current = false
    rasterSignature.current = null
    rasterRefused.current = false
    const idle =
      (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback
    const prefetch = () => {
      renderer.prefetch('geo/terrain')
      renderer.prefetch('geo/terrain-hypso')
    }
    const handle = idle
      ? idle(prefetch, { timeout: 4000 })
      : window.setTimeout(prefetch, 1500)
    return () => {
      if (idle) {
        (window as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle)
      } else {
        window.clearTimeout(handle)
      }
      renderer.destroy()
      rendererRef.current = null
    }
    // The initial imagery is only a starting point; switches go through
    // setImagery below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const borderSegmentsRef = useRef(borderSegments)
  useEffect(() => {
    borderSegmentsRef.current = borderSegments
    rendererRef.current?.setBorders(borderSegments)
  }, [borderSegments])

  useEffect(() => {
    if (!imagery) return
    rendererRef.current?.setImagery(
      imagery === 'terrain' ? 'geo/terrain-hypso' : 'geo/terrain',
    )
    setImageryVersion((v) => v + 1)
  }, [imagery])

  // useLayoutEffect, not useEffect (section 54.2): the SVG's outlines and
  // the GL imagery must change in the SAME paint. A passive effect ran
  // after the browser painted the re-projected SVG over the previous
  // imagery -- one frame of outlines out of step, every time the stage
  // resized or the sheet opened. And never mid-drag: the drag frames own
  // the canvas then, and a React commit during a gesture (a tile landing,
  // a pinch) must not repaint it from stale state.
  useLayoutEffect(() => {
    if (!satellite || isDragRendering.current) return
    const canvas = canvasRef.current
    const renderer = rendererRef.current
    if (!canvas || !renderer) return
    const { w, h } = containerSize
    if (w < 2 || h < 2) return
    // Backing-store cap (section 51.3): imagery is a picture, not text,
    // and past ~1.75 (1.25 on a phone) the extra pixels cost more than
    // they show.
    const dpr = canvasPixelRatio()
    const scale = Math.min(w / viewW, h / viewH)
    renderer.render({
      projection,
      projectionKey,
      isGlobe,
      rotation,
      transform,
      layout: {
        scale,
        offsetX: (w - viewW * scale) / 2,
        offsetY: (h - viewH * scale) / 2,
        dpr,
      },
      cssWidth: w,
      cssHeight: h,
      // Resolved ocean colour: canvas cannot use CSS custom properties.
      oceanFill:
        getComputedStyle(canvas).getPropertyValue('--map-ocean') || '#00355c',
      // Section 51.1: the palette's tone over the imagery.
      grade: IMAGERY_GRADES[paletteDirection],
      glow: GLOBE_GLOW,
      // Round 7 (section 57.2): at rest the outlines come from the SAME
      // GL pass as the imagery, exactly as during a drag. Two renderers
      // (SVG strokes over a GL picture) can only ever agree if they paint
      // in the same frame from the same numbers, and on Andy's phone they
      // did not; one renderer cannot disagree with itself. The SVG keeps
      // its transparent country shapes for hover, tap and keyboard, with
      // no stroke of its own in these views.
      borders:
        rendererRef.current instanceof Canvas2DImagery
          ? undefined
          : {
              color:
                imagery === 'terrain'
                  ? [92 / 255, 71 / 255, 48 / 255, 0.7]
                  : [1, 1, 1, 0.78],
            },
    })
  }, [
    satellite,
    projection,
    projectionKey,
    rotation,
    transform,
    containerSize,
    isGlobe,
    imageryVersion,
    paletteDirection,
    viewW,
    viewH,
  ])
  const imageryReady = !satellite || (rendererRef.current?.ready() ?? false)

  // Satellite credit (round 6, section 56): EOX requires its attribution
  // string verbatim, and CC BY-NC-SA asks for the licence to be named.
  const attribution =
    imagery === 'satellite'
      ? (
          <>
            Imagery:{' '}
            <a
              href="https://cloudless.eox.at"
              target="_blank"
              rel="noreferrer"
              className="pointer-events-auto underline underline-offset-2"
              style={{ color: 'inherit' }}
            >
              EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains
              modified Copernicus Sentinel data 2025)
            </a>
            , CC BY-NC-SA 4.0 · Borders, water, places: Natural Earth
          </>
        )
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
  const rotationRef = useRef<Rotation>(rotation)
  const isDragRendering = useRef(false)
  const restoreAfterCommit = useRef(false)
  /** The rotation the last drag frame applied (left-composed), and how
      long that frame was: momentum starts from it (round 12). */
  const frameVelocity = useRef<versor.Quaternion>([1, 0, 0, 0])
  const frameVelocityMs = useRef(16.7)
  const lastMoveAt = useRef(0)
  /** True when the last drag frame was a twist (roll): its momentum is a
      roll; otherwise the coast holds gamma exactly as the drag did. */
  const lastFrameWasRoll = useRef(false)
  const inertiaFrame = useRef<number | null>(null)
  const dragFills = useRef<{
    fills: string[]
    ocean: string
    stroke: string
    strokeRgba: [number, number, number, number]
  }>({ fills: [], ocean: '#00355c', stroke: '#00355c', strokeRgba: [1, 1, 1, 0.78] })

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
    // The GL canvas stood in for the political fills (section 51); at
    // rest the SVG's own background covers the view again.
    if (!satellite && canvasRef.current) canvasRef.current.style.display = 'none'
  }, [rotation, satellite])

  const layoutFor = useCallback((w: number, h: number) => {
    const scale = Math.min(w / viewW, h / viewH)
    return {
      scale,
      offsetX: (w - viewW * scale) / 2,
      offsetY: (h - viewH * scale) / 2,
      dpr: canvasPixelRatio(),
    }
  }, [viewW, viewH])

  /** The fitted globe's disc: centre and radius in view coordinates. */
  const disc = useMemo(() => {
    const proj = fitProjection(createProjection('globe'), viewW, viewH)
    const [cx, cy] = proj.translate()
    return { cx, cy, r: proj.scale() }
  }, [viewW, viewH])

  // ---- Round 13 (section 67): the real sky behind the Earth ------------
  //
  // A canvas beneath everything paints the Yale Bright Star Catalogue and
  // the IAU constellation figures as seen from the camera's side of the
  // Earth (src/lib/sky.ts): the direction the viewer looks from, at the
  // sidereal time of one date captured at mount. It is redrawn per drag
  // frame from the same rotation ref as the globe (0.6 ms), and at rest
  // from state. The antique direction keeps its engraved sheet free of it
  // (sections 57.3, 58.2), and the flat maps have no view direction.
  const showSky = isGlobe && paletteDirection !== 'antique'
  const skyCanvasRef = useRef<HTMLCanvasElement | null>(null)
  const skyRef = useRef<SkyRenderer | null>(null)
  const [skyData, setSkyData] = useState<SkyData | null>(null)
  const skyEpochRef = useRef(new Date())
  const skyDarkRef = useRef(
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  const skyReducedRef = useRef(
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  useEffect(() => {
    if (!showSky || skyData) return
    let live = true
    loadSky(`${DATA_BASE_URL}/geo/sky.json`)
      .then((data) => {
        if (live) setSkyData(data)
      })
      .catch(() => {
        /* no sky is the plain black surround of every earlier round */
      })
    return () => {
      live = false
    }
  }, [showSky, skyData])
  useEffect(() => {
    const canvas = skyCanvasRef.current
    if (!canvas || !skyData) return
    skyRef.current = createSky(canvas, skyData)
    // First paint: the at-rest effect below may already have run this
    // commit, before the renderer existed.
    const container = containerRef.current
    if (container) renderSky(container.clientWidth, container.clientHeight)
    return () => {
      skyRef.current?.destroy()
      skyRef.current = null
    }
    // renderSky is stable for a given layout; a new one re-creates nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skyData])
  /** Paint the sky for the current rotation/zoom refs at the given stage
      size. Cheap and idempotent; called per drag frame and at rest. */
  const renderSky = useCallback(
    (w: number, h: number) => {
      const sky = skyRef.current
      if (!sky || !showSky || w < 2 || h < 2) return
      const { scale, offsetX, offsetY } = layoutFor(w, h)
      const t = transformRef.current
      const cssDisc = {
        cx: offsetX + scale * (t.x + t.k * disc.cx),
        cy: offsetY + scale * (t.y + t.k * disc.cy),
        r: scale * t.k * disc.r,
      }
      sky.render({
        width: w,
        height: h,
        dpr: canvasPixelRatio(),
        disc: cssDisc,
        centre: skyCentreForGlobe(rotationRef.current, skyEpochRef.current),
        fov: fovForDisc(cssDisc, w, h) * SKY_FOV_GAIN,
        theme: skyDarkRef.current ? 'dark' : 'light',
        reducedMotion: skyReducedRef.current,
      })
    },
    [showSky, layoutFor, disc],
  )
  // At rest: the same inputs as the imagery render.
  useLayoutEffect(() => {
    if (isDragRendering.current) return
    const { w, h } = containerSize
    renderSky(w, h)
  }, [renderSky, rotation, transform, containerSize, skyData])

  /**
   * Section 51: the political fills as a GPU raster. `rasterSignature`
   * names the colours the resident raster was painted with; a drag whose
   * resolved colours differ repaints it first (synchronously, once) and
   * the idle prebuild below means that almost never happens at drag
   * start. `rasterOnGpu` is false when the renderer is the 2-D fallback,
   * which keeps its own canvas drag frames.
   */
  const rasterSignature = useRef<string | null>(null)
  const rasterOnGpu = useRef(false)
  /** Set once the renderer declines rasters (the 2-D fallback), so no
      further paint is wasted on it. */
  const rasterRefused = useRef(false)

  const ensurePoliticalRaster = useCallback(
    (spec: PoliticalRasterSpec) => {
      const renderer = rendererRef.current
      if (!renderer || rasterRefused.current) return
      const signature = politicalRasterSignature(spec)
      if (rasterOnGpu.current && rasterSignature.current === signature) return
      const raster = buildPoliticalRaster(collection.features, spec)
      rasterOnGpu.current = renderer.setRaster(raster)
      rasterRefused.current = !rasterOnGpu.current
      rasterSignature.current = rasterOnGpu.current ? signature : null
    },
    [collection],
  )

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
        return readVar('--map-no-data', 'oklch(92% 0.003 250)')
      }
      return readVar(
        `--fill-globe-${paletteDirection}-${props.iso3}`,
        GLOBE_LAND_NEUTRAL,
      )
    })
    const ocean = readVar('--map-ocean', '#00355c')
    // Political frames stroke borders in the ocean colour, as the SVG
    // does; the GL line pass needs it resolved to RGB (section 51).
    const oceanRgb = resolveCssColor(ocean)
    dragFills.current = {
      fills,
      ocean,
      stroke:
        imagery === 'satellite'
          ? 'rgba(255, 255, 255, 0.78)'
          : imagery === 'terrain'
            ? 'rgba(92, 71, 48, 0.7)'
            : ocean,
      strokeRgba:
        imagery === 'terrain'
          ? [92 / 255, 71 / 255, 48 / 255, 0.7]
          : imagery === 'satellite'
            ? [1, 1, 1, 0.78]
            : [oceanRgb[0], oceanRgb[1], oceanRgb[2], 1],
    }
    // Antique political frames: parchment sea, umber strokes (section 48).
    if (!satellite && mode === 'country' && paletteDirection === 'antique') {
      dragFills.current.ocean = ANTIQUE.sea
      dragFills.current.stroke = ANTIQUE.line
      dragFills.current.strokeRgba = ANTIQUE.lineRgba
    }
    if (!satellite) {
      ensurePoliticalRaster({ ocean: dragFills.current.ocean, fills })
    }
  }, [
    collection,
    satellite,
    imagery,
    mode,
    populationByIso3,
    paletteDirection,
    ensurePoliticalRaster,
  ])

  /** Paint the political raster during idle time whenever its inputs
      change, so the first drag after a palette switch starts at frame
      rate instead of paying for the paint (section 51). */
  useEffect(() => {
    if (satellite || !isGlobe) return
    const idle =
      (window as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback
    const run = () => buildDragFills()
    const handle = idle ? idle(run, { timeout: 2000 }) : window.setTimeout(run, 300)
    return () => {
      if (idle) {
        (window as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(handle)
      } else {
        window.clearTimeout(handle)
      }
    }
  }, [satellite, isGlobe, buildDragFills])

  const drawDragFrame = useCallback(() => {
    // Section 58.1: nothing paints outside a live session -- a stray frame
    // after the commit would move the canvas away from the SVG.
    if (!isDragRendering.current) return
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

    renderSky(w, h)
    const base = createProjection('globe')
    base.rotate(rotationRef.current)
    const frameProjection = fitProjection(base, viewW, viewH)

    // Satellite imagery keeps tracking the finger: the imagery renderer is
    // driven imperatively here, from the SAME rotation ref as the borders
    // below, because no React render happens mid-drag. Since round 4
    // (section 51) the POLITICAL globe takes the same path: its fills are
    // a resident world raster, so a frame is one GPU pass plus the border
    // lines -- the 250-path canvas repaint below is now only the no-WebGL2
    // fallback's frame.
    let glDrawsBorders = false
    // Round 13: a lost WebGL context painted nothing during a drag -- the
    // SVG hidden, the GL frames blank: "the globe disappears". A dead
    // context hands the frame to the 2-D vector path below.
    const glLost =
      rendererRef.current !== null &&
      !(rendererRef.current instanceof Canvas2DImagery) &&
      (rendererRef.current as { isLost?: () => boolean }).isLost?.() === true
    const useRaster =
      !satellite && !glLost && rasterOnGpu.current && transformRef.current.k < RASTER_DRAG_MAX_ZOOM
    // Political raster frames paint on the GL canvas, which sits under
    // the hidden SVG; it is shown for exactly those frames and put away
    // again when the rotation commits (see the restore effect).
    if (!satellite && canvasRef.current) {
      canvasRef.current.style.display = useRaster ? 'block' : 'none'
    }
    if ((satellite || useRaster) && rendererRef.current && !glLost) {
      glDrawsBorders = !(rendererRef.current instanceof Canvas2DImagery)
      rendererRef.current.render({
        projection: frameProjection,
        projectionKey: 'globe',
        isGlobe: true,
        rotation: rotationRef.current,
        transform: transformRef.current,
        layout: { scale, offsetX, offsetY, dpr },
        cssWidth: w,
        cssHeight: h,
        oceanFill: dragFills.current.ocean,
        raster: useRaster,
        grade: satellite ? IMAGERY_GRADES[paletteDirection] : undefined,
        glow: GLOBE_GLOW,
        borders: glDrawsBorders
          ? { color: dragFills.current.strokeRgba }
          : undefined,
      })
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, bufferW, bufferH)
    // Imagery views: outlines are in the WebGL scene above, painted from
    // the same rotation in the same frame -- nothing left to draw here.
    if (glDrawsBorders) return
    const view = dpr * scale
    ctx.setTransform(
      view * transformRef.current.k, 0, 0, view * transformRef.current.k,
      dpr * (offsetX + scale * transformRef.current.x),
      dpr * (offsetY + scale * transformRef.current.y),
    )
    const path = geoPath(frameProjection, ctx)
    {
      const t = frameProjection.translate()
      drawGlowRing(ctx, t[0], t[1], frameProjection.scale(), GLOBE_GLOW)
    }
    if (!satellite || glLost) {
      ctx.beginPath()
      path({ type: 'Sphere' } as GeoPermissibleObjects)
      ctx.fillStyle = dragFills.current.ocean
      ctx.fill()
    }
    ctx.lineJoin = 'round'
    ctx.lineWidth = (satellite ? 0.75 : 0.5) / transformRef.current.k
    ctx.strokeStyle = dragFills.current.stroke
    // Vector frames (deep zoom, or the no-WebGL2 fallback): only the
    // countries whose lon/lat bounds touch the visible window are
    // projected. `null` window = whole hemisphere in view = draw all.
    const culling = visibleLonLatWindow(frameProjection, transformRef.current, w, h, scale, offsetX, offsetY)
    collection.features.forEach((item, index) => {
      if (culling && !boundsTouch(staticGeometry[index]!.bounds, culling)) return
      ctx.beginPath()
      path(item as unknown as GeoPermissibleObjects)
      const fill = dragFills.current.fills[index]
      if (fill && fill !== 'transparent') {
        ctx.fillStyle = fill
        ctx.fill()
      }
      ctx.stroke()
    })
  }, [collection, staticGeometry, satellite, layoutFor, paletteDirection, viewW, viewH, renderSky])

  /** Round 13 watchdog: a drag session with no pointer down and no
      animation frame scheduled is a session nothing will ever end -- the
      frozen globe (section 42.1) by whatever new route a phone finds. It
      is checked a few times a second while a session is live. */
  const watchdog = useRef<number | null>(null)

  const beginDragRender = useCallback(() => {
    if (isDragRendering.current) return
    isDragRendering.current = true
    if (watchdog.current === null) {
      watchdog.current = window.setInterval(() => {
        if (!isDragRendering.current) {
          if (watchdog.current !== null) window.clearInterval(watchdog.current)
          watchdog.current = null
          return
        }
        if (dragPointers.current.size === 0 && inertiaFrame.current === null && dragFrame.current === null) {
          forceEndDragSessionRef.current()
        }
      }, 400)
    }
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
    setRotation([rotationRef.current[0], rotationRef.current[1], rotationRef.current[2]])
  }, [])

  const cancelInertia = useCallback(() => {
    if (inertiaFrame.current !== null) {
      cancelAnimationFrame(inertiaFrame.current)
      inertiaFrame.current = null
    }
  }, [])

  /** Round-2 fix: a drag session could survive a lost pointerup (release
      outside the svg after a leave event when capture did not hold),
      leaving the SVG hidden behind a stale canvas frame forever — the
      "frozen black globe". This ends the session unconditionally and
      restores visibility RIGHT NOW (the one-frame rotation flash is far
      better than a dead map), and is wired into every escape hatch:
      pointer leave/cancel/lost-capture, zoom events with no pointers
      down, and view/mode/projection switches. */
  const forceEndDragSession = useCallback(() => {
    cancelInertia()
    if (!isDragRendering.current) return
    isDragRendering.current = false
    if (svgRef.current) svgRef.current.style.visibility = ''
    if (dragCanvasRef.current) dragCanvasRef.current.style.display = 'none'
    if (!satellite && canvasRef.current) canvasRef.current.style.display = 'none'
    setRotation([rotationRef.current[0], rotationRef.current[1], rotationRef.current[2]])
  }, [cancelInertia, satellite])

  /** The zoom behaviour is bound once and closes over nothing reactive;
      it reaches the current force-end through this ref. */
  const forceEndDragSessionRef = useRef(forceEndDragSession)
  useEffect(() => {
    forceEndDragSessionRef.current = forceEndDragSession
  }, [forceEndDragSession])

  useEffect(() => {
    // Switching base view, fill mode or projection must never inherit a
    // live drag session.
    forceEndDragSession()
  }, [baseView, mode, projectionKey, forceEndDragSession])

  /** Write the orientation ref: lambda and gamma wrapped (section 54.2),
      phi as the Euler conversion gives it (already within +-90). */
  const writeRotation = useCallback((next: Rotation) => {
    rotationRef.current = [
      wrapLongitude(next[0]),
      Math.max(-90, Math.min(90, next[1])),
      wrapLongitude(next[2]),
    ]
  }, [])

  /** Momentum after release (round 12, section 62): the last drag frame's
      rotation, applied again every frame and shrunk by INERTIA_DECAY per
      60 Hz frame until it is too small to see. Time-based, so the coast
      covers the same ground at 120 Hz. Skipped under reduced motion, and
      after a hold (the finger stopped before it lifted). */
  const startInertia = useCallback(() => {
    // Round 8 (section 58.1): a release fires pointerup AND lostpointercapture
    // (and on touch, pointerleave too), and each reached here. Two or three
    // inertia loops then advanced the same rotation ref in parallel; the
    // first to settle committed the rotation to React and restored the SVG,
    // while the others kept painting GL frames that carried the imagery on
    // -- the labels and outlines "separating after the spin stops" on
    // Andy's phone, and the doubled work was the freezing. One loop only.
    if (inertiaFrame.current !== null) return
    const reduced = window.matchMedia(
      '(prefers-reduced-motion: reduce)',
    ).matches
    // Per 60 Hz frame, whatever the display's rate was.
    let v = versor.pow(frameVelocity.current, 16.7 / Math.max(4, frameVelocityMs.current))
    frameVelocity.current = [1, 0, 0, 0]
    const stale = performance.now() - lastMoveAt.current > INERTIA_STALE_MS
    const startAngle = versor.angle(v)
    if (reduced || stale || startAngle < 0.15) {
      endDragRender()
      return
    }
    // A north-held drag's per-frame rotation is not itself roll-free when
    // repeated (its axis need not lie in the lambda/phi subgroup), so the
    // coast pins gamma where the finger left it; a twist coasts as a roll.
    const holdGamma = lastFrameWasRoll.current ? null : rotationRef.current[2]
    if (startAngle > INERTIA_MAX_DEG_PER_FRAME) {
      v = versor.pow(v, INERTIA_MAX_DEG_PER_FRAME / startAngle)
    }
    let last = performance.now()
    const step = (now: number) => {
      const dt = Math.max(4, Math.min(50, now - last))
      last = now
      const frames = dt / 16.7
      v = versor.pow(v, Math.pow(INERTIA_DECAY, frames))
      const q = versor.multiply(
        versor.pow(v, frames),
        versor.fromEuler(rotationRef.current),
      )
      const e = versor.toEuler(versor.normalize(q))
      if (holdGamma !== null) e[2] = holdGamma
      writeRotation(e)
      drawDragFrame()
      if (versor.angle(v) < INERTIA_STOP_DEG) {
        inertiaFrame.current = null
        endDragRender()
        return
      }
      inertiaFrame.current = requestAnimationFrame(step)
    }
    inertiaFrame.current = requestAnimationFrame(step)
  }, [drawDragFrame, endDragRender, writeRotation])

  useEffect(() => () => cancelInertia(), [cancelInertia])
  useEffect(() => () => { if (watchdog.current !== null) window.clearInterval(watchdog.current) }, [])

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
  const pendingTransform = useRef<typeof zoomIdentity | null>(null)
  const zoomFrame = useRef<number | null>(null)
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const behaviour = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, MAX_ZOOM])
      .translateExtent([
        [0, 0],
        [viewW, viewH],
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
        if (isDragRendering.current && dragPointers.current.size === 0) {
          forceEndDragSessionRef.current()
        }
        // Section 51.3: a pinch delivers a zoom event per touchmove, up to
        // 120 Hz on a phone, and each used to be a full React commit.
        // Coalesce to one commit per animation frame with the latest
        // transform; nothing is lost, only the renders nobody could see.
        pendingTransform.current = event.transform
        if (zoomFrame.current !== null) return
        zoomFrame.current = requestAnimationFrame(() => {
          zoomFrame.current = null
          if (pendingTransform.current) setTransform(pendingTransform.current)
        })
      })
    behaviourRef.current = behaviour
    const selection = select(svg)
    selection.call(behaviour)
    selection.on('dblclick.zoom', null)
    return () => {
      selection.on('.zoom', null)
      behaviourRef.current = null
      if (zoomFrame.current !== null) {
        cancelAnimationFrame(zoomFrame.current)
        zoomFrame.current = null
      }
    }
  }, [isGlobe, viewW, viewH])

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
      setNativeFullscreen(document.fullscreenElement === frameRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  /** Pseudo full screen (§53.3): the frame is pinned over the page and
      the page behind it stops scrolling; Escape leaves, like the real
      thing. */
  useEffect(() => {
    if (!pseudoFullscreen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPseudoFullscreen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKey)
    }
  }, [pseudoFullscreen])

  const toggleFullscreen = useCallback(() => {
    const frame = frameRef.current
    if (!frame) return
    if (pseudoFullscreen) {
      setPseudoFullscreen(false)
      return
    }
    if (document.fullscreenElement === frame) {
      void document.exitFullscreen()
      return
    }
    // iOS Safari (every iPhone) has no element fullscreen; the CSS pin is
    // the same experience from the reader's side.
    if (typeof frame.requestFullscreen === 'function' && document.fullscreenEnabled) {
      frame.requestFullscreen().catch(() => setPseudoFullscreen(true))
    } else {
      setPseudoFullscreen(true)
    }
  }, [pseudoFullscreen])

  /**
   * Globe rotation by dragging (round 12, section 62): versor dragging.
   *
   * ONE finger: the place first touched is the anchor; every frame the
   * globe is rotated so that place sits under the finger now -- exactly
   * Google Earth's rule, so the pace is right at every zoom and at every
   * point of the disc by construction, and the motion is 1:1 with the
   * hand. TWO fingers: the pinch is d3-zoom's (scale, and pan when zoomed
   * in); the TWIST between them rolls the globe about the line of sight
   * (gamma), which is how north is turned away from the top of the screen
   * and back. Every change in the number of fingers re-anchors, so lifting
   * one finger of a pinch never makes the globe jump to a stale anchor
   * (one of the "glitches" reported on the phone).
   *
   * Mouse and touch share the code path (pointer events). A drag that
   * actually moved suppresses the click it releases into, or letting go of
   * the sphere would open whichever country the pointer stopped on.
   */
  const dragAnchor = useRef<{
    /** Orientation when the anchor was taken. */
    q0: versor.Quaternion
    r0: Rotation
    /** One finger: the place under it, [lon, lat] in degrees. */
    g0: [number, number] | null
    /** Two fingers: the angle between them (radians); Shift+mouse: the
        angle of the pointer about the disc centre. */
    a0: number
    /** True when a single pointer is rolling (Shift held on a mouse/pen). */
    roll: boolean
    /** One finger: where it went down (client px), for the drag threshold. */
    start: [number, number]
    count: number
  } | null>(null)
  const dragFrame = useRef<number | null>(null)
  const prevFrameAt = useRef(0)
  /** When each tracked pointer last spoke (down or move), for the
      lost-capture hatch below. */
  const lastPointerEventAt = useRef(new Map<number, number>())

  useEffect(
    () => () => {
      if (dragFrame.current !== null) cancelAnimationFrame(dragFrame.current)
    },
    [],
  )

  /** Unzoomed view coordinates of a client point (what the fitted
      projection inverts), through the zoom transform the frames read. */
  const viewPointOf = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const container = containerRef.current
      const rect = container?.getBoundingClientRect()
      if (!container || !rect) return [viewW / 2, viewH / 2]
      const { scale, offsetX, offsetY } = layoutFor(container.clientWidth, container.clientHeight)
      const t = transformRef.current
      return [
        ((clientX - rect.left - offsetX) / scale - t.x) / t.k,
        ((clientY - rect.top - offsetY) / scale - t.y) / t.k,
      ]
    },
    [layoutFor, viewW, viewH],
  )

  /** A view point clamped to just inside the limb, so a finger past the
      edge still holds a stable place. */
  const clampToDisc = useCallback(
    (view: [number, number]): [number, number] => {
      const limit = disc.r * DISC_CLAMP
      const d = Math.hypot(view[0] - disc.cx, view[1] - disc.cy)
      if (d <= limit) return view
      return [disc.cx + ((view[0] - disc.cx) * limit) / d, disc.cy + ((view[1] - disc.cy) * limit) / d]
    },
    [disc],
  )

  /** The place [lon, lat] under a view point at a given orientation. */
  const placeAt = useCallback(
    (orientation: Rotation, view: [number, number]): [number, number] => {
      const base = createProjection('globe')
      base.rotate(orientation)
      const proj = fitProjection(base, viewW, viewH)
      const geo = proj.invert?.(clampToDisc(view))
      if (!geo || !Number.isFinite(geo[0]) || !Number.isFinite(geo[1])) {
        return [-orientation[0], -orientation[1]]
      }
      return [geo[0], geo[1]]
    },
    [viewW, viewH, clampToDisc],
  )

  /** A view point as a unit vector in the view frame (depth toward the
      viewer, right, up) -- the same frame the imagery shader inverts. */
  const viewVectorOf = useCallback(
    (view: [number, number]): versor.Vec3 => {
      const [x, y] = clampToDisc(view)
      const px = (x - disc.cx) / disc.r
      const py = (disc.cy - y) / disc.r
      return [Math.sqrt(Math.max(0, 1 - px * px - py * py)), px, py]
    },
    [disc, clampToDisc],
  )

  /** Shift held during a mouse/pen drag: roll instead of spin (a mouse
      has no second finger to twist with). Read at pointerdown. */
  const shiftRoll = useRef(false)

  /** Angle of a client point about the disc centre (radians, screen). */
  const angleAboutCentre = useCallback(
    (clientX: number, clientY: number) => {
      const [vx, vy] = viewPointOf(clientX, clientY)
      return Math.atan2(vy - disc.cy, vx - disc.cx)
    },
    [viewPointOf, disc],
  )

  /** (Re)take the anchor from the pointers down right now. */
  const anchorDrag = useCallback(() => {
    const pts = [...dragPointers.current.values()]
    if (pts.length === 0) {
      dragAnchor.current = null
      return
    }
    const r0: Rotation = [rotationRef.current[0], rotationRef.current[1], rotationRef.current[2]]
    const q0 = versor.fromEuler(r0)
    if (pts.length === 1) {
      const p = pts[0]!
      if (shiftRoll.current) {
        dragAnchor.current = {
          q0, r0, g0: null, a0: angleAboutCentre(p.x, p.y), roll: true, start: [p.x, p.y], count: 1,
        }
        return
      }
      dragAnchor.current = {
        q0, r0, g0: placeAt(r0, viewPointOf(p.x, p.y)), a0: 0, roll: false, start: [p.x, p.y], count: 1,
      }
      return
    }
    const a = pts[0]!
    const b = pts[1]!
    dragAnchor.current = {
      q0, r0, g0: null, a0: Math.atan2(b.y - a.y, b.x - a.x), roll: true, start: [a.x, a.y], count: pts.length,
    }
  }, [placeAt, viewPointOf, angleAboutCentre])

  /** One drag frame: orientation from the anchor and the pointers now. */
  const applyDragFrame = useCallback(() => {
    const anchor = dragAnchor.current
    if (!anchor) return
    const pts = [...dragPointers.current.values()]
    if (pts.length !== anchor.count) return
    let q1: versor.Quaternion
    let reanchor = false
    if (anchor.count === 1 && anchor.g0 && !anchor.roll) {
      // North held: the anchor goes under the finger without any roll.
      const p = pts[0]!
      const next = versor.withFixedRoll(
        anchor.g0,
        viewVectorOf(viewPointOf(p.x, p.y)),
        anchor.r0[2],
        [rotationRef.current[0], rotationRef.current[1]],
      )
      q1 = versor.fromEuler(next)
      // Past the pole the solver clamps; re-anchoring there keeps the
      // finger and the map from disagreeing for the rest of the gesture.
      reanchor = Math.abs(next[1]) > 89.5
    } else {
      const a = pts[0]!
      const b = pts[1] ?? null
      const now = b ? Math.atan2(b.y - a.y, b.x - a.x) : angleAboutCentre(a.x, a.y)
      let da = now - anchor.a0
      if (da > Math.PI) da -= 2 * Math.PI
      else if (da < -Math.PI) da += 2 * Math.PI
      // Screen y points down: a clockwise twist of the fingers is a
      // positive da, and the globe must turn clockwise with them.
      q1 = versor.multiply(versor.roll((-da * 180) / Math.PI), anchor.q0)
    }
    q1 = versor.normalize(q1)
    lastFrameWasRoll.current = !(anchor.count === 1 && anchor.g0 && !anchor.roll)
    const prev = versor.fromEuler(rotationRef.current)
    let step = versor.multiply(q1, versor.conjugate(prev))
    const stepAngle = versor.angle(step)
    if (stepAngle > DRAG_MAX_DEG_PER_FRAME) {
      // Bounded pace: take the same rotation, shortened, and let the next
      // frame anchor afresh under the finger.
      step = versor.pow(step, DRAG_MAX_DEG_PER_FRAME / stepAngle)
      q1 = versor.normalize(versor.multiply(step, prev))
      if (!lastFrameWasRoll.current) {
        // The shortened step is not exactly roll-free; north stays held.
        const e = versor.toEuler(q1)
        e[2] = anchor.r0[2]
        q1 = versor.fromEuler(e)
        step = versor.multiply(q1, versor.conjugate(prev))
      }
      reanchor = true
    }
    frameVelocity.current = step
    const now = performance.now()
    frameVelocityMs.current = prevFrameAt.current ? Math.min(50, now - prevFrameAt.current) : 16.7
    prevFrameAt.current = now
    writeRotation(versor.toEuler(q1))
    drawDragFrame()
    if (reanchor) anchorDrag()
  }, [viewVectorOf, viewPointOf, angleAboutCentre, writeRotation, drawDragFrame, anchorDrag])

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
      frameVelocity.current = [1, 0, 0, 0]
      prevFrameAt.current = 0
      shiftRoll.current = event.pointerType !== 'touch' && event.shiftKey
      dragPointers.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      })
      lastPointerEventAt.current.set(event.pointerId, performance.now())
      anchorDrag()
    },
    [isGlobe, cancelInertia, anchorDrag],
  )

  /**
   * Pointer positions are recorded as they arrive (up to 120-240 Hz on a
   * touch screen) and ONE frame is computed per animation frame from the
   * anchor and the latest positions -- the sphere tracks the finger at the
   * display's own rate and nothing is thrown away, because the frame is a
   * function of where the finger IS, not of how it got there.
   */
  const handleGlobePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!isGlobe) return
      const tracked = dragPointers.current.get(event.pointerId)
      if (!tracked) return
      dragPointers.current.set(event.pointerId, {
        x: event.clientX,
        y: event.clientY,
      })
      lastPointerEventAt.current.set(event.pointerId, performance.now())
      const anchor = dragAnchor.current
      if (!anchor) return
      if (!dragSuppressesClick.current) {
        const moved =
          anchor.count > 1 ||
          Math.hypot(event.clientX - anchor.start[0], event.clientY - anchor.start[1]) >= DRAG_START_PX
        if (!moved) return
        dragSuppressesClick.current = true
      }
      // From here the gesture is a drag, never a click, so capturing the
      // pointer costs nothing and keeps the spin alive when the pointer
      // wanders off the svg mid-gesture. MOUSE AND PEN ONLY: a touch
      // pointer is implicitly captured by the element it went down on,
      // and taking it over fires lostpointercapture on that element in
      // the middle of the gesture -- which bubbled into the end handler
      // below and dropped the finger (round 12: the two-finger twist
      // died after one frame). Guarded: a pointer can be gone by the time
      // the frame runs (and synthetic events have no id).
      if (event.pointerType !== 'touch') {
        try {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.setPointerCapture(event.pointerId)
          }
        } catch {
          /* capture is an optimisation, never a requirement */
        }
      }
      lastMoveAt.current = performance.now()
      if (dragFrame.current !== null) return
      dragFrame.current = requestAnimationFrame(() => {
        dragFrame.current = null
        // Round-2 section 35: rotation stays in a ref and the frame goes
        // straight to canvas -- React sees nothing until the gesture ends.
        beginDragRender()
        applyDragFrame()
      })
    },
    [isGlobe, beginDragRender, applyDragFrame],
  )

  const handleGlobePointerEnd = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (event.type === 'lostpointercapture' && dragPointers.current.has(event.pointerId)) {
        // Capture moved between elements while the pointer is still down
        // (a touch's implicit capture handing over, a re-render swapping
        // the target): not a release. It stays the section 42.1 escape
        // hatch for a pointer whose release never arrives: if nothing
        // more is heard from this pointer shortly, it is treated as gone.
        const id = event.pointerId
        const seen = lastPointerEventAt.current.get(id) ?? 0
        window.setTimeout(() => {
          if (!dragPointers.current.has(id)) return
          if ((lastPointerEventAt.current.get(id) ?? 0) > seen) return
          dragPointers.current.delete(id)
          lastPointerEventAt.current.delete(id)
          if (dragPointers.current.size > 0) anchorDrag()
          else {
            dragAnchor.current = null
            if (isDragRendering.current) forceEndDragSessionRef.current()
          }
        }, 120)
        return
      }
      dragPointers.current.delete(event.pointerId)
      lastPointerEventAt.current.delete(event.pointerId)
      if (dragPointers.current.size > 0) {
        // A finger of a pinch lifted: the survivor anchors afresh.
        anchorDrag()
        return
      }
      dragAnchor.current = null
      // Last finger up while a drag-render session is live: hand off to
      // inertia (which commits the final rotation when it stops).
      if (isDragRendering.current) startInertia()
    },
    [startInertia, anchorDrag],
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

  // ---- Round 5 (§53.2): the bottom sheet ----------------------------------
  const [picked, setPicked] = useState<HoverTarget | null>(null)
  const [sheetExpanded, setSheetExpanded] = useState(false)
  /** Other entities under a fat finger (§53.6): offered as a short list. */
  const [nearby, setNearby] = useState<HoverTarget[]>([])
  const sheetActive = renderSheet !== undefined && mode === 'country'

  const closeSheet = useCallback(() => {
    setPicked(null)
    setNearby([])
    setSheetExpanded(false)
    onHover(null)
    onPick?.(null)
  }, [onHover, onPick])

  const pick = useCallback(
    (target: HoverTarget, alternatives: HoverTarget[] = []) => {
      setPicked(target)
      setNearby(alternatives.filter((t) => t.iso3 !== target.iso3))
      setPopover(null)
      onHover(target)
      onPick?.(target)
    },
    [onHover, onPick],
  )

  /** Every entity keyed by iso3, for turning a hit-tested node back into a
      target. */
  const targetByIso3 = useMemo(() => {
    const map = new Map<string, HoverTarget>()
    for (const shape of shapes) {
      if (!map.has(shape.iso3)) {
        map.set(shape.iso3, {
          iso3: shape.iso3,
          name: shape.name,
          continent: shape.continent,
          contested: shape.contested,
          isMarker: false,
        })
      }
    }
    for (const { marker } of markerPoints) {
      if (!map.has(marker.iso3)) {
        map.set(marker.iso3, {
          iso3: marker.iso3,
          name: marker.name,
          continent: marker.continent,
          contested: marker.contested,
          isMarker: true,
        })
      }
    }
    return map
  }, [shapes, markerPoints])

  /**
   * Entities within a fingertip of a tap (§53.6): the map nodes under nine
   * probe points on a 14 px ring around the tap. Crowded islands and
   * tight borders then offer a list instead of demanding a precise tap.
   */
  const entitiesNear = useCallback(
    (clientX: number, clientY: number): HoverTarget[] => {
      const found = new Map<string, HoverTarget>()
      const radius = 14
      const probes: [number, number][] = [[0, 0]]
      for (let i = 0; i < 8; i += 1) {
        const a = (i / 8) * Math.PI * 2
        probes.push([Math.cos(a) * radius, Math.sin(a) * radius])
      }
      for (const [dx, dy] of probes) {
        const node = document.elementFromPoint(clientX + dx, clientY + dy)
        const hit = node?.closest?.('[data-iso3]') as HTMLElement | null
        const iso3 = hit?.dataset.iso3
        if (!iso3 || found.has(iso3)) continue
        const target = targetByIso3.get(iso3)
        if (target) found.set(iso3, target)
      }
      return [...found.values()]
    },
    [targetByIso3],
  )

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

  /** Select, unless the pointer was busy spinning the globe. On touch, and
      on compact widths, the tap opens the bottom sheet (§53.2) — navigation
      is its "More info" link; without a sheet a touch tap pins the popover
      as before. */
  const selectUnlessDragging = useCallback(
    (target: HoverTarget, event?: React.MouseEvent) => {
      if (dragSuppressesClick.current) return
      const touch = lastPointerType.current === 'touch'
      if (sheetActive && event !== undefined && (touch || compact)) {
        pick(target, touch ? entitiesNear(event.clientX, event.clientY) : [])
        return
      }
      if (popoverActive && touch && event !== undefined) {
        const [x, y] = containerPoint(event)
        setPopover({ target, x, y, pinned: true })
        return
      }
      onSelect(target)
    },
    [onSelect, popoverActive, sheetActive, compact, pick, entitiesNear, containerPoint],
  )

  // ---- Round 5 (§53.4): fly-to and reset ----------------------------------
  const flyTo = useCallback(
    (iso3: string) => {
      const svg = svgRef.current
      const behaviour = behaviourRef.current
      const target = targetByIso3.get(iso3)
      if (!svg || !behaviour || !target) return
      const index = collection.features.findIndex((f) => f.properties.iso3 === iso3)
      const marker = markers.find((m) => m.iso3 === iso3)
      const centre: [number, number] | null =
        index >= 0
          ? staticGeometry[index]!.centroid
          : marker
            ? marker.coordinates
            : null
      if (!centre) return
      forceEndDragSession()
      setPopover(null)
      const nextRotation: Rotation = isGlobe
        ? [wrapLongitude(-centre[0]), -centre[1], 0]
        : rotation
      if (isGlobe) {
        rotationRef.current = nextRotation
        setRotation(nextRotation)
      }
      // Fit: project the entity under its new orientation and zoom so it
      // fills about a third of the frame — enough to read its neighbours.
      const base = createProjection(projectionKey)
      if (isGlobe) base.rotate(nextRotation)
      const projection = fitProjection(base, viewW, viewH)
      let box: [[number, number], [number, number]]
      if (index >= 0) {
        box = geoPath(projection).bounds(
          collection.features[index] as unknown as GeoPermissibleObjects,
        )
      } else {
        const p = projection(centre) ?? [viewW / 2, viewH / 2]
        box = [[p[0] - 12, p[1] - 12], [p[0] + 12, p[1] + 12]]
      }
      const bw = Math.max(1, box[1][0] - box[0][0])
      const bh = Math.max(1, box[1][1] - box[0][1])
      const cx = (box[0][0] + box[1][0]) / 2
      const cy = (box[0][1] + box[1][1]) / 2
      const k = Math.max(1, Math.min(MAX_ZOOM, Math.min(viewW / bw, viewH / bh) * 0.35))
      const next = zoomIdentity.translate(viewW / 2 - cx * k, viewH / 2 - cy * k).scale(k)
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      if (reduced) behaviour.transform(select(svg), next)
      else select(svg).transition().duration(650).call(behaviour.transform, next)
      // The sheet is the phone/touch surface; with a pointer the readout
      // beside the map shows the flown-to country.
      if (sheetActive && (compact || lastPointerType.current === 'touch')) pick(target)
      else onHover(target)
    },
    [
      targetByIso3, collection, markers, staticGeometry, isGlobe, rotation,
      projectionKey, viewW, viewH, forceEndDragSession, sheetActive, compact, pick, onHover,
    ],
  )

  /**
   * The compass (round 9, section 59.3). This globe has no heading axis --
   * at the DISC centre the meridian is always vertical -- but once the
   * reader has zoomed and panned, the screen centre sits off the disc
   * centre and the meridians there lean toward the pole: the moment a
   * Google Earth user reaches for the compass. North-up here therefore
   * means: rotate the globe so the place under the screen centre becomes
   * the disc centre (its meridian now straight up), and bring the pan back
   * to centre, keeping the zoom. The place stays where it is; the globe
   * reorients around it. Round 5's Reset view, which jumped back to the
   * default Africa view, is what Andy did not want. Animated through the
   * drag-frame path (imagery and outlines move together), committed once;
   * instant under reduced motion.
   */
  const northUp = useCallback(() => {
    if (!isGlobe) return
    const svg = svgRef.current
    const behaviour = behaviourRef.current
    if (!svg || !behaviour) return
    cancelInertia()
    const t0 = transformRef.current
    const from: Rotation = isDragRendering.current ? rotationRef.current : rotation
    // The geographic point under the screen centre (falls back to the
    // disc centre when the screen centre is off the sphere).
    const base = createProjection('globe')
    base.rotate(from)
    const proj = fitProjection(base, viewW, viewH)
    const centreView: [number, number] = [
      (viewW / 2 - t0.x) / t0.k,
      (viewH / 2 - t0.y) / t0.k,
    ]
    const under = proj.invert?.(centreView)
    const place: [number, number] =
      under && Number.isFinite(under[0]) && Number.isFinite(under[1])
        ? under
        : [-from[0], -from[1]]
    // Round 12: north up now also means gamma back to 0 -- a two-finger
    // twist can leave north pointing anywhere, and this is the way back.
    const to: Rotation = [wrapLongitude(-place[0]), Math.max(-90, Math.min(90, -place[1])), 0]
    // Pan that puts the disc centre at the screen centre at this zoom.
    const t1 = zoomIdentity.translate((viewW / 2) * (1 - t0.k), (viewH / 2) * (1 - t0.k)).scale(t0.k)
    const qFrom = versor.fromEuler(from)
    const qTo = versor.fromEuler(to)
    // The one rotation that carries `from` to `to`; eased along it (a
    // geodesic on the rotation group, no Euler-angle detours).
    const qPath = versor.multiply(qTo, versor.conjugate(qFrom))
    if (versor.angle(qPath) < 0.01 &&
        Math.abs(t1.x - t0.x) < 0.5 && Math.abs(t1.y - t0.y) < 0.5) return
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      forceEndDragSession()
      rotationRef.current = to
      setRotation(to)
      behaviour.transform(select(svg), t1)
      return
    }
    beginDragRender()
    const duration = 500
    const started = performance.now()
    const step = (now: number) => {
      const t = Math.min(1, (now - started) / duration)
      const eased = 1 - (1 - t) * (1 - t) * (1 - t)
      writeRotation(versor.toEuler(versor.multiply(versor.pow(qPath, eased), qFrom)))
      const tx = t0.x + (t1.x - t0.x) * eased
      const ty = t0.y + (t1.y - t0.y) * eased
      transformRef.current = zoomIdentity.translate(tx, ty).scale(t0.k)
      drawDragFrame()
      if (t < 1) {
        inertiaFrame.current = requestAnimationFrame(step)
        return
      }
      inertiaFrame.current = null
      rotationRef.current = to
      // Commit the pan through d3-zoom (one event, one React commit) and
      // the rotation through the usual end-of-session path.
      behaviour.transform(select(svg), t1)
      endDragRender()
    }
    inertiaFrame.current = requestAnimationFrame(step)
  }, [
    isGlobe, rotation, viewW, viewH, cancelInertia, forceEndDragSession,
    beginDragRender, drawDragFrame, endDragRender, writeRotation,
  ])

  useImperativeHandle(handleRef, () => ({ flyTo, northUp }), [flyTo, northUp])

  // A sheet cannot outlive its mode: continent view, or the sheet prop
  // going away, closes it.
  useEffect(() => {
    if (!sheetActive && picked) closeSheet()
  }, [sheetActive, picked, closeSheet])

  // Section 51.3: strokes carry vector-effect="non-scaling-stroke", so
  // NO path attribute changes on a wheel tick or pinch -- the
  // 250-attribute rewrite per zoom event is gone. A non-scaling width is
  // in CSS pixels (measured: it ignores the viewBox scale too), so the
  // old viewBox-unit widths (0.5 / k inside the k-scaled group) are
  // converted through the viewBox-to-element scale, which only moves on
  // resize. Same hairlines as before, at every zoom, for free.
  const viewScale =
    containerSize.w > 1 && containerSize.h > 1
      ? Math.min(containerSize.w / viewW, containerSize.h / viewH)
      : 1
  const px = (viewUnits: number) => viewUnits * viewScale
  const strokeWidth = px(0.5)
  /**
   * Label size inside the k-scaled group. Names grow with the square root
   * of the zoom (twice as big at 4x) up to LABEL_GROWTH_CAP times, then
   * hold: past 9x the old unbounded growth made "Cuneo" a billboard at
   * 48x (round 5, section 53.6).
   */
  const labelScale = Math.min(Math.sqrt(transform.k), LABEL_GROWTH_CAP) / transform.k
  const isDimmed = (continent: ContinentKey) =>
    mode === 'continent' && activeContinent !== null && continent !== activeContinent

  // One colour system for EVERY projection (2026-08-16): dark blue ocean
  // with sunlit light land fills in both themes -- land sits tiers of
  // lightness above the ocean (min contrast 4.36, gated in
  // build-map-palette.mjs), so a blue country can never be mistaken for
  // water. Since 2026-08-24 the area OUTSIDE the projected sphere is black
  // space on the flat views too (maintainer request) -- the ocean stops at
  // the planet's edge on every projection, not just the globe.
  /** Antique renders as an engraved sheet (section 48). Since round 4
      (section 51.1) the direction reaches every base view in country
      mode: the political map gets its parchment sea, umber lines and
      coast band; the imagery views get the sheet's tone (graded in the
      shader), lettering, grain and vignette over their own relief. The
      surround is black space in every direction (section 51.4). */
  const antique = paletteDirection === 'antique' && mode === 'country'
  const antiquePolitical = antique && !satellite
  const waterFill = antiquePolitical ? ANTIQUE.sea : 'var(--map-ocean)'
  const backgroundFill = 'var(--map-space)'
  const landStroke = antiquePolitical ? ANTIQUE.line : 'var(--map-ocean)'
  const landNeutral = GLOBE_LAND_NEUTRAL
  const noDataFill = antiquePolitical ? ANTIQUE.noData : 'var(--map-no-data)'

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
  // Imagery views: the GL pass draws the outlines (section 57.2); the SVG
  // strokes only on the 2-D fallback, which has no GL pass at rest.
  const glOutlines = satellite && !(rendererRef.current instanceof Canvas2DImagery)
  const countryStroke = glOutlines
    ? 'none'
    : imagery === 'satellite'
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
    // Phones get labels a little sooner (§53.6): the square frame already
    // doubles the globe, and a name is the cheapest hit target there is.
    const labelMinArea = compact ? LABEL_MIN_AREA_PX2 * 0.6 : LABEL_MIN_AREA_PX2
    // The key must be STABLE and UNIQUE per drawn shape, not per iso3: two
    // polygons share iso3 SOM (Somalia + Somaliland) and CYP. Keying labels
    // by iso3 alone gave React duplicate keys, and panning while zoomed left
    // stale label nodes behind -- the "Somalia multiplies" bug.
    const labels: { key: string; iso3: string; name: string; x: number; y: number; emphasized: boolean }[] = []
    shapes.forEach((shape, index) => {
      const isHovered = hovered?.iso3 === shape.iso3
      if (!isHovered && shape.areaPx * k2 < labelMinArea) return
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
        y: y - 6 * labelScale,
        emphasized: isHovered,
      })
    }
    return labels
  }, [shapes, markerPoints, hovered, transform.k, mode, compact])
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
  // The control itself (buttons, tooltips, Show/Hide-slider link, the
  // sessionStorage 'map-zoom-slider' preference) is the shared
  // ZoomControls component since round 3 (§45); the map only supplies
  // what its 0–100 slider position means: log-scaled d3-zoom k.

  /** Continuous zoom for the slider — absolute, no easing (the handle IS
      the easing). */
  const zoomTo = useCallback((k: number) => {
    const svg = svgRef.current
    const behaviour = behaviourRef.current
    if (!svg || !behaviour) return
    behaviour.scaleTo(select(svg), Math.max(1, Math.min(MAX_ZOOM, k)))
  }, [])

  // ---- Round 5 (§53.2): sheet swipe ------------------------------------
  // Native touch listeners, registered non-passive: React's own touch
  // handlers are passive, so preventDefault() there cannot stop the page
  // from scrolling under the swipe, and a swipe that scrolls the page is
  // not a swipe. Mouse users get the same thresholds through pointer
  // events, and a plain tap on the handle toggles.
  const sheetHandleRef = useRef<HTMLDivElement | null>(null)
  const sheetDrag = useRef<{ y: number; id: number } | null>(null)
  const settleSheetSwipe = useCallback(
    (dy: number) => {
      if (dy < -30) setSheetExpanded(true)
      else if (dy > 30) {
        if (sheetExpanded) setSheetExpanded(false)
        else closeSheet()
      }
    },
    [sheetExpanded, closeSheet],
  )
  useEffect(() => {
    const handle = sheetHandleRef.current
    if (!handle) return
    let startY: number | null = null
    let lastY = 0
    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (!touch) return
      startY = touch.clientY
      lastY = startY
    }
    const onMove = (event: TouchEvent) => {
      const touch = event.touches[0]
      if (startY === null || !touch) return
      lastY = touch.clientY
      event.preventDefault()
    }
    const onEnd = () => {
      if (startY === null) return
      const dy = lastY - startY
      startY = null
      if (Math.abs(dy) > 30) settleSheetSwipe(dy)
    }
    handle.addEventListener('touchstart', onStart, { passive: true })
    handle.addEventListener('touchmove', onMove, { passive: false })
    handle.addEventListener('touchend', onEnd)
    handle.addEventListener('touchcancel', onEnd)
    return () => {
      handle.removeEventListener('touchstart', onStart)
      handle.removeEventListener('touchmove', onMove)
      handle.removeEventListener('touchend', onEnd)
      handle.removeEventListener('touchcancel', onEnd)
    }
  }, [settleSheetSwipe, picked])
  const onSheetPointerDown = (event: React.PointerEvent) => {
    if (event.pointerType === 'touch') return
    sheetDrag.current = { y: event.clientY, id: event.pointerId }
  }
  const onSheetPointerUp = (event: React.PointerEvent) => {
    const start = sheetDrag.current
    sheetDrag.current = null
    if (!start || start.id !== event.pointerId) return
    settleSheetSwipe(event.clientY - start.y)
  }

  const frameClass = pseudoFullscreen
    ? 'fixed inset-0 z-50 flex flex-col'
    : nativeFullscreen
      ? 'flex h-full flex-col'
      : 'relative flex flex-col'

  return (
    <div ref={frameRef} className={frameClass} style={{ background: backgroundFill }}>
    <div
      ref={containerRef}
      className={isFullscreen ? 'relative min-h-0 flex-1' : 'relative'}
      style={{ background: backgroundFill }}
    >
      {/* Map controls: zoom without a wheel or pinch, and fullscreen. They
          live OUTSIDE the svg so they are ordinary buttons for keyboard and
          screen reader users. Compact (§53.5): thumb-sized, with Reset. */}
      <ZoomControls
        onZoomIn={() => zoomBy(1.5)}
        onZoomOut={() => zoomBy(1 / 1.5)}
        sliderValue={(Math.log(transform.k) / Math.log(MAX_ZOOM)) * 100}
        onSliderChange={(value) =>
          zoomTo(Math.exp((Math.log(MAX_ZOOM) * value) / 100))
        }
        isFullscreen={isFullscreen}
        onToggleFullscreen={toggleFullscreen}
        onNorthUp={isGlobe ? northUp : undefined}
        large={compact && (isGlobe || isFullscreen)}
        horizontal={compact && !isGlobe && !isFullscreen}
        buttonStyle={controlButtonStyle}
      />

      {/* Round 5 (§53.3): the fullscreen control as a labelled button on
          phones — "Explore globe" is the mode where one finger spins and two
          zoom; the embedded map lets the page scroll over it. */}
      {compact && !isFullscreen && (
        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute left-3 top-3 z-10 rounded-full border px-4 py-2.5 text-sm font-medium shadow"
          style={controlButtonStyle}
        >
          {isGlobe ? 'Explore globe' : 'Explore map'}
        </button>
      )}
      {isFullscreen && (
        <button
          type="button"
          onClick={toggleFullscreen}
          className="absolute left-3 top-3 z-10 rounded-full border px-4 py-2 text-sm font-medium shadow"
          style={controlButtonStyle}
        >
          Done
        </button>
      )}

      {/* Attribution (Phase 4): required for the NASA imagery, honest for
          Natural Earth. Rendered as chrome, not data, and kept out of the
          pointer path. */}
      <div
        className="pointer-events-none absolute bottom-1.5 right-1.5 z-10 max-w-[calc(100%-1rem)] rounded px-1.5 py-0.5 text-[10px] leading-tight"
        style={{
          background: 'rgba(10, 14, 20, 0.55)',
          color: 'rgba(255, 255, 255, 0.85)',
        }}
      >
        {attribution}
      </div>

      {/* Sky canvas (round 13, section 67): the bottom of the stack, under
          the imagery and the SVG; transparent, the black surround shows
          through. Inert. */}
      <canvas
        ref={skyCanvasRef}
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{ display: showSky ? 'block' : 'none' }}
        aria-hidden="true"
      />
      {/* Terrain canvas: BELOW the svg in paint order, so every interactive
          surface stays untouched SVG. Mounted only in satellite view. */}
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full"
        style={{ display: satellite ? 'block' : 'none' }}
        aria-hidden="true"
      />
      {satellite && !imageryReady && (
        <div
          className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 rounded-full px-3 py-1 text-[11px] leading-tight"
          role="status"
          style={{
            background: 'rgba(10, 14, 20, 0.7)',
            color: 'rgba(255, 255, 255, 0.9)',
          }}
        >
          Loading {imagery === 'terrain' ? 'terrain' : 'satellite'} imagery…
        </div>
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
      viewBox={`0 0 ${viewW} ${viewH}`}
      className={
        // `relative` matters: the terrain canvas is absolutely positioned,
        // and only a positioned svg is guaranteed to paint above it.
        // touch-action (§53.3): full screen owns every gesture; embedded,
        // vertical swipes scroll the PAGE (pan-y) — a horizontal drag still
        // spins the globe and a pinch still zooms, but a reader flicking
        // down the page is no longer trapped on the map.
        // Round 9 (section 59.2): once ZOOMED IN the embedded map owns
        // every gesture too -- with pan-y a vertical drag over a zoomed
        // globe scrolled the page instead of panning, which read as "the
        // map froze". Round 11 (section 61): the GLOBE owns every gesture
        // at every zoom. Under pan-y iOS waits to classify each touch and
        // hands over only the strictly horizontal ones, coalesced -- a
        // finger spin moved the globe "ever so slightly", rigidly. Only
        // the flat maps at world zoom (no pan there anyway) keep pan-y.
        `relative ${isFullscreen ? 'h-full' : 'h-auto'} w-full ${
          isFullscreen || isGlobe || transform.k > 1.05 ? 'touch-none' : 'touch-pan-y'
        }`
      }
      role="group"
      // The committed orientation, for the gesture test scripts (round 12).
      data-rotation={isGlobe ? rotation.map((v) => v.toFixed(2)).join(',') : undefined}
      aria-label={
        `World map, ${isGlobe ? 'globe view' : 'equal-area projection'}, ` +
        `${imagery ? `${imagery} base, ` : ''}` +
        `${focusTargets.length} entities. ` +
        `Use the arrow keys to move between countries and Enter to open one. ` +
        `Home and End jump to the westernmost and easternmost.`
      }
      style={{
        background: satellite || showSky ? 'transparent' : backgroundFill,
        cursor: isGlobe ? 'grab' : undefined,
      }}
      onPointerLeave={(event) => {
        dragPointers.current.delete(event.pointerId)
        if (dragPointers.current.size === 0) {
          dragAnchor.current = null
          if (isDragRendering.current) startInertia()
        }
        onHover(null)
        // Keep the popover if the pointer is moving INTO it (to reach its
        // "More info" link); clear otherwise, unless a tap pinned it.
        // relatedTarget can be the window (leaving the document) — only a
        // real Node may be passed to contains(), or it throws (§42).
        const related = event.relatedTarget
        const into =
          related instanceof Node && popoverRef.current?.contains(related)
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
      onLostPointerCapture={handleGlobePointerEnd}
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
        {/* Round 13: the atmosphere ring (the GL pass paints the same halo
            in the imagery views and during drags). */}
        <radialGradient id="globe-glow">
          {GLOW_STOPS.map(([d, a]) => (
            <stop key={d} offset={(1 + d) / GLOW_REACH} stopColor={GLOW_CSS} stopOpacity={GLOBE_GLOW * a} />
          ))}
        </radialGradient>
      </defs>

      <g transform={`translate(${transform.x},${transform.y}) scale(${transform.k})`}>
        {isGlobe && !satellite && (
          <circle
            cx={disc.cx}
            cy={disc.cy}
            r={disc.r * GLOW_REACH}
            fill="url(#globe-glow)"
            pointerEvents="none"
            aria-hidden="true"
          />
        )}
        {/* The ocean disc/outline lives INSIDE the zoom transform: outside
            it, zooming scaled the landmasses while the globe's blue circle
            stayed fixed -- land visibly outgrew its own planet. */}
        <path
          d={sphere}
          fill={satellite ? 'transparent' : waterFill}
          onClick={() => setPopover(null)}
        />
        {/* Antique coast band (section 48): a soft double stroke of the
            merged land outline under the fills -- the engraved shading the
            originals use to lift land off the sea. Inert to pointers. */}
        {antiquePolitical && landD && (
          <g pointerEvents="none" aria-hidden="true">
            <path
              d={landD}
              fill="none"
              stroke={ANTIQUE.coast}
              strokeWidth={px(5)}
              vectorEffect="non-scaling-stroke"
              strokeOpacity={0.4}
              strokeLinejoin="round"
            />
            <path
              d={landD}
              fill="none"
              stroke={ANTIQUE.coast}
              strokeWidth={px(2)}
              vectorEffect="non-scaling-stroke"
              strokeOpacity={0.35}
            />
          </g>
        )}
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
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              opacity={dimmed ? 0.45 : 1}
              tabIndex={tabIndexFor(shape.iso3)}
              data-iso3={shape.iso3}
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
                strokeWidth={px(0.6)}
                vectorEffect="non-scaling-stroke"
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
                strokeWidth={px(0.32)}
                vectorEffect="non-scaling-stroke"
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
              data-iso3={marker.iso3}
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
                vectorEffect="non-scaling-stroke"
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
            fontSize={(label.emphasized ? 13 : 10) * labelScale}
            fontStyle={antique ? 'italic' : undefined}
            style={{
              // Land is light in every view now, so labels are dark text
              // with a light halo regardless of theme. The antique sheet
              // letters its names in the serif, italic, umber ink of the
              // engraved originals (section 48).
              fill: antique ? ANTIQUE.ink : 'oklch(20% 0.01 250)',
              paintOrder: 'stroke',
              stroke: antique ? ANTIQUE.paper : GLOBE_LAND_NEUTRAL,
              fontFamily: antique ? 'Newsreader, Georgia, serif' : undefined,
              letterSpacing: antique ? '0.05em' : undefined,
              strokeWidth: (label.emphasized ? 3.5 : 2.5) * labelScale,
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
              const fontSize = label.size * labelScale
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
                      strokeWidth={0.5 * labelScale}
                    />
                  )}
                  <text
                    x={label.x}
                    y={
                      isPlace
                        ? label.y - 2.4 * labelScale
                        : label.y
                    }
                    textAnchor="middle"
                    fontSize={fontSize}
                    fontStyle={label.kind === 'water' ? 'italic' : undefined}
                    style={{
                      fill,
                      paintOrder: 'stroke',
                      stroke: halo,
                      strokeWidth: 2 * labelScale,
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
                fontSize={12 * labelScale}
                style={{
                  fill: 'oklch(20% 0.01 250)',
                  paintOrder: 'stroke',
                  stroke: GLOBE_LAND_NEUTRAL,
                  strokeWidth: 3 * labelScale,
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
      {/* No view-fixed overlays in the antique direction any more (section
          57.3 removed the feTurbulence grain, section 58.2 the vignette):
          Andy still saw a faint darker rectangle over the sheet on his
          phone, and a gradient-filled rect over the whole viewport was the
          last thing painted across the map. The sheet is its sea, lines,
          coast band and lettering now, nothing on top. */}
    </svg>
    </div>

    {/* Bottom sheet (§53.2): in flow under the stage, never over the globe —
        in full screen the stage shrinks above it, so the selected country
        stays visible. Swipe up for more, down to collapse, down again to
        close. */}
    {picked && sheetActive && renderSheet && (
      <section
        className="map-sheet"
        role="region"
        aria-label={`${picked.name} details`}
        aria-live="polite"
        style={{
          maxHeight: sheetExpanded ? (isFullscreen ? '55%' : '24rem') : undefined,
          overflowY: sheetExpanded ? 'auto' : 'hidden',
        }}
      >
        <div
          ref={sheetHandleRef}
          className="map-sheet-handle"
          onPointerDown={onSheetPointerDown}
          onPointerUp={onSheetPointerUp}
          onPointerCancel={() => { sheetDrag.current = null }}
          onClick={() => setSheetExpanded((v) => !v)}
          role="button"
          tabIndex={0}
          aria-expanded={sheetExpanded}
          aria-label={sheetExpanded ? 'Show less' : 'Show more'}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault()
              setSheetExpanded((v) => !v)
            }
          }}
        >
          <span className="map-sheet-grip" aria-hidden="true" />
        </div>
        <div className="flex items-start gap-2 px-4 pb-3">
          <div className="min-w-0 flex-1">
            {renderSheet(picked, sheetExpanded)}
            {nearby.length > 0 && (
              <div className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                Nearby:{' '}
                {nearby.map((t) => (
                  <button
                    key={t.iso3}
                    type="button"
                    className="mr-1.5 mt-1 inline-block rounded-full border px-2.5 py-1 text-xs"
                    style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    onClick={() => pick(t)}
                  >
                    {t.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            aria-label="Close"
            className="popover-close"
            onClick={closeSheet}
          >
            ×
          </button>
        </div>
      </section>
    )}
    </div>
  )
})
