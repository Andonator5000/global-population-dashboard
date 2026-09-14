// Human Anatomy gate (round 6, DATA_DECISIONS.md §55).
//
// Proves the shipped artifact is complete and honest: every system has a
// description, functions, organs and a source URL; every organ has a
// location, description, function and source and is listed by its primary
// system; every layer and figure has a local image that exists, is a
// renderable type, is credited (author + free licence + Commons page), and
// every system is reachable from a layer or a figure. Fails the build
// otherwise — the page never ships an uncredited diagram or an unsourced
// entry.
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
if (failures > 0) {
  console.error(`\nFAIL — ${failures} anatomy problem(s).`)
  process.exit(1)
}
console.log('\nPASS — every system and organ is described, sourced and reachable; every diagram is credited under a free licence.')
