/**
 * Equal-area gate.
 *
 * "Greenland reads visibly smaller than Africa" is an acceptance criterion, and
 * it is the one a Mercator slip would silently break. So it is measured, not
 * eyeballed: d3-geo's path.area() returns the PROJECTED planar area in square
 * pixels, which is exactly the quantity a reader perceives.
 *
 * The test is not merely "Greenland < Africa" -- that is true even on Mercator
 * at world zoom. It checks that the projected ratio matches the true
 * surface-area ratio within a tolerance, which only an equal-area projection
 * can satisfy. On Web Mercator the same assertion fails by roughly an order of
 * magnitude.
 *
 * Run with `npm run check:equal-area`. Exits non-zero on failure.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { geoEqualEarth, geoPath } from 'd3-geo'
import { geoEckert4, geoMollweide } from 'd3-geo-projection'
import { feature } from 'topojson-client'

const ROOT = resolve(import.meta.dirname, '..')
const TOPOLOGY_PATH = resolve(ROOT, 'data/geo/countries-110m.json')

// Reference surface areas, km². Source: CIA World Factbook / UN Statistics
// Division. Used only to derive the EXPECTED ratio, never displayed.
const GREENLAND_KM2 = 2_166_086
const AFRICA_KM2 = 30_370_000
const EXPECTED_RATIO = AFRICA_KM2 / GREENLAND_KM2 // ~14.0

// Equal-area projections are exact in principle; the slack absorbs 110m
// generalisation, which trims small coastal detail unevenly.
const TOLERANCE = 0.15

const PROJECTIONS = {
  'Equal Earth': geoEqualEarth,
  Mollweide: geoMollweide,
  'Eckert IV': geoEckert4,
}

const topology = JSON.parse(readFileSync(TOPOLOGY_PATH, 'utf-8'))
const countries = feature(topology, topology.objects.countries)

const greenland = countries.features.filter((f) => f.properties.iso3 === 'GRL')
const african = countries.features.filter((f) => f.properties.continent === 'AF')

if (greenland.length === 0) {
  console.error('FAIL: no Greenland geometry found in the topology.')
  process.exit(1)
}
if (african.length < 40) {
  console.error(`FAIL: only ${african.length} African geometries found.`)
  process.exit(1)
}

let failures = 0
console.log(
  `Expected Africa:Greenland surface-area ratio ${EXPECTED_RATIO.toFixed(2)}:1 ` +
    `(±${(TOLERANCE * 100).toFixed(0)}%)\n`,
)

for (const [name, factory] of Object.entries(PROJECTIONS)) {
  const projection = factory().fitExtent(
    [
      [0, 0],
      [1000, 480],
    ],
    { type: 'Sphere' },
  )
  const path = geoPath(projection)

  const sum = (features) =>
    features.reduce((total, f) => total + Math.abs(path.area(f)), 0)

  const greenlandArea = sum(greenland)
  const africaArea = sum(african)
  const ratio = africaArea / greenlandArea
  const error = Math.abs(ratio - EXPECTED_RATIO) / EXPECTED_RATIO
  const ok = greenlandArea < africaArea && error <= TOLERANCE
  if (!ok) failures += 1

  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(12)} ` +
      `Greenland ${greenlandArea.toFixed(0).padStart(6)} px²  ` +
      `Africa ${africaArea.toFixed(0).padStart(7)} px²  ` +
      `ratio ${ratio.toFixed(2)}:1  (off by ${(error * 100).toFixed(1)}%)`,
  )
}

console.log(
  failures === 0
    ? '\nAll projections are equal-area: Greenland renders at true relative size.'
    : `\n${failures} projection(s) FAILED the equal-area check.`,
)
process.exit(failures === 0 ? 0 : 1)
