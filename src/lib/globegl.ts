/**
 * WebGL imagery renderer for the satellite / terrain base views
 * (round 3, DATA_DECISIONS.md §43).
 *
 * WHY THIS EXISTS. Round 2 warped the Blue Marble / hypso tiles onto the
 * map with affine 2-D-canvas quads (`terrain.ts`). An affine map of a
 * lon/lat quad is only a good approximation of the orthographic
 * projection near the centre of the disc: towards the limb and the poles
 * the quads pull apart and the dark ocean underlay showed through as
 * wedge-shaped streaks along meridians that widened as the globe spun,
 * and any quad with a corner past the horizon was culled, which cut a
 * hole around the pole. No amount of overdraw fixes a model error.
 *
 * WHAT THIS DOES INSTEAD. On the globe every device pixel is INVERSE
 * projected in a fragment shader — exactly d3's orthographic + rotation
 * maths, run once per pixel on the GPU — and samples an equirectangular
 * texture with mipmaps and anisotropic filtering. There are no quads, so
 * there are no seams; the horizon is an exact, feathered circle. Flat
 * (equal-area) projections draw a 1-degree lon/lat mesh whose vertices
 * were forward-projected ONCE by the same d3 projection the SVG uses, so
 * imagery and borders agree to the pixel.
 *
 * Tiles: the world base (tier 0) is one texture; finer tiers are 45-degree
 * tiles drawn as extra passes restricted to their lon/lat window. Textures
 * stay resident across base-view switches (one renderer per map for the
 * component's lifetime) and the other view's base texture is prefetched
 * during idle time, so switching Political / Satellite / Terrain a second
 * time is immediate.
 *
 * The renderer owns its LAST VIEW: when a tile lands it repaints from that
 * view, never from React state — mid-drag React's rotation is stale, and
 * repainting from it was the round-2 "borders detach from the imagery"
 * bug.
 */

import { geoDistance, type GeoProjection } from 'd3-geo'

import { lowPowerDevice } from './device'
import { type ImageryGrade } from './mapgrade'
import {
  loadTerrainMeta,
  terrainTileUrl,
  type TerrainMeta,
  type TerrainTier,
} from './mapdetail'

export interface ImageryLayout {
  /** viewBox-to-element scale (preserveAspectRatio meet). */
  scale: number
  offsetX: number
  offsetY: number
  dpr: number
}

export interface BorderStyle {
  /** Straight RGBA, 0..1. */
  color: [number, number, number, number]
}

export interface ImageryView {
  /** Draw the country outlines in the same pass (drag frames on the globe;
   *  at rest the SVG owns them). */
  borders?: BorderStyle | undefined
  /**
   * Round 4 (§51): draw the client-supplied world raster (see setRaster)
   * as the base instead of the imagery set. This is how the POLITICAL
   * globe's drag frames reach the GPU: the country fills are baked into
   * one equirectangular picture whenever the palette changes, and a drag
   * frame is then the same single inverse-projection pass the satellite
   * view already paid for — not 250 d3 canvas paths per frame.
   */
  raster?: boolean | undefined
  /** Per-pixel tone over the imagery (never applied to the raster). */
  grade?: ImageryGrade | undefined
  projection: GeoProjection
  /** Identity of the flat projection, for mesh caching. */
  projectionKey: string
  isGlobe: boolean
  rotation: [number, number]
  transform: { x: number; y: number; k: number }
  layout: ImageryLayout
  cssWidth: number
  cssHeight: number
  /** Resolved CSS colour for the disc while imagery is still loading. */
  oceanFill: string
}

export interface ImageryRenderer {
  /** Switch the imagery set ('geo/terrain' or 'geo/terrain-hypso'). */
  setImagery(basePath: string): void
  /** Country outline segments as [lon, lat, lon, lat, ...] in RADIANS,
   *  two vertices per segment, already subdivided along great circles. */
  setBorders(segments: Float32Array): void
  /** Fetch + decode + upload an imagery set's world base ahead of need. */
  prefetch(basePath: string): void
  /** True once the active set's world base is on the GPU. */
  ready(): boolean
  /**
   * Supply (or clear) the world raster drawn when a view asks for
   * `raster`. Equirectangular, whole world, north up. Returns false when
   * this renderer cannot draw rasters at all (the 2-D fallback), so the
   * caller keeps its own drag frames.
   */
  setRaster(source: TexImageSource | null): boolean
  render(view: ImageryView): void
  attribution(): string | null
  destroy(): void
}

/** Resident fine-tier tiles (each 2700² RGB + mipmaps ≈ 39 MB on the GPU,
 *  ~10 MB at the low-power decode size). Eviction is LRU. Phones get half
 *  the count AND quarter-size tiles (§51): eight full tiles are ~310 MB of
 *  texture, which is where iOS Safari starts losing the context. */
function tileBudget(): number {
  return lowPowerDevice() ? 4 : 8
}

/** Decode fine tiles at this edge length on low-power devices (the tiles
 *  are 2700² on disk). At a phone's capped backing store a 90-degree tile
 *  at 1350 px is still ~15 px per degree, finer than the screen can show
 *  until the zoom passes 9x, where the next tier takes over anyway. */
function tileDecodeSize(): number | null {
  return lowPowerDevice() ? 1350 : null
}

const MESH_STEP_DEG = 1

const VERT_GLOBE = `#version 300 es
in vec2 a_clip;
out vec2 v_lonlat;
void main() { gl_Position = vec4(a_clip, 0.0, 1.0); v_lonlat = vec2(0.0); }
`

const VERT_FLAT = `#version 300 es
in vec2 a_view;
in vec2 a_lonlat;
uniform vec4 u_affine;
uniform vec2 u_size;
out vec2 v_lonlat;
void main() {
  vec2 d = u_affine.xy + u_affine.zw * a_view;
  gl_Position = vec4(d.x / u_size.x * 2.0 - 1.0, 1.0 - d.y / u_size.y * 2.0, 0.0, 1.0);
  v_lonlat = a_lonlat;
}
`

/** Outline segments on the globe: the SAME rotation + orthographic maths
 *  as the imagery's inverse, run forward per vertex, so borders and
 *  imagery move from one uniform in one draw. */
const VERT_LINE = `#version 300 es
in vec2 a_lonlat;
uniform vec3 u_ortho;
uniform vec2 u_size;
uniform vec2 u_rot;
out float v_depth;
void main() {
  float lon = a_lonlat.x + u_rot.x;
  float cl = cos(a_lonlat.y);
  float x = cl * cos(lon);
  float y = cl * sin(lon);
  float z = sin(a_lonlat.y);
  float cp = cos(u_rot.y);
  float sp = sin(u_rot.y);
  float xp = x * cp - z * sp;
  float zp = z * cp + x * sp;
  v_depth = xp;
  vec2 d = vec2(u_ortho.x + u_ortho.y * y, u_ortho.z - u_ortho.y * zp);
  gl_Position = vec4(d.x / u_size.x * 2.0 - 1.0, 1.0 - d.y / u_size.y * 2.0, 0.0, 1.0);
}
`

const FRAG_LINE = `#version 300 es
precision highp float;
uniform vec4 u_color;
in float v_depth;
out vec4 o;
void main() {
  if (v_depth < 0.0) discard;
  o = vec4(u_color.rgb * u_color.a, u_color.a);
}
`

const FRAG = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform int u_globe;
uniform int u_hasTex;
uniform int u_isBase;
/* A, B, C: device_x = A + B*X ; device_y(top-down) = C - B*Y. */
uniform vec3 u_ortho;
uniform float u_height;
/* delta lambda, delta phi (radians): d3 rotate([lambda, phi, 0]). */
uniform vec2 u_rot;
/* lon0, lat0, lon1, lat1 in radians of the texture window. */
uniform vec4 u_window;
uniform vec3 u_ocean;
/* Tone grade (section 51): desaturate, sepia, lift, tint amount. */
uniform vec4 u_grade;
uniform vec3 u_tint;
in vec2 v_lonlat;
out vec4 o;
const float PI = 3.141592653589793;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec3 grade(vec3 c) {
  float l = dot(c, LUMA);
  c = mix(c, vec3(l), u_grade.x);
  c = mix(c, l * vec3(1.20, 1.02, 0.76), u_grade.y);
  c = mix(c, l * u_tint / max(dot(u_tint, LUMA), 1e-3), u_grade.w);
  c += u_grade.z * (1.0 - c);
  return clamp(c, 0.0, 1.0);
}
void main() {
  float lon; float lat; float alpha = 1.0;
  if (u_globe == 1) {
    vec2 p = vec2((gl_FragCoord.x - u_ortho.x) / u_ortho.y,
                  (u_ortho.z - (u_height - gl_FragCoord.y)) / u_ortho.y);
    float r2 = dot(p, p);
    // Feather the rim over one device pixel.
    alpha = clamp((1.0 - sqrt(r2)) * u_ortho.y + 0.5, 0.0, 1.0);
    if (alpha <= 0.0) discard;
    float xp = sqrt(max(0.0, 1.0 - r2));
    float yp = p.x;
    float zp = p.y;
    float cp = cos(u_rot.y);
    float sp = sin(u_rot.y);
    float x = xp * cp + zp * sp;
    float z = zp * cp - xp * sp;
    lon = atan(yp, x) - u_rot.x;
    lat = asin(clamp(z, -1.0, 1.0));
  } else {
    lon = v_lonlat.x;
    lat = v_lonlat.y;
  }
  if (u_hasTex == 0) { o = vec4(u_ocean * alpha, alpha); return; }
  // Longitude relative to the window centre, branch cut on the far side.
  float lonC = 0.5 * (u_window.x + u_window.z);
  float rel = lon - lonC;
  rel -= 2.0 * PI * floor((rel + PI) / (2.0 * PI));
  float w = u_window.z - u_window.x;
  float u = (rel + 0.5 * w) / w;
  float v = (u_window.w - lat) / (u_window.w - u_window.y);
  if (u_isBase == 0) {
    if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0 || alpha < 1.0) discard;
  }
  // Mip level from the SMALLER of two derivative estimates: u wraps at the
  // antimeridian and fract(u+0.5) wraps half a world away, so whichever is
  // continuous here is the true rate of change. Without this the seam
  // column samples the coarsest mip and draws a blurry meridian.
  vec2 uv = vec2(u, v);
  vec2 dx = dFdx(uv);
  vec2 dy = dFdy(uv);
  float u2 = fract(u + 0.5);
  float dxu2 = dFdx(u2);
  float dyu2 = dFdy(u2);
  if (abs(dxu2) < abs(dx.x)) dx.x = dxu2;
  if (abs(dyu2) < abs(dy.x)) dy.x = dyu2;
  vec3 c = grade(textureGrad(u_tex, uv, dx, dy).rgb);
  o = vec4(c * alpha, alpha);
}
`

interface GpuTexture {
  texture: WebGLTexture
  width: number
  height: number
}

interface FlatMesh {
  positions: WebGLBuffer
  lonlats: WebGLBuffer
  indexCache: Map<string, { buffer: WebGLBuffer; count: number }>
}

function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('shader alloc failed')
  gl.shaderSource(shader, src)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`shader: ${log}`)
  }
  return shader
}

function link(
  gl: WebGL2RenderingContext,
  vert: string,
  frag: string,
  attribs: string[],
) {
  const program = gl.createProgram()
  if (!program) throw new Error('program alloc failed')
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vert))
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, frag))
  // Fixed attribute slots so the two programs never leave each other's
  // arrays enabled on the wrong buffer: 0 = position, 1 = lon/lat.
  attribs.forEach((name, slot) => gl.bindAttribLocation(program, slot, name))
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`link: ${gl.getProgramInfoLog(program)}`)
  }
  return program
}

/** Resolve any CSS colour (oklch included) to straight RGB in 0..1. The
 *  map's drag frames use it for the GL border colour (section 51). */
export function resolveCssColor(css: string): [number, number, number] {
  return parseColor(css)
}

const colorCache = new Map<string, [number, number, number]>()
let colorProbe: CanvasRenderingContext2D | null | undefined

function parseColor(css: string): [number, number, number] {
  const cached = colorCache.get(css)
  if (cached) return cached
  // Canvas resolves any CSS colour (oklch included) to rgb() for us. ONE
  // software probe for the page: a fresh GPU-backed canvas per call
  // stalled 30-60 ms on the readback (measured, section 51), which was
  // the first drag frame's whole budget.
  if (colorProbe === undefined) {
    const probe = document.createElement('canvas')
    probe.width = probe.height = 1
    colorProbe = probe.getContext('2d', { willReadFrequently: true })
  }
  const ctx = colorProbe
  if (!ctx) return [0.04, 0.15, 0.25]
  ctx.clearRect(0, 0, 1, 1)
  ctx.fillStyle = css
  ctx.fillRect(0, 0, 1, 1)
  const data = ctx.getImageData(0, 0, 1, 1).data
  const rgb: [number, number, number] = [
    (data[0] ?? 0) / 255,
    (data[1] ?? 0) / 255,
    (data[2] ?? 0) / 255,
  ]
  colorCache.set(css, rgb)
  return rgb
}

/** Decoded world-base bitmaps survive remounts (route away and back). */
const baseBitmapCache = new Map<string, Promise<ImageBitmap>>()
const metaCache = new Map<string, Promise<TerrainMeta>>()

function fetchBitmap(url: string, edge: number | null = null): Promise<ImageBitmap> {
  return fetch(url)
    .then((response) => {
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
      return response.blob()
    })
    .then((blob) =>
      createImageBitmap(
        blob,
        edge === null
          ? { premultiplyAlpha: 'none' }
          : {
              premultiplyAlpha: 'none',
              resizeWidth: edge,
              resizeHeight: edge,
              resizeQuality: 'high',
            },
      ),
    )
}

export class GlobeGL implements ImageryRenderer {
  private gl: WebGL2RenderingContext
  private progGlobe: WebGLProgram
  private progFlat: WebGLProgram
  private progLine: WebGLProgram
  private clipBuffer: WebGLBuffer
  private borderBuffer: WebGLBuffer | null = null
  private borderCount = 0
  private borderData: Float32Array | null = null
  private uniforms: Record<string, Map<string, WebGLUniformLocation | null>> = {}
  private anisotropy = 1
  private anisoExt: EXT_texture_filter_anisotropic | null = null
  private meshes = new Map<string, FlatMesh>()
  private lost = false
  private destroyed = false

  private basePath: string
  private metas = new Map<string, TerrainMeta>()
  /** Base textures by basePath; tile textures by `${basePath}/${name}`. */
  private bases = new Map<string, GpuTexture>()
  private tiles = new Map<string, GpuTexture>()
  private pending = new Set<string>()
  private lastView: ImageryView | null = null
  private oceanCache: { css: string; rgb: [number, number, number] } | null = null
  private drawQueued = false
  /** Client world raster (§51) and the source it came from, kept so a
   *  context restore can re-upload without asking the map. */
  private raster: GpuTexture | null = null
  private rasterSource: TexImageSource | null = null

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onReady: () => void,
    basePath = 'geo/terrain',
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('WebGL2 unavailable')
    this.gl = gl
    this.basePath = basePath
    const gpu = this.initGpu()
    this.progGlobe = gpu.progGlobe
    this.progFlat = gpu.progFlat
    this.progLine = gpu.progLine
    this.clipBuffer = gpu.clipBuffer

    canvas.addEventListener('webglcontextlost', this.handleLost)
    canvas.addEventListener('webglcontextrestored', this.handleRestored)
    this.ensureMeta(basePath)
  }

  /** Everything that lives in the GL context: programs, uniform
   *  locations, the full-screen triangle, filtering and blend state. Run
   *  at construction AND after a context restore, when all of it is gone
   *  (a restore that only relinked the programs left stale uniform
   *  locations and a dead clip buffer behind — review finding, round 3). */
  private initGpu(): {
    progGlobe: WebGLProgram
    progFlat: WebGLProgram
    progLine: WebGLProgram
    clipBuffer: WebGLBuffer
  } {
    const gl = this.gl
    const progGlobe = link(gl, VERT_GLOBE, FRAG, ['a_clip'])
    const progFlat = link(gl, VERT_FLAT, FRAG, ['a_view', 'a_lonlat'])
    const progLine = link(gl, VERT_LINE, FRAG_LINE, ['a_lonlat'])
    this.uniforms = {}
    for (const [name, program] of [
      ['globe', progGlobe],
      ['flat', progFlat],
      ['line', progLine],
    ] as const) {
      const map = new Map<string, WebGLUniformLocation | null>()
      for (const u of [
        'u_tex', 'u_globe', 'u_hasTex', 'u_isBase', 'u_ortho', 'u_height',
        'u_rot', 'u_window', 'u_ocean', 'u_affine', 'u_size', 'u_color',
        'u_grade', 'u_tint',
      ]) {
        map.set(u, gl.getUniformLocation(program, u))
      }
      this.uniforms[name] = map
    }
    const clipBuffer = gl.createBuffer()
    if (!clipBuffer) throw new Error('buffer alloc failed')
    gl.bindBuffer(gl.ARRAY_BUFFER, clipBuffer)
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 3, -1, -1, 3]),
      gl.STATIC_DRAW,
    )
    this.anisoExt =
      gl.getExtension('EXT_texture_filter_anisotropic') ??
      gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic')
    this.anisotropy = 1
    if (this.anisoExt) {
      // Anisotropic sampling matters at the limb, where one screen pixel
      // spans many texels along one axis; 8 taps is where it stops showing
      // on a desktop, and on a phone 2 is the most the fill rate can spare.
      this.anisotropy = Math.min(
        lowPowerDevice() ? 2 : 8,
        gl.getParameter(this.anisoExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number,
      )
    }
    gl.disable(gl.DEPTH_TEST)
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    return { progGlobe, progFlat, progLine, clipBuffer }
  }

  private handleLost = (event: Event) => {
    event.preventDefault()
    this.lost = true
  }

  private handleRestored = () => {
    // Everything GPU-side is gone; decoded bitmaps are still cached, so the
    // base returns quickly and tiles re-request on the next frame.
    this.lost = false
    this.bases.clear()
    this.tiles.clear()
    this.pending.clear()
    this.meshes.clear()
    this.raster = null
    try {
      const gpu = this.initGpu()
      this.progGlobe = gpu.progGlobe
      this.progFlat = gpu.progFlat
      this.progLine = gpu.progLine
      this.clipBuffer = gpu.clipBuffer
    } catch {
      return
    }
    this.borderBuffer = null
    if (this.borderData) this.setBorders(this.borderData)
    if (this.rasterSource) this.setRaster(this.rasterSource)
    this.ensureMeta(this.basePath)
    if (this.lastView) this.render(this.lastView)
  }

  setRaster(source: TexImageSource | null): boolean {
    this.rasterSource = source
    if (this.raster) {
      this.gl.deleteTexture(this.raster.texture)
      this.raster = null
    }
    if (source && !this.lost && !this.destroyed) {
      this.raster = this.upload(source, true)
    }
    return true
  }

  setImagery(basePath: string): void {
    if (basePath === this.basePath) return
    this.basePath = basePath
    this.ensureMeta(basePath)
    if (this.lastView) this.render(this.lastView)
  }

  prefetch(basePath: string): void {
    this.ensureMeta(basePath)
  }

  setBorders(segments: Float32Array): void {
    this.borderData = segments
    if (this.lost) return
    const gl = this.gl
    if (!this.borderBuffer) this.borderBuffer = gl.createBuffer()
    if (!this.borderBuffer) return
    gl.bindBuffer(gl.ARRAY_BUFFER, this.borderBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, segments, gl.STATIC_DRAW)
    this.borderCount = segments.length / 2
  }

  ready(): boolean {
    return this.bases.has(this.basePath)
  }

  attribution(): string | null {
    const meta = this.metas.get(this.basePath)
    return meta ? `${meta.attribution}, ${meta.vintage}` : null
  }

  destroy(): void {
    // In-flight fetches resolve later; they must not upload into a context
    // nobody will draw from (StrictMode's double mount would leak a full
    // base texture into the live context) nor call back an unmounted map.
    this.destroyed = true
    this.canvas.removeEventListener('webglcontextlost', this.handleLost)
    this.canvas.removeEventListener('webglcontextrestored', this.handleRestored)
    const gl = this.gl
    this.bases.forEach((t) => gl.deleteTexture(t.texture))
    this.tiles.forEach((t) => gl.deleteTexture(t.texture))
    if (this.raster) gl.deleteTexture(this.raster.texture)
    this.raster = null
    this.rasterSource = null
    if (this.borderBuffer) gl.deleteBuffer(this.borderBuffer)
    this.borderBuffer = null
    this.meshes.forEach((mesh) => {
      gl.deleteBuffer(mesh.positions)
      gl.deleteBuffer(mesh.lonlats)
      mesh.indexCache.forEach((entry) => gl.deleteBuffer(entry.buffer))
    })
    this.bases.clear()
    this.tiles.clear()
    this.meshes.clear()
    // Deliberately NOT losing the context: React StrictMode re-runs the
    // mount effect on the same canvas, and a forced-lost context cannot
    // compile shaders for the second instance.
  }

  // ---- loading ----------------------------------------------------------

  private ensureMeta(basePath: string): void {
    if (this.metas.has(basePath)) {
      this.ensureBase(basePath)
      return
    }
    let pending = metaCache.get(basePath)
    if (!pending) {
      pending = loadTerrainMeta(basePath)
      metaCache.set(basePath, pending)
    }
    void pending.then((meta) => {
      this.metas.set(basePath, meta)
      this.ensureBase(basePath)
    })
  }

  private ensureBase(basePath: string): void {
    if (this.bases.has(basePath) || this.pending.has(basePath)) return
    const meta = this.metas.get(basePath)
    const name = meta?.tiers[0]?.tiles[0] ?? 't0.jpg'
    this.pending.add(basePath)
    let bitmap = baseBitmapCache.get(basePath)
    if (!bitmap) {
      bitmap = fetchBitmap(terrainTileUrl(basePath, name))
      baseBitmapCache.set(basePath, bitmap)
    }
    void bitmap
      .then((image) => {
        this.pending.delete(basePath)
        if (this.lost || this.destroyed) return
        // REPEAT on S: the world map's first and last columns are
        // neighbours, and filtering across the antimeridian must blend
        // them, never clamp.
        this.bases.set(basePath, this.upload(image, true))
        this.repaint()
        this.onReady()
      })
      .catch(() => {
        this.pending.delete(basePath)
        baseBitmapCache.delete(basePath)
      })
  }

  private requestTile(basePath: string, name: string): void {
    const key = `${basePath}/${name}`
    if (this.tiles.has(key) || this.pending.has(key)) return
    this.pending.add(key)
    void fetchBitmap(terrainTileUrl(basePath, name), tileDecodeSize())
      .then((image) => {
        this.pending.delete(key)
        if (this.lost || this.destroyed) {
          image.close()
          return
        }
        this.tiles.set(key, this.upload(image, false))
        image.close()
        const budget = tileBudget()
        while (this.tiles.size > budget) {
          const oldest = this.tiles.keys().next().value as string
          const entry = this.tiles.get(oldest)
          if (entry) this.gl.deleteTexture(entry.texture)
          this.tiles.delete(oldest)
        }
        this.repaint()
      })
      .catch(() => {
        this.pending.delete(key)
      })
  }

  private upload(image: TexImageSource, wrapS: boolean): GpuTexture {
    const gl = this.gl
    const texture = gl.createTexture()
    if (!texture) throw new Error('texture alloc failed')
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, image)
    gl.generateMipmap(gl.TEXTURE_2D)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(
      gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS ? gl.REPEAT : gl.CLAMP_TO_EDGE,
    )
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    if (this.anisoExt) {
      gl.texParameterf(
        gl.TEXTURE_2D,
        this.anisoExt.TEXTURE_MAX_ANISOTROPY_EXT,
        this.anisotropy,
      )
    }
    const size =
      'width' in image && typeof image.width === 'number'
        ? { width: image.width, height: (image as { height: number }).height }
        : { width: 0, height: 0 }
    return { texture, ...size }
  }

  /** Tile arrivals repaint from the renderer's own last view, coalesced to
   *  one frame; React state is never consulted. */
  private repaint(): void {
    if (this.drawQueued || !this.lastView) return
    this.drawQueued = true
    requestAnimationFrame(() => {
      this.drawQueued = false
      if (this.lastView) this.render(this.lastView)
    })
  }

  // ---- geometry ---------------------------------------------------------

  private meshFor(view: ImageryView): FlatMesh {
    const existing = this.meshes.get(view.projectionKey)
    if (existing) return existing
    const gl = this.gl
    const cols = Math.round(360 / MESH_STEP_DEG) + 1
    const rows = Math.round(180 / MESH_STEP_DEG) + 1
    const positions = new Float32Array(cols * rows * 2)
    const lonlats = new Float32Array(cols * rows * 2)
    let i = 0
    for (let r = 0; r < rows; r += 1) {
      const lat = 90 - r * MESH_STEP_DEG
      for (let c = 0; c < cols; c += 1) {
        const lon = -180 + c * MESH_STEP_DEG
        // Nudge the antimeridian columns inward by a hair so the flat
        // projections do not fold them onto the wrong edge.
        const lonP = c === 0 ? lon + 1e-6 : c === cols - 1 ? lon - 1e-6 : lon
        const p = view.projection([lonP, lat]) ?? [0, 0]
        positions[i] = p[0]
        positions[i + 1] = p[1]
        lonlats[i] = (lon * Math.PI) / 180
        lonlats[i + 1] = (lat * Math.PI) / 180
        i += 2
      }
    }
    const posBuffer = gl.createBuffer()
    const llBuffer = gl.createBuffer()
    if (!posBuffer || !llBuffer) throw new Error('buffer alloc failed')
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW)
    gl.bindBuffer(gl.ARRAY_BUFFER, llBuffer)
    gl.bufferData(gl.ARRAY_BUFFER, lonlats, gl.STATIC_DRAW)
    const mesh: FlatMesh = {
      positions: posBuffer,
      lonlats: llBuffer,
      indexCache: new Map(),
    }
    this.meshes.set(view.projectionKey, mesh)
    return mesh
  }

  /** Triangle indices for the grid cells inside a lon/lat window. */
  private meshIndices(
    mesh: FlatMesh,
    lon0: number,
    lat0: number,
    lon1: number,
    lat1: number,
  ): { buffer: WebGLBuffer; count: number } {
    const key = `${lon0},${lat0},${lon1},${lat1}`
    const cached = mesh.indexCache.get(key)
    if (cached) return cached
    const cols = Math.round(360 / MESH_STEP_DEG) + 1
    const c0 = Math.round((lon0 + 180) / MESH_STEP_DEG)
    const c1 = Math.round((lon1 + 180) / MESH_STEP_DEG)
    const r0 = Math.round((90 - lat1) / MESH_STEP_DEG)
    const r1 = Math.round((90 - lat0) / MESH_STEP_DEG)
    const cells = (c1 - c0) * (r1 - r0)
    const indices = new Uint32Array(cells * 6)
    let i = 0
    for (let r = r0; r < r1; r += 1) {
      for (let c = c0; c < c1; c += 1) {
        const a = r * cols + c
        const b = a + 1
        const d = a + cols
        const e = d + 1
        indices[i++] = a
        indices[i++] = d
        indices[i++] = b
        indices[i++] = b
        indices[i++] = d
        indices[i++] = e
      }
    }
    const gl = this.gl
    const buffer = gl.createBuffer()
    if (!buffer) throw new Error('buffer alloc failed')
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer)
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW)
    const entry = { buffer, count: indices.length }
    mesh.indexCache.set(key, entry)
    return entry
  }

  // ---- rendering --------------------------------------------------------

  private tierFor(meta: TerrainMeta, pxPerDegree: number): TerrainTier | null {
    let chosen: TerrainTier | null = meta.tiers[0] ?? null
    for (const tier of meta.tiers) {
      chosen = tier
      if (tier.width / 360 >= pxPerDegree) break
    }
    return chosen
  }

  render(view: ImageryView): void {
    this.lastView = view
    if (this.lost) return
    const gl = this.gl
    const { layout, transform, cssWidth, cssHeight, isGlobe } = view
    const { scale, offsetX, offsetY, dpr } = layout
    const bufferW = Math.round(cssWidth * dpr)
    const bufferH = Math.round(cssHeight * dpr)
    if (this.canvas.width !== bufferW) this.canvas.width = bufferW
    if (this.canvas.height !== bufferH) this.canvas.height = bufferH
    gl.viewport(0, 0, bufferW, bufferH)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    if (!this.oceanCache || this.oceanCache.css !== view.oceanFill) {
      this.oceanCache = { css: view.oceanFill, rgb: parseColor(view.oceanFill) }
    }
    const ocean = this.oceanCache.rgb

    const meta = this.metas.get(this.basePath)
    const base = this.bases.get(this.basePath)

    // Screen pixels per degree of longitude at the equator, for tier choice.
    const eq0 = view.projection([0, 0])
    const eq1 = view.projection([1, 0])
    const viewPerDeg =
      eq0 && eq1 ? Math.hypot(eq1[0] - eq0[0], eq1[1] - eq0[1]) : 2.4
    const pxPerDeg = viewPerDeg * transform.k * scale * dpr
    const tier = meta ? this.tierFor(meta, pxPerDeg) : null

    // Device-space affine of the VIEW coordinate system.
    const ax = dpr * (offsetX + scale * transform.x)
    const ay = dpr * (offsetY + scale * transform.y)
    const b = dpr * scale * transform.k

    const program = isGlobe ? this.progGlobe : this.progFlat
    const u = this.uniforms[isGlobe ? 'globe' : 'flat']
    const loc = (name: string) => u?.get(name) ?? null
    gl.useProgram(program)
    gl.activeTexture(gl.TEXTURE0)
    gl.uniform1i(loc('u_tex'), 0)
    gl.uniform1i(loc('u_globe'), isGlobe ? 1 : 0)
    gl.uniform3f(loc('u_ocean'), ocean[0], ocean[1], ocean[2])
    gl.uniform1f(loc('u_height'), bufferH)

    const [lambda, phi] = view.rotation
    gl.uniform2f(loc('u_rot'), (lambda * Math.PI) / 180, (phi * Math.PI) / 180)

    let mesh: FlatMesh | null = null
    if (isGlobe) {
      const t = view.projection.translate()
      const s = view.projection.scale()
      gl.uniform3f(loc('u_ortho'), ax + b * t[0], b * s, ay + b * t[1])
      gl.bindBuffer(gl.ARRAY_BUFFER, this.clipBuffer)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
      gl.disableVertexAttribArray(1)
    } else {
      mesh = this.meshFor(view)
      gl.uniform4f(loc('u_affine'), ax, ay, b, b)
      gl.uniform2f(loc('u_size'), bufferW, bufferH)
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.positions)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
      gl.bindBuffer(gl.ARRAY_BUFFER, mesh.lonlats)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0)
    }

    const drawWindow = (lon0: number, lat0: number, lon1: number, lat1: number) => {
      const rad = Math.PI / 180
      gl.uniform4f(loc('u_window'), lon0 * rad, lat0 * rad, lon1 * rad, lat1 * rad)
      if (isGlobe) {
        // Section 51: a tile pass used to be a FULL-SCREEN triangle whose
        // fragments each ran the inverse projection and then discarded
        // themselves outside the tile's lon/lat window -- eight tiles on
        // screen meant eight full-screen passes of transcendentals, which
        // is what a phone GPU could not keep up with. Scissor each pass to
        // the tile's projected bounding box (the whole world needs none).
        const whole = lon1 - lon0 >= 360
        const box = whole
          ? null
          : this.tileScissor(view, lon0, lat0, lon1, lat1, ax, ay, b, bufferW, bufferH)
        if (box === undefined) return
        if (box) {
          gl.enable(gl.SCISSOR_TEST)
          gl.scissor(box[0], box[1], box[2], box[3])
        }
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        if (box) gl.disable(gl.SCISSOR_TEST)
      } else if (mesh) {
        const idx = this.meshIndices(mesh, lon0, lat0, lon1, lat1)
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx.buffer)
        gl.drawElements(gl.TRIANGLES, idx.count, gl.UNSIGNED_INT, 0)
      }
    }

    // Tone grade (section 51): imagery only -- the political raster
    // already carries its palette, so it draws ungraded.
    // A raster view with no raster resident (context just restored) draws
    // the ocean disc, never the other view's imagery.
    const useRaster = view.raster === true
    const grade = useRaster ? null : view.grade ?? null
    gl.uniform4f(
      loc('u_grade'),
      grade?.desaturate ?? 0,
      grade?.sepia ?? 0,
      grade?.lift ?? 0,
      grade?.tintAmount ?? 0,
    )
    const tint = grade?.tint ?? [1, 1, 1]
    gl.uniform3f(loc('u_tint'), tint[0], tint[1], tint[2])

    // Pass 1: the world base (or the ocean disc while it loads). With a
    // client raster requested and resident, the raster IS the world and
    // no imagery tile is drawn over it.
    gl.uniform1i(loc('u_isBase'), 1)
    const baseTexture = useRaster ? this.raster : base
    if (baseTexture) {
      gl.bindTexture(gl.TEXTURE_2D, baseTexture.texture)
      gl.uniform1i(loc('u_hasTex'), 1)
    } else {
      gl.uniform1i(loc('u_hasTex'), 0)
    }
    drawWindow(-180, -90, 180, 90)

    // Passes 2..n: finer tiles intersecting the visible window.
    if (!useRaster && meta && tier && base && tier.cols * tier.rows > 1) {
      this.drawTiles(view, tier, loc, drawWindow)
    }

    // Final pass: country outlines, from the same rotation uniform.
    if (view.borders && isGlobe && this.borderBuffer && this.borderCount > 0) {
      const lu = this.uniforms.line
      const lloc = (name: string) => lu?.get(name) ?? null
      gl.useProgram(this.progLine)
      const t = view.projection.translate()
      const sc = view.projection.scale()
      gl.uniform3f(lloc('u_ortho'), ax + b * t[0], b * sc, ay + b * t[1])
      gl.uniform2f(lloc('u_size'), bufferW, bufferH)
      gl.uniform2f(lloc('u_rot'), (lambda * Math.PI) / 180, (phi * Math.PI) / 180)
      const c = view.borders.color
      gl.uniform4f(lloc('u_color'), c[0], c[1], c[2], c[3])
      gl.bindBuffer(gl.ARRAY_BUFFER, this.borderBuffer)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
      gl.disableVertexAttribArray(1)
      gl.drawArrays(gl.LINES, 0, this.borderCount)
    }
  }

  /**
   * Device-pixel scissor box for a lon/lat window on the globe:
   * [x, y(bottom-up), w, h], clipped to the canvas. `undefined` means the
   * window is entirely off screen (skip the pass); `null` means no useful
   * bound (draw unscissored).
   *
   * The window's boundary is sampled and forward-projected; the
   * orthographic projection is injective on the visible hemisphere, so
   * the projected region's extent IS its boundary's extent. A boundary
   * sample past the horizon means the region reaches the limb, and the
   * disc's own bounding box is the bound then.
   */
  private tileScissor(
    view: ImageryView,
    lon0: number,
    lat0: number,
    lon1: number,
    lat1: number,
    ax: number,
    ay: number,
    b: number,
    bufferW: number,
    bufferH: number,
  ): [number, number, number, number] | null | undefined {
    const { projection, rotation } = view
    const center: [number, number] = [-rotation[0], -rotation[1]]
    const t = projection.translate()
    const r = projection.scale()
    const discX0 = ax + b * (t[0] - r)
    const discX1 = ax + b * (t[0] + r)
    const discY0 = ay + b * (t[1] - r)
    const discY1 = ay + b * (t[1] + r)
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    let limb = false
    const SAMPLES = 8
    const visit = (lon: number, lat: number) => {
      if (geoDistance([lon, lat], center) > Math.PI / 2) {
        limb = true
        return
      }
      const p = projection([lon, lat])
      if (!p || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) {
        limb = true
        return
      }
      const dx = ax + b * p[0]
      const dy = ay + b * p[1]
      if (dx < x0) x0 = dx
      if (dx > x1) x1 = dx
      if (dy < y0) y0 = dy
      if (dy > y1) y1 = dy
    }
    for (let i = 0; i <= SAMPLES; i += 1) {
      const f = i / SAMPLES
      visit(lon0 + (lon1 - lon0) * f, lat0)
      visit(lon0 + (lon1 - lon0) * f, lat1)
      visit(lon0, lat0 + (lat1 - lat0) * f)
      visit(lon1, lat0 + (lat1 - lat0) * f)
    }
    if (limb) {
      x0 = discX0
      x1 = discX1
      y0 = discY0
      y1 = discY1
    } else if (x0 === Infinity) {
      return null
    }
    // The disc bounds every visible fragment regardless of the samples.
    x0 = Math.max(x0, discX0)
    x1 = Math.min(x1, discX1)
    y0 = Math.max(y0, discY0)
    y1 = Math.min(y1, discY1)
    const pad = 2
    const sx0 = Math.max(0, Math.floor(x0 - pad))
    const sx1 = Math.min(bufferW, Math.ceil(x1 + pad))
    // Device y is top-down; gl.scissor counts from the bottom.
    const sy0 = Math.max(0, Math.floor(bufferH - (y1 + pad)))
    const sy1 = Math.min(bufferH, Math.ceil(bufferH - (y0 - pad)))
    if (sx1 <= sx0 || sy1 <= sy0) return undefined
    return [sx0, sy0, sx1 - sx0, sy1 - sy0]
  }

  private drawTiles(
    view: ImageryView,
    tier: TerrainTier,
    loc: (name: string) => WebGLUniformLocation | null,
    drawWindow: (lon0: number, lat0: number, lon1: number, lat1: number) => void,
  ): void {
    const gl = this.gl
    const { isGlobe } = view
    const window = this.visibleWindow(view)
    if (!window) return
    const degPerTileX = 360 / tier.cols
    const degPerTileY = 180 / tier.rows
    // Unwrapped column range (may exceed [0, cols)); each index wraps
    // modulo the column count so an antimeridian-straddling window draws
    // both edges of the map in one frame.
    const col0 = Math.floor((window.lonMin + 180) / degPerTileX)
    const col1 = Math.floor((window.lonMax + 180 - 1e-9) / degPerTileX)
    const row0 = Math.max(0, Math.floor((90 - window.latMax) / degPerTileY))
    const row1 = Math.min(tier.rows - 1, Math.floor((90 - window.latMin - 1e-9) / degPerTileY))
    gl.uniform1i(loc('u_isBase'), 0)
    // Nearest-the-centre first, and never more tiles than fit the budget:
    // wanting more than the LRU holds would evict and refetch every frame.
    const wantLon = (window.lonMin + window.lonMax) / 2
    const wantLat = isGlobe ? -view.rotation[1] : (window.latMin + window.latMax) / 2
    const wanted: { col: number; row: number; d: number }[] = []
    const seen = new Set<string>()
    for (let row = row0; row <= row1; row += 1) {
      for (let rawCol = col0; rawCol <= Math.min(col1, col0 + tier.cols - 1); rawCol += 1) {
        const col = ((rawCol % tier.cols) + tier.cols) % tier.cols
        const key = `${col},${row}`
        if (seen.has(key)) continue
        seen.add(key)
        const cLon = -180 + (col + 0.5) * degPerTileX
        const cLat = 90 - (row + 0.5) * degPerTileY
        let dLon = Math.abs(cLon - wantLon)
        if (dLon > 180) dLon = 360 - dLon
        wanted.push({ col, row, d: Math.hypot(dLon, cLat - wantLat) })
      }
    }
    wanted.sort((a, b) => a.d - b.d)
    const budget = tileBudget()
    for (const { col, row } of wanted.slice(0, budget)) {
      const name = `t${tier.level}-${col}-${row}.jpg`
      const key = `${this.basePath}/${name}`
      const tile = this.tiles.get(key)
      if (!tile) {
        this.requestTile(this.basePath, name)
        continue
      }
      // Refresh the LRU position.
      this.tiles.delete(key)
      this.tiles.set(key, tile)
      gl.bindTexture(gl.TEXTURE_2D, tile.texture)
      drawWindow(
        -180 + col * degPerTileX,
        90 - (row + 1) * degPerTileY,
        -180 + (col + 1) * degPerTileX,
        90 - row * degPerTileY,
      )
    }
  }

  /** Lon/lat bounds of the viewport, from inverting a sample grid; null
   *  when nothing on screen inverts (should not happen once fitted). On the
   *  globe the window is clamped to the visible hemisphere's bounds. */
  private visibleWindow(
    view: ImageryView,
  ): { lonMin: number; lonMax: number; latMin: number; latMax: number } | null {
    const { projection, transform, layout, cssWidth, cssHeight, isGlobe } = view
    if (!projection.invert) return null
    const { scale, offsetX, offsetY } = layout
    // The drag lambda is never wrapped by the map (only phi is clamped), so
    // after a full spin it can sit at -580 or +1000. Normalise the centre
    // to [-180, 180) before unwrapping samples around it, or the window
    // lands outside the tile grid and no fine tile is ever requested
    // (review finding, round 3).
    const rawCenterLon = isGlobe ? -view.rotation[0] : 0
    const centerLon = ((((rawCenterLon + 180) % 360) + 360) % 360) - 180
    const center: [number, number] = [centerLon, -view.rotation[1]]
    let lonMin = Infinity
    let lonMax = -Infinity
    let latMin = Infinity
    let latMax = -Infinity
    let count = 0
    let missed = 0
    for (let i = 0; i <= 8; i += 1) {
      for (let j = 0; j <= 6; j += 1) {
        const cssX = (cssWidth * i) / 8
        const cssY = (cssHeight * j) / 6
        const vx = ((cssX - offsetX) / scale - transform.x) / transform.k
        const vy = ((cssY - offsetY) / scale - transform.y) / transform.k
        const inverted = projection.invert([vx, vy])
        if (!inverted || !Number.isFinite(inverted[0])) {
          missed += 1
          continue
        }
        const [lon, lat] = inverted
        if (Math.abs(lon) > 180.01 || Math.abs(lat) > 90.01) {
          missed += 1
          continue
        }
        if (isGlobe && geoDistance([lon, lat], center) > Math.PI / 2) {
          missed += 1
          continue
        }
        let unwrapped = lon
        while (unwrapped - centerLon > 180) unwrapped -= 360
        while (unwrapped - centerLon < -180) unwrapped += 360
        lonMin = Math.min(lonMin, unwrapped)
        lonMax = Math.max(lonMax, unwrapped)
        latMin = Math.min(latMin, lat)
        latMax = Math.max(latMax, lat)
        count += 1
      }
    }
    // A miss means the viewport reaches past the map. On the globe the
    // visible hemisphere bounds the answer; on a flat map only the whole
    // world does (the base pass already covers it, so fine tiles then
    // come in nearest-the-centre first, capped at the budget).
    if (count === 0 || missed > 0) {
      if (!isGlobe) return { lonMin: -180, lonMax: 180, latMin: -90, latMax: 90 }
      return {
        lonMin: centerLon - 90,
        lonMax: centerLon + 90,
        latMin: Math.max(-90, center[1] - 90),
        latMax: Math.min(90, center[1] + 90),
      }
    }
    // Longitudes are returned UNWRAPPED (they may run past +-180, spanning
    // at most 360 degrees); drawTiles wraps column indices, so a window
    // straddling the antimeridian fetches both sides in the same frame.
    return {
      lonMin: Math.max(centerLon - 180, lonMin - 2),
      lonMax: Math.min(centerLon + 180, lonMax + 2),
      latMin: Math.max(-90, latMin - 2),
      latMax: Math.min(90, latMax + 2),
    }
  }
}

export function supportsWebGL2(): boolean {
  try {
    const probe = document.createElement('canvas')
    return probe.getContext('webgl2') !== null
  } catch {
    return false
  }
}
