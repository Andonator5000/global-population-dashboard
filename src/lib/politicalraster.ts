/**
 * The political map as a picture (round 4, DATA_DECISIONS.md §51).
 *
 * The political globe's drag frames used to re-stroke ~250 country paths
 * through d3's canvas renderer every frame: clip to the hemisphere,
 * resample every edge, fill, stroke. Nine milliseconds on a desktop and
 * three to six times that on a phone, which is the "sluggish globe on
 * mobile" Andy kept seeing after every other fix. The satellite globe
 * did not have the problem because its pixels come from ONE texture
 * sampled by the GPU.
 *
 * So the political fills become a texture too. Whenever the palette,
 * the fill mode or the theme changes, the country fills are painted ONCE
 * into an equirectangular canvas (ocean underneath, no strokes -- the
 * GL border pass draws those as crisp lines from the same rotation), and
 * that canvas is uploaded to the imagery renderer as a world raster. A
 * drag frame is then the same single inverse-projection pass the
 * satellite view runs, at the same cost, whatever the device.
 *
 * Resolution: 4096x2048 on a desktop (0.088 degrees per texel, ~10 km at
 * the equator), 2048x1024 on low-power devices. That is coarser than the
 * SVG at deep zoom, which is fine -- the raster only ever stands in while
 * the globe is MOVING, and the vector map returns the moment it stops.
 */

import { geoEquirectangular, geoPath, type GeoPermissibleObjects } from 'd3-geo'

import { lowPowerDevice } from './device'

export function politicalRasterSize(): [number, number] {
  return lowPowerDevice() ? [2048, 1024] : [4096, 2048]
}

export interface PoliticalRasterSpec {
  /** CSS colour of the ocean (already resolved: no custom properties). */
  ocean: string
  /** One resolved fill per feature, in feature order; 'transparent' or
   *  '' leaves the ocean showing. */
  fills: string[]
}

/** Stable identity of a spec, so a raster is rebuilt only when its
 *  colours change (theme switches, palette switches, fill mode). */
export function politicalRasterSignature(spec: PoliticalRasterSpec): string {
  return `${spec.ocean}|${spec.fills.join(',')}`
}

/**
 * Paint the fills into a fresh canvas. Synchronous and CPU-bound: ~30 ms
 * on a desktop at 4096x2048, so callers build it during idle time and
 * only fall back to building at drag start when the colours changed.
 */
export function buildPoliticalRaster(
  features: unknown[],
  spec: PoliticalRasterSpec,
  size: [number, number] = politicalRasterSize(),
): HTMLCanvasElement {
  const [width, height] = size
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) return canvas
  // Plate carree: lon -180..180 across the width, lat 90..-90 down the
  // height -- exactly the layout the imagery tiles use, so the shader
  // samples it with the whole-world window and no special case.
  // Default adaptive resampling stays ON: d3 draws each border edge as a
  // great circle in the SVG and the GL border pass subdivides along the
  // same great circles, so the fill edge must curve the same way -- a
  // straight lon/lat edge would leave a sliver of the wrong fill beside
  // long high-latitude borders (the 49th parallel bows ~0.5 degrees).
  const projection = geoEquirectangular()
    .scale(width / (2 * Math.PI))
    .translate([width / 2, height / 2])
  const path = geoPath(projection, ctx)
  ctx.fillStyle = spec.ocean
  ctx.fillRect(0, 0, width, height)
  features.forEach((feature, index) => {
    const fill = spec.fills[index]
    if (!fill || fill === 'transparent') return
    ctx.beginPath()
    path(feature as GeoPermissibleObjects)
    ctx.fillStyle = fill
    ctx.fill()
  })
  return canvas
}
