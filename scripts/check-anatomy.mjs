// Human Anatomy gate (round 6, DATA_DECISIONS.md §55; round 12 §62 for the 3-D models).
//
// Proves the shipped artifact is complete and honest: every system has a
// description, functions, organs and a source URL; every organ has a
// location, description, function and source and is listed by its primary
// system; every layer and figure has a local image that exists, is a
// renderable type, is credited (author + free licence + Commons page), and
// every system is reachable from a layer or a figure. Fails the build
// otherwise — the page never ships an uncredited diagram or an unsourced
// entry.
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = new URL('../data/anatomy/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const file = JSON.parse(readFileSync(join(DATA_DIR, 'anatomy.json'), 'utf-8'))
const FREE = /public domain|cc0|cc[- ]by(?![- ]n[cd])|pd-|^attribution$/i

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

const systems = new Map(file.systems.map((s) => [s.id, s]))
const organs = new Map(file.organs.map((o) => [o.id, o]))
if (systems.size !== file.systems.length) fail('duplicate system id')
if (organs.size !== file.organs.length) fail('duplicate organ id')

for (const system of file.systems) {
  if (!system.name || !system.summary) fail(`system ${system.id}: name/summary missing`)
  const words = (system.description ?? []).join(' ').split(/\s+/).length
  if (words < 200) fail(`system ${system.id}: description only ${words} words`)
  if (!(system.functions?.length >= 3)) fail(`system ${system.id}: fewer than 3 functions`)
  if (!(system.organs?.length >= 1)) fail(`system ${system.id}: no organs`)
  if (!(system.worksWith?.length >= 2)) fail(`system ${system.id}: fewer than 2 worksWith links`)
  if (!/^https:\/\//.test(system.source?.url ?? '')) fail(`system ${system.id}: no source URL`)
  for (const id of system.organs) if (!organs.has(id)) fail(`system ${system.id}: unknown organ ${id}`)
  for (const link of system.worksWith) {
    if (!systems.has(link.system) || link.system === system.id) fail(`system ${system.id}: bad worksWith ${link.system}`)
  }
}
for (const organ of file.organs) {
  if (!organ.name || !organ.location || !organ.function) fail(`organ ${organ.id}: name/location/function missing`)
  const words = (organ.description ?? []).join(' ').split(/\s+/).length
  if (words < 40) fail(`organ ${organ.id}: description only ${words} words`)
  if (!/^https:\/\//.test(organ.source?.url ?? '')) fail(`organ ${organ.id}: no source URL`)
  const primary = organ.systems?.[0]
  if (!systems.has(primary)) fail(`organ ${organ.id}: unknown primary system`)
  else if (!systems.get(primary).organs.includes(organ.id)) fail(`organ ${organ.id}: not listed by ${primary}`)
}
const covered = new Set()
let imageBytes = 0
for (const item of [...file.layers, ...file.figures]) {
  covered.add(item.system)
  if (!systems.has(item.system)) fail(`image ${item.id}: unknown system`)
  if (!item.caption) fail(`image ${item.id}: no caption`)
  const image = item.image ?? {}
  const path = join(DATA_DIR, '..', image.file ?? '')
  if (!image.file || !existsSync(path)) fail(`image ${item.id}: file missing (${image.file})`)
  else {
    const size = statSync(path).size
    imageBytes += size
    if (size < 2000) fail(`image ${item.id}: file suspiciously small (${size} bytes)`)
    if (!/\.(svg|png|jpg)$/.test(image.file)) fail(`image ${item.id}: not svg/png/jpg`)
  }
  if (!image.author) fail(`image ${item.id}: no author`)
  if (!FREE.test(image.licence ?? '')) fail(`image ${item.id}: licence ${image.licence} is not free`)
  if (!/^https:\/\/commons\.wikimedia\.org\//.test(image.sourcePage ?? '')) fail(`image ${item.id}: no Commons page`)
}
for (const id of systems.keys()) if (!covered.has(id)) fail(`system ${id}: no layer or figure`)
if (!(file.layers.length >= 8)) fail(`only ${file.layers.length} layers`)
for (const note of file.cooperation) {
  if (!note.title || (note.text ?? '').split(/\s+/).length < 60) fail(`cooperation ${note.title}: too short`)
  for (const id of note.systems) if (!systems.has(id)) fail(`cooperation ${note.title}: unknown system ${id}`)
}

console.log(
  `  ${file.systems.length} systems · ${file.organs.length} organs · ${file.layers.length} layers + ${file.figures.length} figures · ${file.cooperation.length} cooperation notes · ${(imageBytes / 1e6).toFixed(2)} MB of diagrams`,
)

// ---- 3-D models (round 12, §62) -------------------------------------------
// Every layer file the manifest lists exists, is a GLB with the expected
// extensions, and its bytes and sha256 match; the licence is on the
// allow-list and attribution fields are present; per-layer and per-sex byte
// budgets hold; the six layer ids the page uses exist for BOTH sexes; every
// structure file names its layer and every organ alias in the reference
// resolves to at least one node in at least one model (so no entry claims a
// 3-D structure it does not have), and every organ id a structure names is
// a real entry.
const MODEL_DIR = join(DATA_DIR, 'models')
const PAGE_LAYERS = ['skeleton', 'nervous', 'organs', 'vessels', 'muscles', 'skin']
const MODEL_LICENCES = new Set(['CC BY-SA 4.0', 'CC BY 4.0', 'CC0 1.0', 'Public domain'])
let modelBytes = 0
let structureCount = 0
const manifestPath = join(MODEL_DIR, 'manifest.json')
if (!existsSync(manifestPath)) fail('models: manifest.json missing')
else {
  const models = JSON.parse(readFileSync(manifestPath, 'utf-8'))
  const layerBudget = models.budgets?.layerBytes ?? 6_000_000
  const sexBudget = models.budgets?.sexBytes ?? 28_000_000
  const resolved = new Set()
  for (const sex of ['male', 'female']) {
    const record = models.sexes?.[sex]
    if (!record) {
      fail(`models: no ${sex} model`)
      continue
    }
    const source = record.source ?? {}
    for (const field of ['title', 'author', 'licence', 'licenceUrl', 'sourcePage']) {
      if (!source[field]) fail(`models ${sex}: source.${field} missing`)
    }
    if (!MODEL_LICENCES.has(source.licence)) fail(`models ${sex}: licence ${source.licence} not on the allow-list`)
    if (!/^https:\/\//.test(source.sourcePage ?? '')) fail(`models ${sex}: sourcePage is not a URL`)
    for (const f of source.files ?? []) {
      if (!/^https:\/\//.test(f.url ?? '') || !/^[0-9a-f]{64}$/.test(f.sha256 ?? '')) fail(`models ${sex}: source file ${f.file} lacks url/sha256`)
    }
    if (sex === 'male' && !existsSync(join(DATA_DIR, '..', source.notice ?? 'missing'))) fail('models male: NOTICE file missing (share-alike attribution chain)')
    let total = 0
    const ids = new Set()
    for (const layer of record.layers ?? []) {
      ids.add(layer.id)
      const path = join(DATA_DIR, '..', layer.file ?? '')
      if (!layer.file || !existsSync(path)) {
        fail(`models ${sex}/${layer.id}: file missing (${layer.file})`)
        continue
      }
      const bytes = readFileSync(path)
      total += bytes.length
      if (bytes.length !== layer.bytes) fail(`models ${sex}/${layer.id}: ${bytes.length} bytes on disk, manifest says ${layer.bytes}`)
      if (createHash('sha256').update(bytes).digest('hex') !== layer.sha256) fail(`models ${sex}/${layer.id}: sha256 mismatch`)
      if (bytes.length > layerBudget) fail(`models ${sex}/${layer.id}: ${(bytes.length / 1e6).toFixed(2)} MB over the layer budget`)
      if (bytes.toString('latin1', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2) fail(`models ${sex}/${layer.id}: not a glTF 2 binary`)
      else {
        const jsonLength = bytes.readUInt32LE(12)
        const json = JSON.parse(bytes.toString('utf-8', 20, 20 + jsonLength))
        const used = json.extensionsUsed ?? []
        if (!used.includes('EXT_meshopt_compression')) fail(`models ${sex}/${layer.id}: not meshopt-compressed`)
        if ((json.nodes ?? []).length !== layer.structures) fail(`models ${sex}/${layer.id}: ${json.nodes?.length} nodes, manifest says ${layer.structures}`)
        if ((json.buffers ?? []).some((b) => b.uri)) fail(`models ${sex}/${layer.id}: external buffer (must be self-contained)`)
      }
      if (!['full', 'partial'].includes(layer.coverage) || !layer.note) fail(`models ${sex}/${layer.id}: coverage/note missing`)
      // Supplement files (round 12: the fitted female stomach and
      // oesophagus) pass the same checks and carry their own licence.
      for (const extra of layer.supplements ?? []) {
        const extraPath = join(DATA_DIR, '..', extra.file ?? '')
        if (!extra.file || !existsSync(extraPath)) {
          fail(`models ${sex}/${layer.id}/${extra.id}: file missing (${extra.file})`)
          continue
        }
        const eb = readFileSync(extraPath)
        total += eb.length
        if (eb.length !== extra.bytes) fail(`models ${sex}/${layer.id}/${extra.id}: ${eb.length} bytes on disk, manifest says ${extra.bytes}`)
        if (createHash('sha256').update(eb).digest('hex') !== extra.sha256) fail(`models ${sex}/${layer.id}/${extra.id}: sha256 mismatch`)
        if (eb.length > layerBudget) fail(`models ${sex}/${layer.id}/${extra.id}: over the layer budget`)
        if (!MODEL_LICENCES.has(extra.licence)) fail(`models ${sex}/${layer.id}/${extra.id}: licence ${extra.licence} not on the allow-list`)
        if (!extra.note) fail(`models ${sex}/${layer.id}/${extra.id}: note missing`)
        if (eb.toString('latin1', 0, 4) !== 'glTF' || eb.readUInt32LE(4) !== 2) fail(`models ${sex}/${layer.id}/${extra.id}: not a glTF 2 binary`)
        else {
          const jsonLength = eb.readUInt32LE(12)
          const json = JSON.parse(eb.toString('utf-8', 20, 20 + jsonLength))
          if (!(json.extensionsUsed ?? []).includes('EXT_meshopt_compression')) fail(`models ${sex}/${layer.id}/${extra.id}: not meshopt-compressed`)
          if ((json.nodes ?? []).length !== extra.structures) fail(`models ${sex}/${layer.id}/${extra.id}: ${json.nodes?.length} nodes, manifest says ${extra.structures}`)
        }
      }
    }
    for (const extra of record.supplements ?? []) {
      for (const field of ['title', 'author', 'licence', 'licenceUrl', 'sourcePage', 'why']) {
        if (!extra[field]) fail(`models ${sex}: supplement ${extra.id}: ${field} missing`)
      }
      if (!MODEL_LICENCES.has(extra.licence)) fail(`models ${sex}: supplement ${extra.id}: licence ${extra.licence} not on the allow-list`)
      if (extra.notice && !existsSync(join(DATA_DIR, '..', extra.notice))) fail(`models ${sex}: supplement ${extra.id}: NOTICE missing`)
    }
    for (const id of PAGE_LAYERS) if (!ids.has(id)) fail(`models ${sex}: layer ${id} (used by the page) missing`)
    if (total > sexBudget) fail(`models ${sex}: ${(total / 1e6).toFixed(2)} MB over the ${sexBudget / 1e6} MB budget`)
    if (total !== record.totalBytes) fail(`models ${sex}: totalBytes ${record.totalBytes} does not match ${total}`)
    modelBytes += total
    const structurePath = join(MODEL_DIR, `structures-${sex}.json`)
    if (!existsSync(structurePath)) fail(`models ${sex}: structures-${sex}.json missing`)
    else {
      const { structures } = JSON.parse(readFileSync(structurePath, 'utf-8'))
      structureCount += structures.length
      if (structures.length !== record.structureCount) fail(`models ${sex}: ${structures.length} structures, manifest says ${record.structureCount}`)
      const names = new Set()
      for (const s of structures) {
        if (!s.node || !s.name) fail(`models ${sex}: structure without node/name (${JSON.stringify(s).slice(0, 80)})`)
        if (!PAGE_LAYERS.includes(s.layer)) fail(`models ${sex}: structure ${s.node} in unknown layer ${s.layer}`)
        if (s.organ && !organs.has(s.organ)) fail(`models ${sex}: structure ${s.node} names unknown organ ${s.organ}`)
        if (s.organ) resolved.add(s.organ)
        if (s.system && !systems.has(s.system)) fail(`models ${sex}: structure ${s.node} names unknown system ${s.system}`)
        if (names.has(s.node)) fail(`models ${sex}: duplicate node ${s.node}`)
        names.add(s.node)
      }
    }
  }
  for (const organ of file.organs) {
    if (organ.mesh && !resolved.has(organ.id)) fail(`organ ${organ.id}: has 3-D aliases but no structure in either model resolves to it`)
  }
  console.log(`  3-D models: ${(modelBytes / 1e6).toFixed(2)} MB across both sexes · ${structureCount.toLocaleString()} named structures · ${resolved.size} of ${file.organs.length} organ entries reachable from a model`)
}

if (failures > 0) {
  console.error(`\nFAIL — ${failures} anatomy problem(s).`)
  process.exit(1)
}
console.log('\nPASS — every system and organ is described, sourced and reachable; every diagram is credited under a free licence.')
