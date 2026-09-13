/**
 * Gate: the periodic table is complete, honestly null, illustrated or
 * flagged, and fully defined (round 3 §47).
 *
 * - All 118 elements, Z 1..118 each exactly once, with a table position.
 * - Every element carries EVERY property key the panel renders — the list
 *   is read from src/data/chemistry-properties.json, the same file
 *   ElementPanel.tsx renders from — as {value, unit, source, vintage}; a
 *   null value carries a reason; every source id resolves in `sources`.
 * - Every element has an image (with licence, author-or-null, Commons
 *   page, local file present on disk) OR an explicit noSample flag with a
 *   reason. A noSample element may still carry a facility/related image,
 *   labelled as such — never kind 'sample'.
 * - Image licences are within the gate (PD / CC0 / CC BY / CC BY-SA / FAL).
 * - The glossary defines every property key, each with a definition and
 *   an http(s) source URL.
 * - The view keys in the properties file are real properties.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DATA_DIR = join(ROOT, 'data', 'chemistry')

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

const properties = JSON.parse(
  readFileSync(join(ROOT, 'src', 'data', 'chemistry-properties.json'), 'utf-8'),
)
const PROPERTY_KEYS = properties.sections.flatMap((s) => s.keys)
for (const key of PROPERTY_KEYS) {
  if (!properties.properties[key]) fail(`properties file: section key ${key} has no metadata`)
}
for (const key of properties.views.keys) {
  if (!properties.properties[key]) fail(`properties file: view key ${key} is not a property`)
}

const file = JSON.parse(readFileSync(join(DATA_DIR, 'elements.json'), 'utf-8'))
const glossary = JSON.parse(readFileSync(join(DATA_DIR, 'glossary.json'), 'utf-8'))
const elements = file.elements
const sources = file.sources ?? {}

if (elements.length !== 118) fail(`expected 118 elements, found ${elements.length}`)
const seen = new Set()
const positions = new Set()
const FREE = /public domain|cc0|cc[- ]by(?![- ]n[cd])|pd-|\bFAL\b|free art licen[cs]e/i

let withImage = 0
let noSample = 0
let facility = 0
let nulls = 0
const nullByKey = {}

for (const element of elements) {
  const id = `${element.z} ${element.symbol}`
  if (seen.has(element.z)) fail(`${id}: duplicate atomic number`)
  seen.add(element.z)
  if (!(element.z >= 1 && element.z <= 118)) fail(`${id}: atomic number out of range`)
  if (!element.name || !element.symbol) fail(`${id}: missing name or symbol`)
  if (!file.categories?.[element.category]) fail(`${id}: unknown category ${element.category}`)
  if (!(element.xpos >= 1 && element.xpos <= 18 && element.ypos >= 1 && element.ypos <= 10)) {
    fail(`${id}: bad table position ${element.xpos},${element.ypos}`)
  }
  const pos = `${element.xpos},${element.ypos}`
  if (positions.has(pos)) fail(`${id}: position ${pos} already taken`)
  positions.add(pos)

  for (const key of PROPERTY_KEYS) {
    const figure = element.properties?.[key]
    if (!figure || typeof figure !== 'object') {
      fail(`${id}: property ${key} missing`)
      continue
    }
    for (const field of ['value', 'unit', 'source', 'vintage']) {
      if (!(field in figure)) fail(`${id}: ${key} lacks ${field}`)
    }
    if (!sources[figure.source]) fail(`${id}: ${key} cites unknown source ${figure.source}`)
    if (figure.value === null) {
      nulls += 1
      nullByKey[key] = (nullByKey[key] ?? 0) + 1
      if (!figure.reason) fail(`${id}: ${key} is null without a reason`)
    } else if (figure.value === '' || figure.value === 0 && key !== 'group') {
      // Zero is a legitimate value only where the source says so; the
      // periodic table has no property that is honestly zero.
      if (figure.value === 0) fail(`${id}: ${key} is 0 — absence must be null with a reason`)
      else fail(`${id}: ${key} is an empty string`)
    }
  }

  if (element.noSample) {
    noSample += 1
    if (!element.noSampleReason) fail(`${id}: noSample without a reason`)
    if (element.image && element.image.kind === 'sample') {
      fail(`${id}: flagged noSample but carries a 'sample' image`)
    }
  }
  if (element.image) {
    withImage += 1
    const image = element.image
    if (!image.license || !FREE.test(image.license)) fail(`${id}: image licence ${image.license} outside the gate`)
    if (!image.commonsPage) fail(`${id}: image without a Commons page`)
    if (!('author' in image)) fail(`${id}: image without an author field`)
    if (!['sample', 'facility', 'related'].includes(image.kind)) fail(`${id}: image kind ${image.kind}`)
    if (image.kind === 'facility') facility += 1
    if (!existsSync(join(DATA_DIR, image.file))) fail(`${id}: image file ${image.file} not on disk`)
  } else if (!element.noSample) {
    fail(`${id}: no image and no noSample flag`)
  }
}
for (let z = 1; z <= 118; z += 1) if (!seen.has(z)) fail(`element ${z} missing`)

const glossaryKeys = new Set(glossary.entries.map((e) => e.key))
for (const key of PROPERTY_KEYS) {
  if (!glossaryKeys.has(key)) fail(`glossary: no entry for property ${key}`)
}
for (const entry of glossary.entries) {
  if (!entry.term || !entry.definition || entry.definition.length < 60) {
    fail(`glossary ${entry.key}: term/definition missing or too short`)
  }
  if (!/^https?:\/\//.test(entry.source?.url ?? '')) fail(`glossary ${entry.key}: no source URL`)
  if (!entry.source?.title) fail(`glossary ${entry.key}: no source title`)
}

console.log(
  `  ${elements.length} elements · ${withImage} with an image (${facility} facility) · ` +
    `${noSample} flagged no-sample · ${nulls} null figures across ` +
    `${Object.keys(nullByKey).length} properties · ${glossary.entries.length} glossary entries`,
)
const worst = Object.entries(nullByKey).sort((a, b) => b[1] - a[1]).slice(0, 6)
if (worst.length) console.log(`  most-null: ${worst.map(([k, n]) => `${k}=${n}`).join(', ')}`)

if (failures > 0) {
  console.error(`\nFAIL — ${failures} chemistry problem(s).`)
  process.exit(1)
}
console.log('\nPASS — every element is complete, sourced, illustrated-or-flagged, and defined.')
