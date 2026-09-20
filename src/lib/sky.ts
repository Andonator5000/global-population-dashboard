/**
 * The real night sky behind the 3-D globe (round 13, DATA_DECISIONS section 66).
 *
 * `data/geo/sky.json` carries 9,096 Bright Star Catalogue stars at their J2000
 * positions with V magnitudes and B-V colours, the IAU proper names, and the
 * 88 IAU constellation figures as polylines through real star positions. This
 * module draws them on a 2-D canvas that sits BENEATH the globe's WebGL and
 * SVG layers, so the black surround stops being empty and becomes the sky the
 * viewer would actually have behind the Earth from that orientation.
 *
 * No React, no d3. The only imports are the browser's.
 *
 *
 * Projection: STEREOGRAPHIC, centred on the view direction
 * -------------------------------------------------------
 * The frame is wide -- the globe alone spans 90 degrees of sky (see
 * `fovForDisc`), and the corners reach past 110. Two candidates:
 *
 *   orthographic   matches the globe's own projection, but compresses
 *                  everything toward the frame edge into ellipses and cannot
 *                  show anything beyond 90 degrees at all. Orion's belt near
 *                  the corner would be a smear.
 *   stereographic  conformal: every small shape keeps its shape and every
 *                  asterism keeps its angles, anywhere in the frame. It is
 *                  what printed star atlases use for exactly this reason,
 *                  and it maps great circles to circles, so a constellation
 *                  line is never kinked by the projection.
 *
 * Stereographic wins: the whole point is that the Plough should be
 * recognisable, and recognition is a matter of shape. Scale grows toward the
 * edge (that is the price of conformality), which reads as the sky opening
 * out around the globe rather than as distortion.
 *
 * The projection is centred on `view.disc` -- the centre of the Earth's disc
 * IS the direction the camera looks, so the sky's centre of projection and
 * the globe's centre are the same point, and the disc is then exactly a
 * circle of radius `disc.r` about it. Occlusion is therefore one distance
 * test per star.
 *
 *
 * Performance
 * -----------
 * Projection state is cached on a view signature: `render` with an unchanged
 * view re-uses the projected screen positions and only repaints. Stars are
 * pre-bucketed at load time by (colour bin, alpha step) so the paint is ~200
 * `beginPath`/`fill` pairs rather than 9,096 state changes, and stars under
 * 0.75 px use `fillRect` (a sub-pixel disc and a sub-pixel square are the
 * same two or three lit pixels, and the rect costs a fraction of the arc).
 * Measured at 1000x1000 CSS px: see .scratch/decisions-r13-sky.md.
 */

// --------------------------------------------------------------------------
// Data shape (produced by etl/sources/sky.py)
// --------------------------------------------------------------------------

export interface SkySource {
  title: string
  authors?: string
  url: string
  file?: string
  commit?: string
  catalogue?: string
  licence: string
  licenceUrl?: string
  citation: string
  notes?: string
}

export interface SkyConstellation {
  /** IAU three-letter abbreviation, e.g. `Ori`. */
  id: string
  /** IAU name, e.g. `Orion`. */
  name: string
  genitive: string | null
  /** 1 = prominent, 3 = faint. Decides which label survives an overlap. */
  rank: number
  /** Spherical centroid of the figure's vertices: [ra, dec] degrees. */
  centre: [number, number]
  /** One entry per polyline, flattened: [ra0, dec0, ra1, dec1, ...]. */
  lines: number[][]
}

export interface SkyData {
  version: number
  equinox: string
  note: string
  stars: {
    count: number
    order: string
    magnitudeRange: [number, number]
    ra: number[]
    dec: number[]
    mag: number[]
    bv: (number | null)[]
    names: [number, string][]
  }
  constellations: SkyConstellation[]
  sources: Record<string, SkySource>
}

export interface SkyView {
  width: number
  height: number
  dpr: number
  /** Centre of the visible disc in CSS px and its radius (the Earth covers it). */
  disc: { cx: number; cy: number; r: number }
  /** Where the camera looks on the celestial sphere: RA/Dec of the view centre (degrees) and a roll (degrees). */
  centre: { ra: number; dec: number; roll: number }
  /** Angular radius of the frame (degrees) - how much sky the frame spans. */
  fov: number
  theme: 'light' | 'dark'
  reducedMotion: boolean
}

export interface SkyRenderer {
  render(view: SkyView): void
  destroy(): void
}

// --------------------------------------------------------------------------
// Loading
// --------------------------------------------------------------------------

const pending = new Map<string, Promise<SkyData>>()

/** Fetches and caches `data/geo/sky.json` (one request per URL per session). */
export function loadSky(url: string): Promise<SkyData> {
  let hit = pending.get(url)
  if (!hit) {
    hit = fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(
          `Could not load the star catalogue (HTTP ${response.status}). ` +
            'Run `python etl/run.py --only sky` to regenerate data/geo/sky.json.',
        )
      }
      return response.json() as Promise<SkyData>
    })
    pending.set(url, hit)
  }
  return hit
}

// --------------------------------------------------------------------------
// Where the camera looks
// --------------------------------------------------------------------------

const DEG = Math.PI / 180

/**
 * General precession in right ascension, degrees per Julian year.
 *
 * m = 3.07496 s/yr of right ascension = 46.12 arcsec/yr. Sidereal time is
 * reckoned from the TRUE equinox of date; the catalogue's right ascensions
 * are J2000 mean places. Subtracting the accumulated mean term from GMST
 * cancels the declination-independent part of that mismatch -- about 0.33
 * degrees by 2026, which is two pixels of sky on a 1000 px globe and would
 * otherwise be a systematic lag. What is left is the declination-dependent
 * term (n sin(alpha) tan(delta), under 0.15 degrees away from the poles) plus
 * nutation and aberration, all well under a pixel.
 */
const PRECESSION_RA_DEG_PER_YEAR = 3.07496 * 15 / 3600

const JD_UNIX_EPOCH = 2440587.5
const DAYS_PER_JULIAN_YEAR = 365.25

function mod360(value: number): number {
  const wrapped = value % 360
  return wrapped < 0 ? wrapped + 360 : wrapped
}

/** Greenwich Mean Sidereal Time in degrees (IAU 1982 series, via JD). */
export function greenwichMeanSiderealTime(date: Date): number {
  const jd = date.getTime() / 86_400_000 + JD_UNIX_EPOCH
  const d = jd - 2_451_545.0
  const t = d / 36_525
  return mod360(
    280.460_618_37 +
      360.985_647_366_29 * d +
      0.000_387_933 * t * t -
      (t * t * t) / 38_710_000,
  )
}

/**
 * The celestial direction the globe's centre points AWAY from the viewer --
 * i.e. the patch of sky the Earth is occulting, which is what belongs behind
 * the disc.
 *
 * Derivation, with d3's sign conventions stated explicitly:
 *
 * 1. `d3.geoRotation([lambda, phi, gamma])` sends the geographic point
 *    (-lambda, -phi) to the projection centre. So the SUB-VIEWER point -- the
 *    place on Earth directly under the camera -- is at longitude -lambda,
 *    latitude -phi.
 *
 * 2. The camera looks from there down through the centre of the Earth. The
 *    sky behind the globe is therefore the celestial direction of the
 *    ANTIPODE of the sub-viewer point:
 *        longitude = -lambda + 180,   latitude = +phi
 *
 * 3. A geographic direction (longitude, latitude) points at the celestial
 *    coordinates
 *        Dec = latitude
 *        RA  = local sidereal time = GMST(date) + longitude
 *    because the zenith of a place has the right ascension of its local
 *    meridian. Hence
 *        dec = +phi
 *        ra  = GMST(date) + 180 - lambda           (minus precession, above)
 *
 * 4. Roll is d3's gamma unchanged. Positive gamma rotates the globe's content
 *    COUNTER-CLOCKWISE on screen (in `rotationPhiGamma` the point's (y, z)
 *    are rotated by +gamma about the view axis, which tilts the north
 *    direction to screen left), and `render` applies `roll` the same way, so
 *    the sky stays glued to the globe through a two-finger twist.
 *
 * Sign check, at rotation [0, 0, 0] on 2026-03-20 12:00 UTC (run
 * `.scratch/sky-test.mjs`): the sub-viewer point is (0 E, 0 N) at local noon
 * two days before the equinox, so the Sun -- right ascension about 0h -- is
 * nearly overhead. The sky behind the Earth is therefore the anti-solar
 * direction, right ascension about 0h + 12h = 12h = 180 degrees, declination
 * 0. GMST at that instant is about 0h (the equation of time and the two-day
 * offset move it by a degree or two), and the formula gives
 * ra = GMST + 180 - 0 ~ 180. It checks out, and the test asserts it to
 * within 3 degrees.
 */
export function skyCentreForGlobe(
  rotation: [number, number, number],
  date: Date,
): { ra: number; dec: number; roll: number } {
  const [lambda, phi, gamma] = rotation
  const days = date.getTime() / 86_400_000 + JD_UNIX_EPOCH - 2_451_545.0
  const precession = (PRECESSION_RA_DEG_PER_YEAR * days) / DAYS_PER_JULIAN_YEAR
  return {
    ra: mod360(greenwichMeanSiderealTime(date) - precession + 180 - lambda),
    dec: Math.max(-90, Math.min(90, phi)),
    roll: gamma,
  }
}

/**
 * The frame's angular radius that makes the globe occult exactly the
 * celestial hemisphere behind it.
 *
 * The globe is drawn orthographically, which is the view from infinitely far
 * away; from there the Earth hides a full hemisphere of sky, so the disc's
 * edge is 90 degrees from the view centre. Fixing `disc.r` at 90 degrees sets
 * the stereographic scale k = r / (2 tan 45) = r / 2, and the frame's
 * inscribed radius R = min(width, height) / 2 then reaches
 *     fov = 2 * atan(R / (2k)) = 2 * atan(R / r)
 *
 * Use this as the default; pass something smaller for a tighter, more
 * telescopic sky, or larger for a wider one. It is a presentation choice, not
 * a data one -- the positions are the same either way.
 */
export function fovForDisc(
  disc: { r: number },
  width: number,
  height: number,
): number {
  const inscribed = Math.min(width, height) / 2
  if (disc.r <= 0) return 90
  return (2 * Math.atan(inscribed / disc.r)) / DEG
}

// --------------------------------------------------------------------------
// Colour
// --------------------------------------------------------------------------

/**
 * B-V colour index -> effective temperature (Ballesteros 2012):
 *     T = 4600 K * (1 / (0.92 (B-V) + 1.70) + 1 / (0.92 (B-V) + 0.62))
 * accurate to a few per cent across the main sequence, which is far better
 * than the eye can judge at two pixels.
 */
function temperatureForBV(bv: number): number {
  const a = 0.92 * bv
  return 4600 * (1 / (a + 1.7) + 1 / (a + 0.62))
}

/** Blackbody temperature -> sRGB, the standard piecewise fit (Helland). */
function blackbodyRgb(kelvin: number): [number, number, number] {
  const t = Math.max(1000, Math.min(40_000, kelvin)) / 100
  let r: number
  let g: number
  let b: number
  if (t <= 66) {
    r = 255
    g = 99.4708025861 * Math.log(t) - 161.1195681661
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592)
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492)
  }
  if (t >= 66) {
    b = 255
  } else if (t <= 19) {
    b = 0
  } else {
    b = 138.5177312231 * Math.log(t - 10) - 305.0447927307
  }
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)))
  return [clamp(r), clamp(g), clamp(b)]
}

/**
 * Star tint.
 *
 * The eye sees almost no colour in a naked-eye star -- rods do not resolve
 * hue at that flux, which is why Betelgeuse reads "slightly orange" and not
 * orange. So the blackbody colour is mixed most of the way back to white:
 * enough that Rigel is perceptibly cooler than Antares side by side, not
 * enough to turn the sky into a sweet-shop. `TINT` is that mix.
 */
const TINT = 0.42

const BV_MIN = -0.45
const BV_MAX = 2.1
const BV_BINS = 22
/** Stars the catalogue gives no B-V: drawn neutral white rather than guessed. */
const BV_DEFAULT = 0.4

function bvBin(bv: number | null): number {
  const value = bv === null || !Number.isFinite(bv) ? BV_DEFAULT : bv
  const t = (value - BV_MIN) / (BV_MAX - BV_MIN)
  return Math.max(0, Math.min(BV_BINS - 1, Math.round(t * (BV_BINS - 1))))
}

function binColour(bin: number): [number, number, number] {
  const bv = BV_MIN + (bin / (BV_BINS - 1)) * (BV_MAX - BV_MIN)
  const [r, g, b] = blackbodyRgb(temperatureForBV(bv))
  const mix = (channel: number) => Math.round(255 + (channel - 255) * TINT)
  return [mix(r), mix(g), mix(b)]
}

// --------------------------------------------------------------------------
// Magnitude -> size and alpha
// --------------------------------------------------------------------------

/**
 * Radius in CSS px at dpr 1.
 *
 * Linear in magnitude, which is already logarithmic in flux -- the mapping
 * every printed star atlas uses, because it is the one that makes the
 * brightness ORDER legible at a glance rather than the brightness RATIO
 * (which would make Sirius a blob 250 times the area of a mag-6 star). The
 * brief's anchors: magnitude 0 -> 2.4 px, magnitude 6 -> 0.5 px, so
 *     r(m) = 2.4 - 0.3167 m
 * clamped at both ends so Sirius (-1.46) does not run away and mag 7.1 stays
 * a visible speck.
 */
const MAG_RADIUS_0 = 2.4
const MAG_RADIUS_SLOPE = (MAG_RADIUS_0 - 0.5) / 6
const MAG_RADIUS_MAX = 3.1
const MAG_RADIUS_MIN = 0.36

function radiusForMag(mag: number): number {
  return Math.max(
    MAG_RADIUS_MIN,
    Math.min(MAG_RADIUS_MAX, MAG_RADIUS_0 - MAG_RADIUS_SLOPE * mag),
  )
}

/**
 * Opacity. The faint end fades as well as shrinking, so the limiting
 * magnitude is a soft edge rather than a hard cut where the catalogue stops.
 */
function alphaForMag(mag: number): number {
  if (mag <= 3.5) return 1
  return Math.max(0.34, 1 - (mag - 3.5) * 0.19)
}

const ALPHA_STEPS = 12

function alphaStep(alpha: number): number {
  return Math.max(0, Math.min(ALPHA_STEPS - 1, Math.round(alpha * (ALPHA_STEPS - 1))))
}

/** Brighter than this gets a soft halo, the way a bright star blooms. */
const GLOW_MAG = 1.6

// --------------------------------------------------------------------------
// Drawing constants
// --------------------------------------------------------------------------

const FILL_RECT_BELOW = 0.75
const LINE_ALPHA = 0.16
const LINE_WIDTH = 0.7
const LINE_COLOUR = '150, 180, 215'
const LABEL_ALPHA = 0.4
const LABEL_COLOUR = '188, 206, 230'
const LABEL_SIZE = 11
const LABEL_TRACKING = 0.09
/** Great-circle steps: a constellation line is subdivided to this many degrees. */
const LINE_STEP_DEG = 2
/** Light theme keeps the same black surround, just very slightly calmer. */
const THEME_GAIN: Record<'light' | 'dark', number> = { dark: 1, light: 0.92 }

const FALLBACK_FONT =
  "'Public Sans', ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

/**
 * `ctx.font` does not resolve CSS custom properties, so `var(--font-sans)`
 * has to be read off the document once and cached -- the same trick
 * `resolveCssColor` in globegl.ts uses for colours.
 */
let cachedFontStack: string | null = null

function fontStack(): string {
  if (cachedFontStack !== null) return cachedFontStack
  let stack = ''
  try {
    stack = getComputedStyle(document.documentElement)
      .getPropertyValue('--font-sans')
      .trim()
  } catch {
    stack = ''
  }
  cachedFontStack = stack || FALLBACK_FONT
  return cachedFontStack
}

// --------------------------------------------------------------------------
// Prepared catalogue
// --------------------------------------------------------------------------

interface PreparedConstellation {
  name: string
  rank: number
  /** Centroid unit vector. */
  cx: number
  cy: number
  cz: number
  /** Great-circle-densified polylines as unit vectors, flattened xyz. */
  polylines: Float64Array[]
}

interface Prepared {
  count: number
  x: Float64Array
  y: Float64Array
  z: Float64Array
  radius: Float32Array
  glow: Uint8Array
  /** Index list sorted by paint bucket. */
  order: Uint32Array
  /** Start offset of each bucket in `order`, length buckets + 1. */
  bucketStart: Uint32Array
  bucketFill: (string | null)[]
  constellations: PreparedConstellation[]
}

function unit(raDeg: number, decDeg: number): [number, number, number] {
  const ra = raDeg * DEG
  const dec = decDeg * DEG
  const cosDec = Math.cos(dec)
  return [cosDec * Math.cos(ra), cosDec * Math.sin(ra), Math.sin(dec)]
}

/** Densify a great-circle arc between two unit vectors, inclusive of `a`. */
function densify(
  a: [number, number, number],
  b: [number, number, number],
  out: number[],
): void {
  const dot = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))
  const omega = Math.acos(dot)
  out.push(a[0], a[1], a[2])
  if (omega < 1e-9) return
  const steps = Math.max(1, Math.ceil((omega / DEG) / LINE_STEP_DEG))
  const sinOmega = Math.sin(omega)
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps
    const ka = Math.sin((1 - t) * omega) / sinOmega
    const kb = Math.sin(t * omega) / sinOmega
    out.push(ka * a[0] + kb * b[0], ka * a[1] + kb * b[1], ka * a[2] + kb * b[2])
  }
}

function prepare(data: SkyData): Prepared {
  const { ra, dec, mag, bv } = data.stars
  const count = Math.min(ra.length, dec.length, mag.length)

  const x = new Float64Array(count)
  const y = new Float64Array(count)
  const z = new Float64Array(count)
  const radius = new Float32Array(count)
  const glow = new Uint8Array(count)
  const bucket = new Uint16Array(count)

  const bucketCount = BV_BINS * ALPHA_STEPS
  const counts = new Uint32Array(bucketCount)

  for (let i = 0; i < count; i += 1) {
    const raI = ra[i] ?? 0
    const decI = dec[i] ?? 0
    const magI = mag[i] ?? 6
    const [ux, uy, uz] = unit(raI, decI)
    x[i] = ux
    y[i] = uy
    z[i] = uz
    radius[i] = radiusForMag(magI)
    glow[i] = magI <= GLOW_MAG ? 1 : 0
    const b = bvBin(bv[i] ?? null) * ALPHA_STEPS + alphaStep(alphaForMag(magI))
    bucket[i] = b
    counts[b] = (counts[b] ?? 0) + 1
  }

  const bucketStart = new Uint32Array(bucketCount + 1)
  for (let b = 0; b < bucketCount; b += 1) {
    bucketStart[b + 1] = (bucketStart[b] ?? 0) + (counts[b] ?? 0)
  }
  const cursor = Uint32Array.from(bucketStart.subarray(0, bucketCount))
  const order = new Uint32Array(count)
  for (let i = 0; i < count; i += 1) {
    const b = bucket[i] ?? 0
    order[cursor[b] ?? 0] = i
    cursor[b] = (cursor[b] ?? 0) + 1
  }

  const bucketFill: (string | null)[] = new Array(bucketCount).fill(null)
  for (let b = 0; b < bucketCount; b += 1) {
    if ((counts[b] ?? 0) === 0) continue
    const [r, g, bl] = binColour(Math.floor(b / ALPHA_STEPS))
    const alpha = (b % ALPHA_STEPS) / (ALPHA_STEPS - 1)
    bucketFill[b] = `rgba(${r},${g},${bl},${alpha.toFixed(3)})`
  }

  const constellations: PreparedConstellation[] = []
  for (const figure of data.constellations) {
    const polylines: Float64Array[] = []
    for (const flat of figure.lines) {
      if (flat.length < 4) continue
      const out: number[] = []
      for (let i = 0; i + 3 < flat.length; i += 2) {
        densify(
          unit(flat[i] ?? 0, flat[i + 1] ?? 0),
          unit(flat[i + 2] ?? 0, flat[i + 3] ?? 0),
          out,
        )
      }
      const last = unit(flat[flat.length - 2] ?? 0, flat[flat.length - 1] ?? 0)
      out.push(last[0], last[1], last[2])
      polylines.push(Float64Array.from(out))
    }
    const [cx, cy, cz] = unit(figure.centre[0], figure.centre[1])
    constellations.push({
      name: figure.name,
      rank: figure.rank,
      cx,
      cy,
      cz,
      polylines,
    })
  }
  // Rank 1 first: when two labels collide, the prominent figure keeps its name.
  constellations.sort((a, b) => a.rank - b.rank)

  return {
    count,
    x,
    y,
    z,
    radius,
    glow,
    order,
    bucketStart,
    bucketFill,
    constellations,
  }
}

// --------------------------------------------------------------------------
// The renderer
// --------------------------------------------------------------------------

function viewSignature(view: SkyView): string {
  const { disc, centre } = view
  return [
    view.width,
    view.height,
    view.dpr,
    disc.cx,
    disc.cy,
    disc.r,
    centre.ra,
    centre.dec,
    centre.roll,
    view.fov,
  ].join('|')
}

export function createSky(canvas: HTMLCanvasElement, data: SkyData): SkyRenderer {
  const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true })
  if (!ctx) {
    return { render() {}, destroy() {} }
  }

  const prepared = prepare(data)
  const screenX = new Float32Array(prepared.count)
  const screenY = new Float32Array(prepared.count)
  const visible = new Uint8Array(prepared.count)
  const labelWidths = new Map<string, number>()

  let signature = ''
  let destroyed = false

  // Camera basis, recomputed on every view change.
  let ux = 0
  let uy = 0
  let uz = 0 // screen right (WEST -- right ascension increases to the left)
  let vx = 0
  let vy = 0
  let vz = 0 // screen up (celestial north)
  let wx = 0
  let wy = 0
  let wz = 0 // out of the screen, toward the view centre
  let scale = 1
  let cosRoll = 1
  let sinRoll = 0

  function setCamera(view: SkyView): void {
    const [dx, dy, dz] = unit(view.centre.ra, view.centre.dec)
    wx = dx
    wy = dy
    wz = dz

    // Celestial north projected perpendicular to the view axis. At the poles
    // it degenerates, so fall back to a fixed axis (roll then owns the
    // orientation, which is the only sensible answer there anyway).
    let nx = -dz * dx
    let ny = -dz * dy
    let nz = 1 - dz * dz
    let norm = Math.hypot(nx, ny, nz)
    if (norm < 1e-7) {
      nx = 1
      ny = 0
      nz = 0
      norm = 1
    }
    vx = nx / norm
    vy = ny / norm
    vz = nz / norm

    // u = w x v. With v = north and w = the view direction, u points WEST:
    // an observer inside the celestial sphere sees right ascension increase
    // to the left, which is the mirror a naked-eye sky chart has and a map of
    // the globe does not. Getting this wrong mirrors every constellation.
    ux = wy * vz - wz * vy
    uy = wz * vx - wx * vz
    uz = wx * vy - wy * vx

    // Stereographic: r = 2 tan(theta / 2). Fit `fov` to the frame's
    // inscribed radius so the nominated field is always fully visible.
    const inscribed = Math.min(view.width, view.height) / 2
    const fov = Math.max(1, Math.min(170, view.fov))
    scale = inscribed / (2 * Math.tan((fov * DEG) / 2))

    const roll = view.centre.roll * DEG
    cosRoll = Math.cos(roll)
    sinRoll = Math.sin(roll)
  }

  /** Unit vector -> screen CSS px. Returns false when it is behind the camera. */
  function project(
    px: number,
    py: number,
    pz: number,
    view: SkyView,
    out: { x: number; y: number },
  ): boolean {
    const zc = px * wx + py * wy + pz * wz
    if (zc <= -0.6) return false // past 127 degrees; stereographic runs away
    const denom = 1 + zc
    if (denom < 1e-6) return false
    const k = (2 * scale) / denom
    const xc = (px * ux + py * uy + pz * uz) * k
    const yc = (px * vx + py * vy + pz * vz) * k
    // Positive roll turns the sky counter-clockwise, matching d3's gamma.
    out.x = view.disc.cx + (xc * cosRoll - yc * sinRoll)
    out.y = view.disc.cy - (xc * sinRoll + yc * cosRoll)
    return true
  }

  function projectStars(view: SkyView): void {
    const { count, x, y, z, radius } = prepared
    const { width, height, disc } = view
    const rr = disc.r * disc.r
    for (let i = 0; i < count; i += 1) {
      const px = x[i] ?? 0
      const py = y[i] ?? 0
      const pz = z[i] ?? 0
      const zc = px * wx + py * wy + pz * wz
      if (zc <= -0.6) {
        visible[i] = 0
        continue
      }
      const k = (2 * scale) / (1 + zc)
      const xc = (px * ux + py * uy + pz * uz) * k
      const yc = (px * vx + py * vy + pz * vz) * k
      const sx = disc.cx + (xc * cosRoll - yc * sinRoll)
      const sy = disc.cy - (xc * sinRoll + yc * cosRoll)
      const pad = (radius[i] ?? 1) + 2
      if (sx < -pad || sy < -pad || sx > width + pad || sy > height + pad) {
        visible[i] = 0
        continue
      }
      // Occlusion: the Earth's disc is exactly a circle about the projection
      // centre, so the whole cull is one squared distance.
      const dx = sx - disc.cx
      const dy = sy - disc.cy
      if (dx * dx + dy * dy <= rr) {
        visible[i] = 0
        continue
      }
      screenX[i] = sx
      screenY[i] = sy
      visible[i] = 1
    }
  }

  function drawStars(view: SkyView): void {
    const gain = THEME_GAIN[view.theme]
    const { order, bucketStart, bucketFill, radius, glow } = prepared
    ctx!.globalAlpha = gain
    for (let b = 0; b < bucketFill.length; b += 1) {
      const fill = bucketFill[b]
      if (!fill) continue
      const from = bucketStart[b] ?? 0
      const to = bucketStart[b + 1] ?? from
      if (to === from) continue
      let opened = false
      for (let j = from; j < to; j += 1) {
        const i = order[j] ?? 0
        if (!visible[i]) continue
        const r = radius[i] ?? 1
        const sx = screenX[i] ?? 0
        const sy = screenY[i] ?? 0
        if (r < FILL_RECT_BELOW) {
          // Sub-pixel: a square and a disc light the same pixels, and the
          // rect skips the path machinery entirely.
          if (opened) {
            ctx!.fill()
            opened = false
          }
          ctx!.fillStyle = fill
          ctx!.fillRect(sx - r, sy - r, r * 2, r * 2)
          continue
        }
        if (!opened) {
          ctx!.fillStyle = fill
          ctx!.beginPath()
          opened = true
        }
        ctx!.moveTo(sx + r, sy)
        ctx!.arc(sx, sy, r, 0, Math.PI * 2)
      }
      if (opened) ctx!.fill()
    }
    ctx!.globalAlpha = 1

    // Halos last, over the discs. Skipped under reduced motion: a soft
    // gradient re-projected on every view change is the one thing here that
    // visibly shimmers when the globe is dragged.
    if (view.reducedMotion) return
    for (let i = 0; i < prepared.count; i += 1) {
      if (!glow[i] || !visible[i]) continue
      const sx = screenX[i] ?? 0
      const sy = screenY[i] ?? 0
      const r = (radius[i] ?? 1) * 4.2
      const gradient = ctx!.createRadialGradient(sx, sy, 0, sx, sy, r)
      gradient.addColorStop(0, `rgba(255,255,255,${0.26 * gain})`)
      gradient.addColorStop(0.45, `rgba(200,220,255,${0.08 * gain})`)
      gradient.addColorStop(1, 'rgba(160,190,255,0)')
      ctx!.fillStyle = gradient
      ctx!.beginPath()
      ctx!.arc(sx, sy, r, 0, Math.PI * 2)
      ctx!.fill()
    }
  }

  const pointA = { x: 0, y: 0 }
  const pointB = { x: 0, y: 0 }

  function drawLines(view: SkyView): void {
    const { disc, width, height } = view
    const rr = disc.r * disc.r
    const gain = THEME_GAIN[view.theme]
    ctx!.strokeStyle = `rgba(${LINE_COLOUR},${(LINE_ALPHA * gain).toFixed(3)})`
    ctx!.lineWidth = LINE_WIDTH
    ctx!.lineCap = 'round'
    ctx!.lineJoin = 'round'
    ctx!.beginPath()
    for (const figure of prepared.constellations) {
      for (const flat of figure.polylines) {
        let havePrev = false
        let prevX = 0
        let prevY = 0
        let prevInside = false
        for (let i = 0; i + 2 < flat.length + 1; i += 3) {
          const ok = project(
            flat[i] ?? 0,
            flat[i + 1] ?? 0,
            flat[i + 2] ?? 0,
            view,
            pointA,
          )
          if (!ok) {
            havePrev = false
            continue
          }
          const sx = pointA.x
          const sy = pointA.y
          const dx = sx - disc.cx
          const dy = sy - disc.cy
          const inside = dx * dx + dy * dy <= rr
          if (havePrev && !(prevInside && inside)) {
            const offFrame =
              (sx < 0 && prevX < 0) ||
              (sy < 0 && prevY < 0) ||
              (sx > width && prevX > width) ||
              (sy > height && prevY > height)
            if (!offFrame) {
              // The segment is short (2 degrees), so clipping it against the
              // Earth's limb is a straight-line circle intersection.
              if (!inside && !prevInside) {
                ctx!.moveTo(prevX, prevY)
                ctx!.lineTo(sx, sy)
              } else if (inside) {
                clipToCircle(prevX, prevY, sx, sy, disc, pointB)
                ctx!.moveTo(prevX, prevY)
                ctx!.lineTo(pointB.x, pointB.y)
              } else {
                clipToCircle(sx, sy, prevX, prevY, disc, pointB)
                ctx!.moveTo(sx, sy)
                ctx!.lineTo(pointB.x, pointB.y)
              }
            }
          }
          prevX = sx
          prevY = sy
          prevInside = inside
          havePrev = true
        }
      }
    }
    ctx!.stroke()
  }

  function drawLabels(view: SkyView): void {
    const { disc } = view
    const size = LABEL_SIZE
    const gain = THEME_GAIN[view.theme]
    ctx!.font = `${size}px ${fontStack()}`
    const canSmallCaps = 'fontVariantCaps' in ctx!
    const typed = ctx! as CanvasRenderingContext2D & {
      fontVariantCaps?: string
      letterSpacing?: string
    }
    if (canSmallCaps) typed.fontVariantCaps = 'small-caps'
    if ('letterSpacing' in typed) typed.letterSpacing = `${LABEL_TRACKING}em`
    ctx!.textAlign = 'center'
    ctx!.textBaseline = 'middle'
    ctx!.fillStyle = `rgba(${LABEL_COLOUR},${(LABEL_ALPHA * gain).toFixed(3)})`

    const placed: number[] = [] // x0, y0, x1, y1 per placed label
    const rr = disc.r * disc.r
    for (const figure of prepared.constellations) {
      if (!project(figure.cx, figure.cy, figure.cz, view, pointA)) continue
      const sx = pointA.x
      const sy = pointA.y
      const dx = sx - disc.cx
      const dy = sy - disc.cy
      if (dx * dx + dy * dy <= rr) continue // behind the Earth
      const text = canSmallCaps ? figure.name : figure.name.toUpperCase()
      let width = labelWidths.get(text) ?? 0
      if (!width) {
        width = ctx!.measureText(text).width
        labelWidths.set(text, width)
      }
      const halfW = width / 2 + 5
      const halfH = size * 0.7
      const x0 = sx - halfW
      const y0 = sy - halfH
      const x1 = sx + halfW
      const y1 = sy + halfH
      if (x0 < 2 || y0 < 2 || x1 > view.width - 2 || y1 > view.height - 2) continue
      let clash = false
      for (let i = 0; i < placed.length; i += 4) {
        if (
          x0 < (placed[i + 2] ?? 0) &&
          x1 > (placed[i] ?? 0) &&
          y0 < (placed[i + 3] ?? 0) &&
          y1 > (placed[i + 1] ?? 0)
        ) {
          clash = true
          break
        }
      }
      if (clash) continue
      placed.push(x0, y0, x1, y1)
      ctx!.fillText(text, sx, sy)
    }
    if ('letterSpacing' in typed) typed.letterSpacing = '0px'
    if (canSmallCaps) typed.fontVariantCaps = 'normal'
  }

  function render(view: SkyView): void {
    if (destroyed) return
    const dpr = Math.max(0.5, view.dpr)
    const backingW = Math.round(view.width * dpr)
    const backingH = Math.round(view.height * dpr)
    if (canvas.width !== backingW || canvas.height !== backingH) {
      canvas.width = backingW
      canvas.height = backingH
      signature = '' // a resize invalidates every cached screen position
    }
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx!.clearRect(0, 0, view.width, view.height)

    const next = viewSignature(view)
    if (next !== signature) {
      setCamera(view)
      projectStars(view)
      signature = next
    } else {
      setCamera(view) // cheap; keeps the line/label projection in step
    }

    drawLines(view)
    drawStars(view)
    drawLabels(view)
  }

  function destroy(): void {
    destroyed = true
    labelWidths.clear()
    try {
      ctx!.setTransform(1, 0, 0, 1, 0, 0)
      ctx!.clearRect(0, 0, canvas.width, canvas.height)
    } catch {
      /* the canvas may already be detached */
    }
  }

  return { render, destroy }
}

/**
 * Where the straight segment from `outside` to `inside` crosses the disc's
 * edge. Both points are in CSS px; `outside` is known to be outside.
 */
function clipToCircle(
  ox: number,
  oy: number,
  ix: number,
  iy: number,
  disc: { cx: number; cy: number; r: number },
  out: { x: number; y: number },
): void {
  const dx = ix - ox
  const dy = iy - oy
  const fx = ox - disc.cx
  const fy = oy - disc.cy
  const a = dx * dx + dy * dy
  const b = 2 * (fx * dx + fy * dy)
  const c = fx * fx + fy * fy - disc.r * disc.r
  const disc2 = b * b - 4 * a * c
  if (a < 1e-12 || disc2 < 0) {
    out.x = ox
    out.y = oy
    return
  }
  const root = Math.sqrt(disc2)
  let t = (-b - root) / (2 * a)
  if (t < 0 || t > 1) t = (-b + root) / (2 * a)
  t = Math.max(0, Math.min(1, t))
  out.x = ox + dx * t
  out.y = oy + dy * t
}
