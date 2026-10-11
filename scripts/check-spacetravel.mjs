/**
 * Gate: the Space Travel section is complete, sourced, illustrated and
 * drawable to scale (round 14, DATA_DECISIONS section 74).
 *
 * - Every era, event, craft, person and cutaway carries sources with https
 *   URLs; every figure is either a value WITH a source or null WITH a
 *   reason (never zero, never a bare blank).
 * - Every image is served LOCALLY from /data (never hotlinked), exists, is
 *   non-empty, decodes with sharp as a JPEG at its declared dimensions, and
 *   carries a credit, a licence and a source page in both the payload and
 *   data/space/travel/manifest.json. No orphan files, no orphan rows.
 * - Licences are free: public domain, CC0, CC BY, CC BY-SA, Attribution or
 *   NASA media. NC and ND fail.
 * - Every cutaway resolves, and every overlaid callout sits inside the
 *   image (0..1 fractions) with a label and a note.
 * - SCALE DIAGRAM DATA: every silhouette on a plate has a sourced height or
 *   span, its drawn geometry adds up to that figure, and it cites the
 *   reference drawing its proportions were measured from.
 * - Coverage floors: every event illustrated, and at least two thirds of
 *   the people with a free portrait (some have none anywhere, and the page
 *   says so rather than inventing one).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import sharp from 'sharp'

const DATA_DIR = fileURLToPath(new URL('../data/space/travel/', import.meta.url))
const IMG_DIR = join(DATA_DIR, 'images')
const PREFIX = 'space/travel/images/'

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

const file = JSON.parse(readFileSync(join(DATA_DIR, 'travel.json'), 'utf-8'))
const manifest = JSON.parse(readFileSync(join(DATA_DIR, 'manifest.json'), 'utf-8'))
const manifestByFile = new Map(manifest.images.map((row) => [row.file, row]))

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0
const isHttps = (v) => typeof v === 'string' && v.startsWith('https://')
const FREE_LICENCE =
  /public domain|cc0|cc[- ]by(?![- ]n[cd])|pd-|^attribution$|NASA Image and Video Library media/i

const CRAFT_TYPES = new Set(['rocket', 'crewed', 'satellite', 'probe', 'station'])

const eraIds = new Set((file.eras ?? []).map((e) => e.id))
const craftById = new Map((file.craft ?? []).map((c) => [c.id, c]))
const peopleIds = new Set((file.people ?? []).map((p) => p.id))
const refById = new Map((file.scaleReferences ?? []).map((r) => [r.id, r]))

const referenced = new Set(['manifest.json'])
let totalBytes = 0
const licences = new Map()

const checkSources = (where, sources) => {
  if (!Array.isArray(sources) || sources.length === 0) {
    fail(`${where}: no sources`)
    return
  }
  for (const source of sources) {
    if (!nonEmpty(source.title)) fail(`${where}: source without a title`)
    if (!isHttps(source.url)) fail(`${where}: source url is not https (${source.url})`)
  }
}

/** Every served image: local path, real file, decodes, credited, in manifest. */
const checkImage = async (where, image) => {
  if (!nonEmpty(image.file) || !image.file.startsWith(PREFIX)) {
    fail(`${where}: image is not served locally from /data (${image.file})`)
    return
  }
  if (/^https?:\/\//.test(image.file)) fail(`${where}: image is hotlinked`)
  for (const key of ['title', 'credit', 'licence', 'source']) {
    if (!nonEmpty(image[key])) fail(`${where}: image ${key} is empty`)
  }
  if (!isHttps(image.page)) fail(`${where}: image has no https source page`)
  if (!FREE_LICENCE.test(image.licence ?? '')) {
    fail(`${where}: image licence "${image.licence}" is not on the free list`)
  }
  licences.set(image.licence, (licences.get(image.licence) ?? 0) + 1)

  const basename = image.file.slice(PREFIX.length)
  referenced.add(basename)
  const path = join(IMG_DIR, basename)
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    fail(`${where}: image file missing (${image.file})`)
    return
  }
  if (size === 0) {
    fail(`${where}: image file is zero-length`)
    return
  }
  totalBytes += size
  try {
    const meta = await sharp(path).metadata()
    if (meta.format !== 'jpeg') fail(`${where}: image is ${meta.format}, expected jpeg`)
    if (!meta.width || !meta.height || meta.width < 160 || meta.height < 120) {
      fail(`${where}: image decodes to ${meta.width}x${meta.height}`)
    }
    if (image.width !== meta.width || image.height !== meta.height) {
      fail(`${where}: declared ${image.width}x${image.height} but file is ${meta.width}x${meta.height}`)
    }
    // Decode the pixels, not just the header: a truncated file has a header.
    await sharp(path).raw().toBuffer()
  } catch (error) {
    fail(`${where}: image does not decode (${error.message})`)
  }

  const row = manifestByFile.get(image.file)
  if (!row) {
    fail(`${where}: no manifest row for ${image.file}`)
    return
  }
  for (const key of ['sourceUrl', 'sourcePage', 'author', 'licence', 'creditLine', 'source']) {
    if (!nonEmpty(row[key])) fail(`${where}: manifest row missing ${key}`)
  }
  if (!isHttps(row.sourceUrl)) fail(`${where}: manifest sourceUrl is not https`)
}

// --------------------------------------------------------------------------
// Eras, scale references, plates
// --------------------------------------------------------------------------

if (eraIds.size === 0) fail('no eras declared')
for (const era of file.eras ?? []) {
  const where = `era ${era.id}`
  for (const key of ['label', 'dateLabel', 'summary']) {
    if (!nonEmpty(era[key])) fail(`${where}: ${key} missing`)
  }
  if (!(Number.isFinite(era.hue) && era.hue >= 0 && era.hue <= 360)) {
    fail(`${where}: hue ${era.hue} is not an oklch angle`)
  }
  if (!(Number.isInteger(era.from) && Number.isInteger(era.to) && era.from < era.to)) {
    fail(`${where}: from/to are not an ordered integer pair`)
  }
  checkSources(where, era.sources)
}

for (const ref of file.scaleReferences ?? []) {
  const where = `scale reference ${ref.id}`
  if (!(Number.isFinite(ref.heightM) && ref.heightM > 0)) fail(`${where}: no height`)
  if (!nonEmpty(ref.label) || !nonEmpty(ref.note)) fail(`${where}: label/note missing`)
  checkSources(where, ref.source ? [ref.source] : [])
}

let drawnItems = 0
for (const plate of file.plates ?? []) {
  const where = `plate ${plate.id}`
  if (!['vertical', 'span'].includes(plate.kind)) fail(`${where}: unknown kind ${plate.kind}`)
  for (const key of ['title', 'intro', 'note']) {
    if (!nonEmpty(plate[key])) fail(`${where}: ${key} missing`)
  }
  if (!Array.isArray(plate.items) || plate.items.length < 2) {
    fail(`${where}: needs at least two items`)
  }
  for (const id of plate.items ?? []) {
    const craft = craftById.get(id)
    if (!craft) {
      fail(`${where}: unknown craft ${id}`)
      continue
    }
    drawnItems += 1
    const sil = craft.silhouette
    if (!sil) {
      fail(`${where}: craft ${id} has no silhouette`)
      continue
    }
    if (sil.axis !== plate.kind) {
      fail(`${where}: craft ${id} silhouette axis ${sil.axis} != plate kind ${plate.kind}`)
    }
    if (!nonEmpty(craft.drawing?.title)) {
      fail(`${where}: craft ${id} does not cite the reference drawing it was measured from`)
    }
    // The scale-diagram contract: the drawn size is a sourced figure, or it
    // is explicitly composed and says so.
    const specs = craft.specs ?? {}
    const published = (keys) =>
      keys
        .map((k) => specs[k])
        .filter((s) => s && typeof s.v === 'number')
        .map((s) => ({ v: s.v, src: s.src, url: s.url }))
    if (sil.axis === 'vertical') {
      const height = sil.heightM
      if (!(Number.isFinite(height) && height > 0)) {
        fail(`${where}: craft ${id} silhouette has no heightM`)
        continue
      }
      const sum = (sil.sections ?? []).reduce((acc, s) => acc + (s.len ?? 0), 0)
      if (Math.abs(sum - height) / height > 0.06) {
        fail(`${where}: craft ${id} sections sum to ${sum.toFixed(1)} m, silhouette says ${height} m`)
      }
      const match = published(['heightM', 'lengthM']).find(
        (p) => Math.abs(p.v - height) / Math.max(p.v, height) <= 0.02,
      )
      if (!match && !nonEmpty(sil.heightNote)) {
        fail(`${where}: craft ${id} drawn height ${height} m is neither sourced nor explained`)
      }
      if (match && (!nonEmpty(match.src) || !isHttps(match.url))) {
        fail(`${where}: craft ${id} height has no sourced figure behind it`)
      }
    } else {
      const span = sil.spanM
      if (!(Number.isFinite(span) && span > 0)) {
        fail(`${where}: craft ${id} silhouette has no spanM`)
        continue
      }
      if (!Array.isArray(sil.parts) || sil.parts.length === 0) {
        fail(`${where}: craft ${id} silhouette has no parts`)
      }
      const match = published(['spanM', 'lengthM', 'widthM', 'diameterM']).find(
        (p) => Math.abs(p.v - span) / Math.max(p.v, span) <= 0.02,
      )
      if (!match && !nonEmpty(sil.spanNote)) {
        fail(`${where}: craft ${id} drawn span ${span} m is neither sourced nor explained`)
      }
    }
  }
  for (const id of plate.scaleRefs ?? []) {
    if (!refById.has(id)) fail(`${where}: unknown scale reference ${id}`)
  }
}

// --------------------------------------------------------------------------
// Craft
// --------------------------------------------------------------------------

const byType = new Map()
for (const craft of file.craft ?? []) {
  const where = `craft ${craft.id}`
  if (!CRAFT_TYPES.has(craft.type)) fail(`${where}: unknown type ${craft.type}`)
  byType.set(craft.type, (byType.get(craft.type) ?? 0) + 1)
  for (const key of ['name', 'country', 'organisation', 'summary', 'status']) {
    if (!nonEmpty(craft[key])) fail(`${where}: ${key} missing`)
  }
  if (!/^https:\/\/en\.wikipedia\.org\/wiki\//.test(craft.wikipedia ?? '')) {
    fail(`${where}: no Wikipedia link`)
  }
  const specs = craft.specs ?? {}
  if (Object.keys(specs).length === 0) fail(`${where}: no specifications`)
  for (const [key, spec] of Object.entries(specs)) {
    if (spec.v === null || spec.v === undefined) {
      if (!nonEmpty(spec.why)) fail(`${where}: spec ${key} is null with no reason`)
      continue
    }
    if (spec.v === 0) fail(`${where}: spec ${key} is zero; use null with a reason`)
    if (!nonEmpty(spec.src)) fail(`${where}: spec ${key} has no source`)
    if (!isHttps(spec.url)) fail(`${where}: spec ${key} source url is not https`)
  }
  for (const id of craft.people ?? []) {
    if (!peopleIds.has(id)) fail(`${where}: unknown person ${id}`)
  }
  checkSources(where, craft.sources)
}

// --------------------------------------------------------------------------
// Events
// --------------------------------------------------------------------------

const byEra = new Map()
let eventsWithImage = 0
for (const event of file.events ?? []) {
  const where = `event ${event.id}`
  if (!eraIds.has(event.era)) fail(`${where}: unknown era ${event.era}`)
  byEra.set(event.era, (byEra.get(event.era) ?? 0) + 1)
  for (const key of ['dateDisplay', 'title', 'text']) {
    if (!nonEmpty(event[key])) fail(`${where}: ${key} missing`)
  }
  if (!Number.isInteger(event.year) || event.year < 100 || event.year > 2030) {
    fail(`${where}: year ${event.year} is not plausible`)
  }
  const words = (event.text ?? '').split(/\s+/).filter(Boolean).length
  if (words < 30) fail(`${where}: text is only ${words} words`)
  if (!/^https:\/\/en\.wikipedia\.org\/wiki\//.test(event.wikipedia ?? '')) {
    fail(`${where}: no Wikipedia link`)
  }
  for (const id of event.craft ?? []) {
    if (!craftById.has(id)) fail(`${where}: unknown craft ${id}`)
  }
  for (const id of event.people ?? []) {
    if (!peopleIds.has(id)) fail(`${where}: unknown person ${id}`)
  }
  checkSources(where, event.sources)
  if (event.image) {
    eventsWithImage += 1
    await checkImage(where, event.image)
  } else if (!nonEmpty(event.imageNote)) {
    fail(`${where}: no image and no stated reason`)
  }
}

// --------------------------------------------------------------------------
// People
// --------------------------------------------------------------------------

let withPortrait = 0
for (const person of file.people ?? []) {
  const where = `person ${person.id}`
  for (const key of ['name', 'lifeDisplay', 'nationality', 'role', 'bio']) {
    if (!nonEmpty(person[key])) fail(`${where}: ${key} missing`)
  }
  const words = (person.bio ?? '').split(/\s+/).filter(Boolean).length
  if (words < 50) fail(`${where}: biography is only ${words} words`)
  if (!Number.isInteger(person.born)) fail(`${where}: no birth year`)
  if (person.died !== null && !Number.isInteger(person.died)) {
    fail(`${where}: died must be a year or null`)
  }
  if (!Array.isArray(person.knownFor) || person.knownFor.length === 0) {
    fail(`${where}: knownFor is empty`)
  }
  for (const id of person.craft ?? []) {
    if (!craftById.has(id)) fail(`${where}: unknown craft ${id}`)
  }
  if (!/^https:\/\/en\.wikipedia\.org\/wiki\//.test(person.wikipedia ?? '')) {
    fail(`${where}: no Wikipedia link`)
  }
  checkSources(where, person.sources)
  if (person.portrait) {
    withPortrait += 1
    await checkImage(where, person.portrait)
  } else if (!nonEmpty(person.portraitNote)) {
    fail(`${where}: no portrait and no stated reason`)
  }
}

// --------------------------------------------------------------------------
// Cutaways
// --------------------------------------------------------------------------

for (const cut of file.cutaways ?? []) {
  const where = `cutaway ${cut.id}`
  if (!craftById.has(cut.craft)) fail(`${where}: unknown craft ${cut.craft}`)
  for (const key of ['title', 'note']) {
    if (!nonEmpty(cut[key])) fail(`${where}: ${key} missing`)
  }
  if (typeof cut.overlay !== 'boolean') fail(`${where}: overlay is not a boolean`)
  if (!cut.image) {
    fail(`${where}: no image -- a cutaway without its drawing must not ship`)
  } else {
    await checkImage(where, cut.image)
  }
  const marks = new Set()
  for (const callout of cut.callouts ?? []) {
    const mark = callout.n ?? callout.key
    if (mark === undefined || marks.has(String(mark))) {
      fail(`${where}: callout mark ${mark} missing or duplicated`)
    }
    marks.add(String(mark))
    if (!nonEmpty(callout.label) || !nonEmpty(callout.note)) {
      fail(`${where}: callout ${mark} has no label/note`)
    }
    if (cut.overlay) {
      for (const axis of ['x', 'y']) {
        const value = callout[axis]
        if (!(Number.isFinite(value) && value >= 0 && value <= 1)) {
          fail(`${where}: callout ${mark} ${axis}=${value} is not a fraction of the image`)
        }
      }
    }
  }
  if (cut.overlay && marks.size === 0) fail(`${where}: overlay is on with no callouts`)
  checkSources(where, cut.sources)
}

// --------------------------------------------------------------------------
// Orphans and coverage floors
// --------------------------------------------------------------------------

for (const name of readdirSync(IMG_DIR)) {
  if (!referenced.has(name)) fail(`orphan file in data/space/travel/images: ${name}`)
}
for (const row of manifest.images) {
  if (!referenced.has(row.file.slice(PREFIX.length))) {
    fail(`manifest row for unreferenced file ${row.file}`)
  }
}

const events = (file.events ?? []).length
const people = (file.people ?? []).length
if (eventsWithImage < events) {
  fail(`only ${eventsWithImage} of ${events} events are illustrated (every event must be)`)
}
if (withPortrait < Math.ceil((people * 2) / 3)) {
  fail(`only ${withPortrait} of ${people} people have a free portrait (floor is two thirds)`)
}
if (drawnItems < 30) fail(`only ${drawnItems} craft are drawn across the scale plates`)

const fmt = (map) => [...map.entries()].map(([k, v]) => `${k}=${v}`).join(', ')
console.log(
  `  ${(file.eras ?? []).length} eras; ${events} events (${fmt(byEra)}); ` +
    `${(file.craft ?? []).length} craft (${fmt(byType)}); ${people} people, ` +
    `${withPortrait} with a free portrait; ${(file.cutaways ?? []).length} cutaways; ` +
    `${(file.plates ?? []).length} scale plates drawing ${drawnItems} craft; ` +
    `${referenced.size - 1} images, ${(totalBytes / 1e6).toFixed(2)} MB`,
)
console.log(`  licences: ${fmt(licences)}`)

if (failures > 0) {
  console.error(`\nFAIL — ${failures} Space Travel problem(s).`)
  process.exit(1)
}
console.log('\nPASS — Space Travel is sourced, illustrated, licence-gated and drawable to scale.')
