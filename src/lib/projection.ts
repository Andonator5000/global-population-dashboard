import { geoEqualEarth, geoOrthographic, type GeoProjection } from 'd3-geo'
import { geoEckert4, geoMollweide } from 'd3-geo-projection'

import type { ProjectionKey } from '../config'

/**
 * Map projections.
 *
 * Every FLAT option here is EQUAL-AREA. That is not a style preference: an
 * acceptance criterion requires Greenland to read visibly smaller than Africa,
 * and Mercator inflates high-latitude landmasses by more than an order of
 * magnitude. Adding a conformal flat projection to this record would break
 * the dashboard's central claim.
 *
 * 'globe' is the one non-flat member: an orthographic perspective view that
 * foreshortens toward the horizon the way a physical globe does. It never
 * invites the Mercator misreading (nothing is systematically inflated by
 * latitude), and it is opt-in -- see the note in src/config.ts.
 */
const FACTORIES: Record<ProjectionKey, () => GeoProjection> = {
  equalEarth: geoEqualEarth,
  mollweide: geoMollweide,
  eckert4: geoEckert4,
  globe: geoOrthographic,
}

export const PROJECTION_LABELS: Record<ProjectionKey, string> = {
  equalEarth: 'Equal Earth',
  mollweide: 'Mollweide',
  eckert4: 'Eckert IV',
  globe: 'Globe (3-D)',
}

export function createProjection(key: ProjectionKey): GeoProjection {
  const factory = FACTORIES[key] ?? FACTORIES.equalEarth
  return factory()
}

/**
 * Fit a projection to a viewport with a small inset.
 *
 * Uses the sphere rather than the country FeatureCollection so the framing
 * does not shift when the rendered entity set changes -- otherwise toggling a
 * layer would subtly rescale the whole map.
 */
export function fitProjection(
  projection: GeoProjection,
  width: number,
  height: number,
  inset = 4,
): GeoProjection {
  return projection.fitExtent(
    [
      [inset, inset],
      [Math.max(inset + 1, width - inset), Math.max(inset + 1, height - inset)],
    ],
    { type: 'Sphere' },
  )
}
