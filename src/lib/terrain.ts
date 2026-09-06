/**
 * Terrain rendering for the satellite view (Phase 4, DATA_DECISIONS.md §30).
 *
 * The Blue Marble equirectangular tiles are warped onto the current
 * projection by FORWARD MESH WARPING, not per-pixel inverse sampling: the
 * visible sphere is divided into small lon/lat quads, each quad's corners
 * are projected, and the matching source rectangle is drawn through an
 * affine transform. A few hundred GPU-accelerated drawImage calls per frame
 * replace millions of projection.invert calls, which is what keeps the
 * globe spinning at frame rate on a mid-range laptop.
 *
 * Quads are aligned to the 45-degree tile grid (mesh steps are 45/2^n), so
 * a quad never straddles a tile boundary and each draw reads exactly one
 * source bitmap. When the wanted tier's tile has not arrived yet, the quad
 * falls back to the coarsest tier (fetched first, world-sized), so zooming
 * shows soft imagery that sharpens as tiles land -- never holes.
 */

import { geoDistance, type GeoProjection } from 'd3-geo'

import {
  loadTerrainMeta,
  terrainTileUrl,
  type TerrainMeta,
  type TerrainTier,
} from './mapdetail'

/** Decoded-bitmap budget. Tier-2 tiles decode to ~29 MB RGBA each; eight
 *  in flight is ~230 MB worst case, which a mid-range laptop absorbs, and
 *  eviction is LRU so panning at high zoom recycles the oldest view. */
const TILE_CACHE_MAX = 8

interface ZoomTransform {
  x: number
  y: number
  k: number
}

interface Layout {
  /** viewBox-to-element scale (preserveAspectRatio meet). */
  scale: number
  offsetX: number
  offsetY: number
  dpr: number
}

export class TerrainRenderer {
  private meta: TerrainMeta | null = null
  private metaRequested = false
  /** LRU of decoded tiles; separate always-resident slot for tier 0. */
  private tiles = new Map<string, ImageBitmap>()
  private pending = new Set<string>()
  private base: ImageBitmap | null = null

  constructor(private readonly onTileReady: () => void) {}

  destroy(): void {
    this.tiles.forEach((bitmap) => bitmap.close())
    this.tiles.clear()
    this.base?.close()
    this.base = null
  }

  private ensureMeta(): void {
    if (this.metaRequested) return
    this.metaRequested = true
    void loadTerrainMeta().then((meta) => {
      this.meta = meta
      const tier0 = meta.tiers[0]
      if (tier0) this.request(tier0.tiles[0] ?? 't0.jpg', true)
    })
  }

  attribution(): string | null {
    return this.meta
      ? `${this.meta.attribution}, ${this.meta.vintage}`
      : null
  }

  private request(name: string, isBase = false): void {
    const key = name
    if (this.pending.has(key) || this.tiles.has(key)) return
    if (isBase && this.base) return
    this.pending.add(key)
    void fetch(terrainTileUrl(name))
      .then((response) => {
        if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`)
        return response.blob()
      })
      .then((blob) => createImageBitmap(blob))
      .then((bitmap) => {
        this.pending.delete(key)
        if (isBase) {
          this.base = bitmap
        } else {
          this.tiles.set(key, bitmap)
          while (this.tiles.size > TILE_CACHE_MAX) {
            const oldest = this.tiles.keys().next().value as string
            this.tiles.get(oldest)?.close()
            this.tiles.delete(oldest)
          }
        }
        this.onTileReady()
      })
      .catch(() => {
        this.pending.delete(key)
      })
  }

  /** Pick the finest tier whose resolution the screen can actually use. */
  private tierFor(pxPerDegree: number): TerrainTier | null {
    if (!this.meta) return null
    let chosen = this.meta.tiers[0] ?? null
    for (const tier of this.meta.tiers) {
      chosen = tier
      if (tier.width / 360 >= pxPerDegree) break
    }
    return chosen
  }

  /**
   * Source bitmap and rectangle for a lon/lat quad, preferring `tier` but
   * falling back to the resident world bitmap so there is always pixels.
   */
  private source(
    tier: TerrainTier | null,
    lon0: number,
    lat0: number,
    lon1: number,
    lat1: number,
  ): { bitmap: ImageBitmap; sx: number; sy: number; sw: number; sh: number } | null {
    if (tier && tier.cols * tier.rows > 1) {
      const degPerTileX = 360 / tier.cols
      const degPerTileY = 180 / tier.rows
      const col = Math.floor((lon0 + 180) / degPerTileX)
      const row = Math.floor((90 - lat1) / degPerTileY)
      const name = `t${tier.level}-${col}-${row}.jpg`
      const bitmap = this.tiles.get(name)
      if (bitmap) {
        // Refresh LRU position.
        this.tiles.delete(name)
        this.tiles.set(name, bitmap)
        const px = tier.width / 360
        const py = tier.height / 180
        return {
          bitmap,
          sx: (lon0 + 180) * px - col * tier.tile_px,
          sy: (90 - lat1) * py - row * tier.tile_px,
          sw: (lon1 - lon0) * px,
          sh: (lat1 - lat0) * py,
        }
      }
      this.request(name)
    }
    if (!this.base) return null
    const px = this.base.width / 360
    const py = this.base.height / 180
    return {
      bitmap: this.base,
      sx: (lon0 + 180) * px,
      sy: (90 - lat1) * py,
      sw: (lon1 - lon0) * px,
      sh: (lat1 - lat0) * py,
    }
  }

  /**
   * Draw the terrain for the current view. `spherePath` is the projected
   * sphere outline (view coordinates); it is filled with the ocean colour
   * first so horizon-clipped quads never leave holes of background black.
   */
  render(
    ctx: CanvasRenderingContext2D,
    projection: GeoProjection,
    rotation: [number, number],
    transform: ZoomTransform,
    layout: Layout,
    cssWidth: number,
    cssHeight: number,
    spherePathD: string,
    oceanFill: string,
    isGlobe: boolean,
  ): void {
    this.ensureMeta()
    const { scale, offsetX, offsetY, dpr } = layout

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, cssWidth * dpr, cssHeight * dpr)

    // Ocean underlay in view coordinates.
    const viewScale = dpr * scale
    ctx.setTransform(
      viewScale * transform.k, 0, 0, viewScale * transform.k,
      dpr * (offsetX + scale * transform.x),
      dpr * (offsetY + scale * transform.y),
    )
    ctx.fillStyle = oceanFill
    try {
      ctx.fill(new Path2D(spherePathD))
    } catch {
      // A malformed path string should never kill the frame.
    }

    if (!this.meta && !this.base) return

    // Screen pixels per degree of longitude at the equator, used both for
    // tier choice and mesh sizing.
    const eq0 = projection([0, 0])
    const eq1 = projection([1, 0])
    const viewPerDeg =
      eq0 && eq1 ? Math.hypot(eq1[0] - eq0[0], eq1[1] - eq0[1]) : 2.4
    const pxPerDeg = viewPerDeg * transform.k * scale * dpr
    const tier = this.tierFor(pxPerDeg)

    // Mesh step: 45/2^n degrees, sized so quads land in the 40-80 screen px
    // range -- small enough that the affine approximation of the projection
    // is invisible, large enough that a frame stays in the low hundreds of
    // drawImage calls.
    let step = 45
    while (step * pxPerDeg > 80 && step > 45 / 1024) step /= 2

    const project = (lon: number, lat: number): [number, number] | null => {
      const point = projection([lon, lat])
      if (!point || !Number.isFinite(point[0])) return null
      return [
        dpr * (offsetX + scale * (transform.x + transform.k * point[0])),
        dpr * (offsetY + scale * (transform.y + transform.k * point[1])),
      ]
    }

    const center: [number, number] = [-rotation[0], -rotation[1]]
    const visible = (lon: number, lat: number) =>
      !isGlobe || geoDistance([lon, lat], center) < Math.PI / 2 - 1e-4

    // Visible lon/lat window, from inverting a viewport sample grid. When
    // most samples miss the globe (world zoom) the whole sphere is meshed
    // and per-quad culling does the work.
    let lonMin = -180
    let lonMax = 180
    let latMin = -90
    let latMax = 90
    if (projection.invert) {
      const lons: number[] = []
      const lats: number[] = []
      const centerLon = isGlobe ? -rotation[0] : 0
      for (let i = 0; i <= 6; i += 1) {
        for (let j = 0; j <= 4; j += 1) {
          const cssX = (cssWidth * i) / 6
          const cssY = (cssHeight * j) / 4
          const vx = ((cssX - offsetX) / scale - transform.x) / transform.k
          const vy = ((cssY - offsetY) / scale - transform.y) / transform.k
          const inverted = projection.invert([vx, vy])
          if (!inverted || !Number.isFinite(inverted[0])) continue
          const [lon, lat] = inverted
          if (Math.abs(lon) > 180.01 || Math.abs(lat) > 90.01) continue
          // Unwrap around the view centre so a window crossing the
          // antimeridian stays contiguous.
          let unwrapped = lon
          while (unwrapped - centerLon > 180) unwrapped -= 360
          while (unwrapped - centerLon < -180) unwrapped += 360
          lons.push(unwrapped)
          lats.push(lat)
        }
      }
      if (lons.length >= 30) {
        lonMin = Math.max(centerLon - 180, Math.min(...lons) - step)
        lonMax = Math.min(centerLon + 180, Math.max(...lons) + step)
        latMin = Math.max(-90, Math.min(...lats) - step)
        latMax = Math.min(90, Math.max(...lats) + step)
      }
    }

    const startLon = Math.floor(lonMin / step) * step
    const startLat = Math.floor(latMin / step) * step
    const dprW = cssWidth * dpr
    const dprH = cssHeight * dpr
    const pad = 64 * dpr

    ctx.imageSmoothingEnabled = true
    for (let lat = startLat; lat < latMax; lat += step) {
      const lat1 = Math.min(lat + step, 90)
      if (lat1 <= lat) continue
      for (let lon = startLon; lon < lonMax; lon += step) {
        // Normalise into [-180, 180) for projection and tile lookup; the
        // 45/2^n step keeps grid alignment across the wrap.
        let lon0 = lon
        while (lon0 >= 180) lon0 -= 360
        while (lon0 < -180) lon0 += 360
        const lon1 = lon0 + step

        if (
          !visible(lon0, lat) || !visible(lon1, lat) ||
          !visible(lon0, lat1) || !visible(lon1, lat1)
        ) continue

        const p00 = project(lon0, lat1) // top-left (north-west)
        const p10 = project(lon1, lat1)
        const p01 = project(lon0, lat)
        if (!p00 || !p10 || !p01) continue
        if (
          Math.max(p00[0], p10[0], p01[0]) < -pad ||
          Math.min(p00[0], p10[0], p01[0]) > dprW + pad ||
          Math.max(p00[1], p10[1], p01[1]) < -pad ||
          Math.min(p00[1], p10[1], p01[1]) > dprH + pad
        ) continue

        const src = this.source(tier, lon0, lat, lon1, lat1)
        if (!src || src.sw <= 0 || src.sh <= 0) continue

        // Affine from the source rectangle to the projected quad, using
        // three corners.
        //
        // SEAMS (the round-2 "graticule" bug): adjacent quads' affines
        // disagree by sub-pixel amounts along shared edges (the affine is
        // only an approximation of the curved projection), so hairline
        // gaps opened between quads and the dark ocean showed through as
        // a faint lon/lat grid. The fix is to OVERDRAW: each quad is
        // scaled up ~1.5% about its own origin-corner axes (and the
        // source rect padded to match), so neighbours overlap by roughly
        // a pixel and there is never a gap for the background to leak
        // into. Imagery overlapping imagery is invisible.
        const overdraw = 1.015
        const a = ((p10[0] - p00[0]) / src.sw) * overdraw
        const b = ((p10[1] - p00[1]) / src.sw) * overdraw
        const c = ((p01[0] - p00[0]) / src.sh) * overdraw
        const d = ((p01[1] - p00[1]) / src.sh) * overdraw
        ctx.setTransform(a, b, c, d, p00[0], p00[1])
        ctx.drawImage(
          src.bitmap,
          src.sx - 1, src.sy - 1, src.sw + 2, src.sh + 2,
          -1, -1, src.sw + 2, src.sh + 2,
        )
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0)
  }
}
