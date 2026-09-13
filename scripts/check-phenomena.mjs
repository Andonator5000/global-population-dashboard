/**
 * Gate: the Cosmic Phenomena catalogue is complete, sourced and illustrated
 * (round-3 phase 6, DATA_DECISIONS §46).
 *
 * - Every entry has a known category, a status flag, a description, at
 *   least three facts each carrying value + source + URL + year, and NASA
 *   and Wikipedia links.
 * - Every entry has an image, served LOCALLY from /data (never hotlinked),
 *   whose file exists, is non-empty, decodes with sharp as a JPEG with real
 *   dimensions, and carries non-empty credit and licence fields.
 * - data/space/phenomena/manifest.json has a provenance row for every file
 *   (source URL, author, licence, credit line) and no orphan files exist.
 * - Non-observed entries say so in their own text.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const DATA_DIR = fileURLToPath(new URL('../data/space/', import.meta.url))
const IMG_DIR = join(DATA_DIR, 'phenomena')

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

const file = JSON.parse(readFileSync(join(DATA_DIR, 'phenomena.json'), 'utf-8'))
const manifest = JSON.parse(readFileSync(join(IMG_DIR, 'manifest.json'), 'utf-8'))

const categories = new Map((file.categories ?? []).map((c) => [c.id, c.label]))
const statuses = new Set((file.statuses ?? []).map((s) => s.id))
const manifestByFile = new Map(manifest.images.map((m) => [m.file, m]))

if (categories.size === 0) fail('no categories declared')
if (!['observed', 'theoretical', 'hypothesis'].every((s) => statuses.has(s))) {
  fail('statuses must declare observed, theoretical and hypothesis')
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0
const NON_OBSERVED_WORDING =
  /hypothe|theor|never been observed|not been confirmed|none has been confirmed|unconfirmed|inferred/i

const byCategory = new Map()
const byStatus = new Map()
const bySource = new Map()
let totalBytes = 0
const referenced = new Set(['manifest.json'])

for (const entry of file.entries) {
  const id = entry.id
  if (!categories.has(entry.category)) fail(`${id}: unknown category ${entry.category}`)
  if (!statuses.has(entry.status)) fail(`${id}: unknown status ${entry.status}`)
  if (!nonEmpty(entry.description) || entry.description.split(/\s+/).length < 55) {
    fail(`${id}: description missing or under 55 words`)
  }
  if (entry.status !== 'observed' && !NON_OBSERVED_WORDING.test(`${entry.title} ${entry.description}`)) {
    fail(`${id}: is ${entry.status} but its text does not say so`)
  }
  if (!Array.isArray(entry.facts) || entry.facts.length < 3) {
    fail(`${id}: fewer than 3 facts`)
  } else {
    for (const fact of entry.facts) {
      if (!nonEmpty(fact.value) || !nonEmpty(fact.source)) fail(`${id}: fact without value/source`)
      if (!/^https:\/\//.test(fact.url ?? '')) fail(`${id}: fact without an https URL`)
      if (!Number.isInteger(fact.year) || fact.year < 1600 || fact.year > 2100) {
        fail(`${id}: fact year ${fact.year} is not a plausible year`)
      }
    }
  }
  if (!/^https:\/\/en\.wikipedia\.org\/wiki\//.test(entry.wikipedia ?? '')) fail(`${id}: no Wikipedia link`)
  if (!/^https:\/\//.test(entry.nasa ?? '')) fail(`${id}: no NASA/ESA link`)

  byCategory.set(entry.category, (byCategory.get(entry.category) ?? 0) + 1)
  byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + 1)

  const image = entry.image
  if (!image) {
    fail(`${id}: no image`)
    continue
  }
  if (!nonEmpty(image.file) || !image.file.startsWith('space/phenomena/')) {
    fail(`${id}: image is not served locally from /data/space/phenomena (${image.file})`)
    continue
  }
  if (/^https?:\/\//.test(image.file)) fail(`${id}: image is hotlinked`)
  if (!nonEmpty(image.credit)) fail(`${id}: image credit is empty`)
  if (!nonEmpty(image.licence)) fail(`${id}: image licence is empty`)
  if (!nonEmpty(image.title)) fail(`${id}: image title is empty`)
  if (!/^https:\/\//.test(image.page ?? '')) fail(`${id}: image has no source page`)

  const basename = image.file.slice('space/phenomena/'.length)
  referenced.add(basename)
  const path = join(IMG_DIR, basename)
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    fail(`${id}: image file missing (${image.file})`)
    continue
  }
  if (size === 0) {
    fail(`${id}: image file is zero-length`)
    continue
  }
  totalBytes += size
  try {
    const meta = await sharp(path).metadata()
    if (!meta.width || !meta.height || meta.width < 200 || meta.height < 120) {
      fail(`${id}: image decodes to ${meta.width}x${meta.height}`)
    }
    if (meta.format !== 'jpeg') fail(`${id}: image is ${meta.format}, expected jpeg`)
    if (image.width !== meta.width || image.height !== meta.height) {
      fail(`${id}: declared ${image.width}x${image.height} but file is ${meta.width}x${meta.height}`)
    }
    // Decode the pixels, not just the header: a truncated file has a header.
    await sharp(path).raw().toBuffer()
  } catch (error) {
    fail(`${id}: image does not decode (${error.message})`)
  }

  const row = manifestByFile.get(image.file)
  if (!row) {
    fail(`${id}: no manifest row for ${image.file}`)
  } else {
    for (const key of ['sourceUrl', 'sourcePage', 'author', 'licence', 'creditLine', 'source']) {
      if (!nonEmpty(row[key])) fail(`${id}: manifest row missing ${key}`)
    }
    if (!/^https:\/\//.test(row.sourceUrl ?? '')) fail(`${id}: manifest sourceUrl is not https`)
    bySource.set(row.source, (bySource.get(row.source) ?? 0) + 1)
  }
}

for (const name of readdirSync(IMG_DIR)) {
  if (!referenced.has(name)) fail(`orphan file in data/space/phenomena: ${name}`)
}
for (const row of manifest.images) {
  if (!referenced.has(row.file.slice('space/phenomena/'.length))) {
    fail(`manifest row for unreferenced file ${row.file}`)
  }
}

const fmt = (map) =>
  [...map.entries()].map(([k, v]) => `${k}=${v}`).join(', ')
console.log(
  `  ${file.entries.length} entries; by status: ${fmt(byStatus)}; ` +
    `by category: ${fmt(byCategory)}; images by source: ${fmt(bySource)}; ` +
    `${(totalBytes / 1e6).toFixed(2)} MB of images`,
)
if (failures > 0) {
  console.error(`\nFAIL — ${failures} phenomena problem(s).`)
  process.exit(1)
}
console.log('\nPASS — every phenomenon is categorised, sourced and locally illustrated.')
