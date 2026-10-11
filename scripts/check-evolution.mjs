/**
 * Gate: the evolution timeline is complete and honestly sourced
 * (round-2 §40.4).
 *
 * - Every ICS PERIOD is covered by at least one event (an event covers a
 *   period when its date range overlaps it) — the maintainer found the
 *   Tonian empty once; this keeps every unit inhabited from now on.
 * - Every event carries a date, a summary, a Wikipedia anchor and at
 *   least one source; images, where present, carry a licence.
 * - Banner units carry their editorial description and etymology.
 * - Round 14 (section 73): the tree of life -- one root, every other node
 *   names an existing parent, no child predates its parent, extinct
 *   lineages carry an end date no older than their origin, every node has
 *   at least one non-Wikipedia source and a Wikipedia anchor, every
 *   silhouette carries a licence from the accepted set (CC0/PD, CC BY,
 *   CC BY-SA -- never NC/ND) and an attribution, both endosymbiosis
 *   merges point at real donor lineages, and the mass-extinction bands
 *   are dated and sourced.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = fileURLToPath(
  new URL('../data/biology/evolution/', import.meta.url),
)

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

const chart = JSON.parse(readFileSync(join(DATA_DIR, 'chart.json'), 'utf-8'))
const eventsFile = JSON.parse(
  readFileSync(join(DATA_DIR, 'events.json'), 'utf-8'),
)
const events = eventsFile.events

for (const event of events) {
  if (typeof event.startMa !== 'number') fail(`${event.id}: no startMa`)
  if (!event.summary || event.summary.split(' ').length < 30) {
    fail(`${event.id}: summary missing or too short`)
  }
  if (!event.wikipedia) fail(`${event.id}: no wikipedia anchor`)
  if (!event.sources?.length) fail(`${event.id}: no sources`)
  if (event.image && !event.image.license) {
    fail(`${event.id}: image without a licence`)
  }
}

const periods = chart.intervals.filter((i) => i.rank === 'Period')
const covers = (event, period) => {
  const end = event.endMa ?? event.startMa
  return event.startMa >= period.endMa && end <= period.startMa
}
for (const period of periods) {
  const inside = events.filter((event) => covers(event, period))
  if (inside.length === 0) {
    fail(`period ${period.name} (${period.startMa}–${period.endMa} Ma) has no events`)
  }
}

const banners = chart.intervals.filter((i) =>
  ['Eon', 'Era', 'Period'].includes(i.rank),
)
const missingNotes = banners.filter((i) => !i.description || !i.etymology)
if (missingNotes.length > 0) {
  fail(
    `banner units without description/etymology: ` +
      missingNotes.map((i) => i.name).join(', '),
  )
}

// ---- Round 14: the tree of life through time ------------------------------
const tree = JSON.parse(readFileSync(join(DATA_DIR, 'tree.json'), 'utf-8'))
const nodes = tree.nodes ?? []
const byId = new Map(nodes.map((n) => [n.id, n]))
if (!byId.has(tree.root)) fail(`tree: root ${tree.root} is not a node`)
if (nodes.length < 120) fail(`tree: only ${nodes.length} lineages (want >= 120)`)
const ACCEPTED_LICENCE = /publicdomain\/(zero|mark)|licenses\/by(-sa)?\//
let roots = 0
let silhouettes = 0
let merges = 0
for (const node of nodes) {
  if (node.parent === null) {
    roots += 1
    continue
  }
  const parent = byId.get(node.parent)
  if (!parent) {
    fail(`tree ${node.id}: unknown parent ${node.parent}`)
    continue
  }
  if (typeof node.originMa !== 'number' || node.originMa <= 0) fail(`tree ${node.id}: no originMa`)
  if (node.originMa > parent.originMa) fail(`tree ${node.id}: older (${node.originMa}) than its parent ${parent.id} (${parent.originMa})`)
  if (node.status === 'extinct') {
    if (typeof node.extinctMa !== 'number' || node.extinctMa > node.originMa) fail(`tree ${node.id}: extinct without a sane extinctMa`)
  } else if (node.status !== 'extant') fail(`tree ${node.id}: status ${node.status}`)
  if (!['divergence', 'fossil', 'estimate'].includes(node.originKind)) fail(`tree ${node.id}: originKind ${node.originKind}`)
  if (!node.wikipedia) fail(`tree ${node.id}: no wikipedia anchor`)
  const cited = (node.sources ?? []).filter((src) => src.url && !/wikipedia\.org/.test(src.url))
  if (cited.length === 0) fail(`tree ${node.id}: no non-Wikipedia source`)
  if (!node.summary || node.summary.split(' ').length < 12) fail(`tree ${node.id}: summary missing or too short`)
  if (!tree.groups?.[node.group]) fail(`tree ${node.id}: group ${node.group} not declared`)
  if (node.image) {
    silhouettes += 1
    if (!node.image.license || !ACCEPTED_LICENCE.test(node.image.license) || /nc|nd/.test(node.image.license.toLowerCase().replace(/.*licenses\/by/, '').split('/')[0] ?? '')) {
      fail(`tree ${node.id}: silhouette licence ${node.image.license} is not CC0/PD, CC BY or CC BY-SA`)
    }
    if (!node.image.page) fail(`tree ${node.id}: silhouette without a source page`)
  }
  for (const merge of node.merges ?? []) {
    merges += 1
    if (!byId.has(merge.from)) fail(`tree ${node.id}: merge from unknown lineage ${merge.from}`)
    if (!merge.label) fail(`tree ${node.id}: merge without a label`)
  }
}
if (roots !== 1) fail(`tree: ${roots} roots (want exactly 1)`)
if (merges < 2) fail(`tree: ${merges} endosymbiosis merges (want the mitochondrial and the plastid one)`)
const bands = tree.bands ?? []
if (bands.filter((b) => b.kind === 'extinction').length < 5) fail('tree: fewer than five mass-extinction bands')
for (const band of bands) {
  if (typeof band.startMa !== 'number' || typeof band.endMa !== 'number' || band.endMa > band.startMa) fail(`tree band ${band.id}: bad dates`)
  if (!band.sources?.length) fail(`tree band ${band.id}: no sources`)
}
console.log(`  tree: ${nodes.length} lineages, ${silhouettes} silhouettes, ${merges} merges, ${bands.length} bands`)

console.log(
  `  ${events.length} events; ${periods.length} periods all covered: ` +
    `${failures === 0}; ${banners.length} banner units annotated`,
)
if (failures > 0) {
  console.error(`\nFAIL — ${failures} evolution problem(s).`)
  process.exit(1)
}
console.log('\nPASS — every period is inhabited and every entry is sourced.')
