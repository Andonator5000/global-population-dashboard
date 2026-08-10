/**
 * One-off diagnostic: what land area does the 110m MAP draw for each entity?
 *
 * d3.geoArea returns spherical area in steradians on the unit sphere, so
 * multiplying by the Earth's radius squared gives km2 without needing a
 * projection at all. That makes it directly comparable to the projected 50m
 * figures the biome stage produces.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { geoArea } from 'd3-geo'
import { feature } from 'topojson-client'

const ROOT = resolve(import.meta.dirname, '..')
const EARTH_KM2_PER_STERADIAN = 6371.0088 ** 2

const topology = JSON.parse(
  readFileSync(resolve(ROOT, 'data/geo/countries-110m.json'), 'utf-8'),
)
const collection = feature(topology, topology.objects.countries)

const entities = JSON.parse(
  readFileSync(resolve(ROOT, 'data/entities.json'), 'utf-8'),
)
const published = new Map(entities.map((e) => [e.iso3, e.area_km2]))

const biomes = JSON.parse(
  readFileSync(resolve(ROOT, 'data/biomes/biomes.json'), 'utf-8'),
)

const areas = new Map()
for (const f of collection.features) {
  const iso3 = f.properties.iso3
  areas.set(
    iso3,
    (areas.get(iso3) ?? 0) + geoArea(f) * EARTH_KM2_PER_STERADIAN,
  )
}

const watch = process.argv.slice(2)
const codes = watch.length ? watch : ['MAR', 'ESH', 'CYP', 'SOM', 'SDN', 'SSD']

console.log(
  `${'iso'.padEnd(5)}${'110m map'.padStart(13)}${'50m biome'.padStart(13)}` +
    `${'published'.padStart(13)}${'map vs pub'.padStart(12)}`,
)
for (const iso3 of codes) {
  const map110 = areas.get(iso3)
  const biome50 = biomes.entities[iso3]?.landAreaKm2
  const pub = published.get(iso3)
  const err = map110 && pub ? ((map110 - pub) / pub) * 100 : null
  console.log(
    `${iso3.padEnd(5)}` +
      `${map110 ? Math.round(map110).toLocaleString().padStart(13) : '—'.padStart(13)}` +
      `${biome50 ? Math.round(biome50).toLocaleString().padStart(13) : '—'.padStart(13)}` +
      `${pub ? Math.round(pub).toLocaleString().padStart(13) : '—'.padStart(13)}` +
      `${err === null ? '—'.padStart(12) : `${err > 0 ? '+' : ''}${err.toFixed(1)}%`.padStart(12)}`,
  )
}
