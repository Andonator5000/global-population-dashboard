/**
 * Independent validation of the equal-area reprojection.
 *
 * The biome stage measures each country's land area from its own polygon after
 * reprojecting to EPSG:6933. That number is computed entirely inside our
 * pipeline, and it can be checked against an area published by a completely
 * separate source (mledoze/countries, which carries CIA/UN figures).
 *
 * If the reprojection were wrong -- or if anyone "fixed" it back to degrees --
 * these two numbers would diverge wildly and systematically with latitude.
 * Agreement across 200+ countries at every latitude is strong evidence the
 * area arithmetic is sound.
 *
 * Perfect agreement is NOT expected: the published figures use different
 * coastline definitions, and many include or exclude inland water differently.
 * The gate is therefore on the MEDIAN error and on the absence of a latitude
 * trend, not on any single country.
 *
 * Run: npm run check:biome-areas
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

const biomes = JSON.parse(
  readFileSync(resolve(ROOT, 'data/biomes/biomes.json'), 'utf-8'),
)
const entities = JSON.parse(
  readFileSync(resolve(ROOT, 'data/entities.json'), 'utf-8'),
)

const published = new Map(
  entities
    .filter((e) => typeof e.area_km2 === 'number' && e.area_km2 > 0)
    .map((e) => [e.iso3, { area: e.area_km2, lat: e.latlng?.[0] ?? null }]),
)

const rows = []
for (const [iso3, record] of Object.entries(biomes.entities)) {
  const ref = published.get(iso3)
  if (!ref) continue
  // Below ~1000 km² the two sources' coastline definitions dominate entirely.
  if (ref.area < 1000) continue
  const ours = record.landAreaKm2
  rows.push({
    iso3,
    name: record.name,
    ours,
    published: ref.area,
    error: (ours - ref.area) / ref.area,
    lat: ref.lat,
  })
}

rows.sort((a, b) => Math.abs(a.error) - Math.abs(b.error))
const median = rows[Math.floor(rows.length / 2)]
const within5 = rows.filter((r) => Math.abs(r.error) <= 0.05).length
const within15 = rows.filter((r) => Math.abs(r.error) <= 0.15).length

console.log(
  `Comparing our EPSG:6933 polygon areas against published figures for ` +
    `${rows.length} countries over 1,000 km².\n`,
)
console.log(`  median absolute error : ${(Math.abs(median.error) * 100).toFixed(2)}%`)
console.log(
  `  within  5%            : ${within5} (${((within5 / rows.length) * 100).toFixed(0)}%)`,
)
console.log(
  `  within 15%            : ${within15} (${((within15 / rows.length) * 100).toFixed(0)}%)`,
)

// A latitude trend is the specific signature of a projection error: an
// unprojected (degree-based) area collapses toward the poles.
const bands = [
  ['equatorial  |lat| < 23', (r) => Math.abs(r.lat) < 23],
  ['temperate  23-50', (r) => Math.abs(r.lat) >= 23 && Math.abs(r.lat) < 50],
  ['high lat.    >= 50', (r) => Math.abs(r.lat) >= 50],
]
console.log('\n  mean signed error by latitude band (a trend here means a bad CRS):')
let maxBandError = 0
for (const [label, test] of bands) {
  const band = rows.filter((r) => r.lat !== null && test(r))
  if (band.length === 0) continue
  const mean = band.reduce((s, r) => s + r.error, 0) / band.length
  maxBandError = Math.max(maxBandError, Math.abs(mean))
  console.log(
    `    ${label.padEnd(22)} n=${String(band.length).padStart(3)}  ` +
      `mean ${(mean * 100).toFixed(2).padStart(7)}%`,
  )
}

console.log('\n  largest disagreements (coastline and inland-water definitions):')
for (const r of rows.slice(-6).reverse()) {
  console.log(
    `    ${r.iso3}  ${r.name.slice(0, 24).padEnd(25)} ` +
      `ours ${Math.round(r.ours).toLocaleString().padStart(11)} km²  ` +
      `published ${Math.round(r.published).toLocaleString().padStart(11)} km²  ` +
      `${(r.error * 100).toFixed(1).padStart(7)}%`,
  )
}

const MEDIAN_LIMIT = 0.05
const BAND_LIMIT = 0.2
const failures = []
if (Math.abs(median.error) > MEDIAN_LIMIT) {
  failures.push(
    `median error ${(median.error * 100).toFixed(2)}% exceeds ${MEDIAN_LIMIT * 100}%`,
  )
}
if (maxBandError > BAND_LIMIT) {
  failures.push(
    `a latitude band is off by ${(maxBandError * 100).toFixed(1)}%, which ` +
      `suggests the area CRS is not equal-area`,
  )
}

console.log(
  failures.length === 0
    ? '\nPASS — polygon areas agree with published figures and show no latitude trend.'
    : `\nFAIL — ${failures.join('; ')}`,
)
process.exit(failures.length === 0 ? 0 : 1)
