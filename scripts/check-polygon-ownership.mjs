/**
 * Guard: no LARGE territory is drawn inside another country's polygon.
 *
 * Natural Earth models some dependencies as part of their parent state's
 * geometry. That is cartographically defensible but wrong for a dashboard
 * keyed on ISO 3166-1: French Guiana was rendering as an 85,000 km2 piece of
 * France, and clicking anywhere in it returned France's data.
 *
 * Small entities inside a neighbour are FINE and expected -- Vatican City,
 * Monaco, Singapore and Hong Kong are all below 110m resolution, so those
 * pixels genuinely are the surrounding country and the marker is the way in.
 *
 * The gate is therefore on size: an entity with no polygon of its own must not
 * have a published land area comparable to the part containing it.
 *
 * Run: npm run check:polygons
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { geoArea, geoContains } from 'd3-geo'
import { feature } from 'topojson-client'

const ROOT = resolve(import.meta.dirname, '..')
const EARTH_KM2 = 6371.0088 ** 2

const topology = JSON.parse(
  readFileSync(resolve(ROOT, 'data/geo/countries-110m.json'), 'utf-8'),
)
const entities = JSON.parse(
  readFileSync(resolve(ROOT, 'data/entities.json'), 'utf-8'),
)
const collection = feature(topology, topology.objects.countries)

const withPolygon = new Set(collection.features.map((f) => f.properties.iso3))

// Anything sizeable that has coordinates but no polygon of its own.
const MIN_AREA_KM2 = 5000
const suspects = entities.filter(
  (e) =>
    !withPolygon.has(e.iso3) &&
    Array.isArray(e.latlng) &&
    typeof e.area_km2 === 'number' &&
    e.area_km2 >= MIN_AREA_KM2,
)

console.log(
  `${collection.features.length} polygons · ` +
    `${suspects.length} entities over ${MIN_AREA_KM2.toLocaleString()} km² without one`,
)

const failures = []
for (const entity of suspects) {
  const [lat, lon] = entity.latlng
  for (const f of collection.features) {
    if (!geoContains(f, [lon, lat])) continue
    const parts =
      f.geometry.type === 'MultiPolygon'
        ? f.geometry.coordinates
        : [f.geometry.coordinates]
    for (const coordinates of parts) {
      const part = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates } }
      if (!geoContains(part, [lon, lat])) continue
      const km2 = geoArea(part) * EARTH_KM2
      const ratio = km2 / entity.area_km2
      if (ratio >= 0.7 && ratio <= 1.4) {
        failures.push(
          `${entity.iso3} (${entity.name_common}) is drawn as part of ` +
            `${f.properties.iso3}: that part measures ${Math.round(km2).toLocaleString()} km² ` +
            `against a published ${Math.round(entity.area_km2).toLocaleString()} km², ` +
            `so the part IS the territory and should be its own polygon.`,
        )
      }
    }
  }
}

if (failures.length === 0) {
  console.log(
    '\nPASS — no sizeable territory is rendered as part of another country.',
  )
  process.exit(0)
}
console.log(`\nFAIL — ${failures.length} problem(s):`)
for (const f of failures) console.log(`  ${f}`)
process.exit(1)
