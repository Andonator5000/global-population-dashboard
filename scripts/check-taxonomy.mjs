/**
 * Gate: the taxonomy artifacts are structurally sound and honestly sourced.
 *
 * What it proves (Phase 5 §31, round 2 §39, round 3 §44):
 * - The tree reaches from the Life root through >= 3 domains to a plausible
 *   number of families -- a stump (a traversal that quietly stopped early)
 *   fails loudly here instead of shipping.
 * - EVERY node -- tree and genera files alike -- carries a non-empty name,
 *   a rank, an explicit `wiki` key (title or null = "checked, none"), and an
 *   explicit `img` key (licensed object or null).
 * - EVERY node has a description with its source recorded (§44.3):
 *   `descSrc` in {wikipedia, wikidata, col, generated}. Tree nodes sourced
 *   from Wikipedia or generated carry their text in the extract shard for
 *   their id; wikidata/col nodes carry it inline; genera-file nodes carry
 *   wikipedia/wikidata/col text inline and generated ones are composed
 *   from shipped facts (name, rank) at render time. No node is unflagged.
 * - Every family flagged with `gen` (genera count) has its genera file on
 *   disk, whose root id matches; every focus family's file carries species
 *   inline; a genus not yet enriched is flagged `pending` (never a silent
 *   wiki:null), and a non-pending node's wiki/img are real lookups.
 * - Every rank string in the data is one the rank system defines or can
 *   compose (the RANK_LADDER below mirrors ChecklistBank's vocabulary).
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = fileURLToPath(
  new URL('../data/biology/taxonomy/', import.meta.url),
)
const dataPath = (name) => join(DATA_DIR, name)

const MIN_FAMILIES = 8000
const MIN_DOMAINS = 3
const MIN_GENERA = 150000
const DESC_SOURCES = new Set(['wikipedia', 'wikidata', 'col', 'generated'])
const RANK_PREFIXES = ['sub', 'ter', 'super', 'infra', 'parv', 'mega', 'giga', 'grand', 'mir', 'nano', 'nan', 'hypo', 'epi', 'magn', 'min', 'micro', 'supra']
const KNOWN_BASES = new Set([
  'root', 'domain', 'realm', 'empire', 'kingdom', 'phylum', 'division',
  'class', 'claudius', 'legion', 'cohort', 'order', 'section', 'series',
  'falanx', 'family', 'tribe', 'suprageneric name', 'genus',
  'infrageneric name', 'species aggregate', 'species', 'infraspecific name',
  'grex', 'klepton', 'cultivar group', 'convariety', 'infrasubspecific name',
  'proles', 'natio', 'aberration', 'morph', 'variety', 'form', 'pathovar',
  'biovar', 'chemovar', 'morphovar', 'phagovar', 'serovar', 'chemoform',
  'forma specialis', 'lusus', 'cultivar', 'mutatio', 'strain', 'other',
  'unranked',
])

let failures = 0
let reported = 0
const fail = (message) => {
  failures += 1
  if (reported < 40) console.error(`  FAIL  ${message}`)
  reported += 1
}

let tree
try {
  tree = JSON.parse(readFileSync(dataPath('tree.json'), 'utf-8'))
} catch (error) {
  console.error(`  FAIL  cannot read tree.json: ${error.message}`)
  process.exit(1)
}

const shardCount = tree.extractShards ?? 32
const shards = []
for (let index = 0; index < shardCount; index += 1) {
  const name = `${String(index).padStart(2, '0')}.json`
  try {
    shards.push(JSON.parse(readFileSync(dataPath(join('extracts', name)), 'utf-8')))
  } catch {
    fail(`extracts/${name} missing or unreadable`)
    shards.push({})
  }
}
const shardOf = (id) =>
  parseInt(createHash('sha1').update(id).digest('hex').slice(0, 2), 16) % shardCount

const rankStrings = new Set()
function rankDefined(rank) {
  const bare = rank.replace(/ (zoology|botany)$/, '')
  if (KNOWN_BASES.has(bare)) return true
  // Strip stacked prefixes one at a time, trying every alternative
  // ("nanorder" is nan+order, "nanophylum" is nano+phylum).
  return RANK_PREFIXES.some(
    (prefix) => bare.startsWith(prefix) && bare.length > prefix.length && rankDefined(bare.slice(prefix.length)),
  )
}

function checkNode(node, where, kind) {
  if (!node.name || typeof node.name !== 'string') {
    fail(`${where}: node ${node.id ?? '?'} has no name`)
  }
  if (!node.rank) {
    fail(`${where}: ${node.name ?? node.id} has no rank`)
  } else {
    rankStrings.add(node.rank)
    if (!rankDefined(node.rank)) {
      fail(`${where}: ${node.name} carries rank "${node.rank}" the rank system cannot define`)
    }
  }
  // A pending genus-file node (§44.5) carries the flag ALONE: wiki null,
  // img null and a generated description are implied and expanded by the
  // loader; anything else on it would be a lookup it never had.
  if (node.pending) {
    for (const key of ['wiki', 'img', 'desc', 'descSrc', 'ncbi', 'ott', 'firstMa']) {
      if (key in node) fail(`${where}: ${node.name} is pending enrichment yet carries ${key}`)
    }
    return
  }
  if (!('wiki' in node)) {
    fail(`${where}: ${node.name} (${node.rank}) lacks the wiki key -- neither a Wikipedia title nor an explicit null`)
  } else if (node.wiki !== null && typeof node.wiki !== 'string') {
    fail(`${where}: ${node.name} wiki is neither string nor null`)
  }
  if (!('img' in node)) {
    fail(`${where}: ${node.name} (${node.rank}) lacks the img key`)
  } else if (node.img !== null && !node.img.license) {
    fail(`${where}: ${node.name} image has no licence recorded`)
  } else if (
    node.img?.rep !== undefined &&
    (typeof node.img.rep !== 'string' || node.img.rep === '')
  ) {
    fail(`${where}: ${node.name} representative photo lacks its source name`)
  }
  // §44.3: a description, with its source recorded.
  const source = node.descSrc
  if (!DESC_SOURCES.has(source)) {
    fail(`${where}: ${node.name} (${node.rank}) has no description source (descSrc=${source})`)
  } else if (source === 'wikidata' || source === 'col') {
    if (typeof node.desc !== 'string' || node.desc.trim() === '') {
      fail(`${where}: ${node.name} claims a ${source} description but carries none`)
    }
  } else if (kind === 'tree') {
    const text = node.id ? shards[shardOf(node.id)]?.[node.id] : node.desc
    if (typeof text !== 'string' || text.trim() === '') {
      fail(`${where}: ${node.name} (${source}) has no text in its extract shard`)
    }
  } else if (source === 'wikipedia') {
    if (typeof node.desc !== 'string' || node.desc.trim() === '') {
      fail(`${where}: ${node.name} claims a Wikipedia description but carries none`)
    }
  }
}

const stats = {
  nodes: 0, families: 0, withWiki: 0, withImage: 0, withRep: 0,
  gen: [], focus: [], desc: { wikipedia: 0, wikidata: 0, col: 0, generated: 0 },
}

function walk(node, where) {
  stats.nodes += 1
  checkNode(node, where, 'tree')
  if (node.wiki) stats.withWiki += 1
  if (node.img) stats.withImage += 1
  if (node.img?.rep) stats.withRep += 1
  if (node.rank === 'family') stats.families += 1
  if (node.gen) stats.gen.push(node)
  if (node.focus) stats.focus.push(node)
  if (DESC_SOURCES.has(node.descSrc)) stats.desc[node.descSrc] += 1
  for (const child of node.children ?? []) walk(child, where)
}

walk(tree.tree, 'tree.json')

const domains = (tree.tree.children ?? []).filter((node) => node.rank === 'domain')
if (domains.length < MIN_DOMAINS) {
  fail(`expected >= ${MIN_DOMAINS} domains under the root, found ${domains.length}`)
}
if (stats.families < MIN_FAMILIES) {
  fail(`only ${stats.families} family-rank nodes (expected >= ${MIN_FAMILIES}); the traversal probably stopped early`)
}
if (existsSync(dataPath('focus'))) {
  fail('focus/ directory still present: focus depth migrated into genera/ (§44.5)')
}

let generaFiles = []
try {
  generaFiles = readdirSync(dataPath('genera')).filter((name) => name.endsWith('.json'))
} catch {
  fail('genera/ directory missing')
}

const generaStats = {
  files: generaFiles.length, nodes: 0, genera: 0, withWiki: 0, withImage: 0,
  pending: 0, generaEnriched: 0, generaWithWiki: 0, bytes: 0,
  largest: { bytes: 0, name: '' }, species: 0,
  desc: { wikipedia: 0, wikidata: 0, col: 0, generated: 0 },
}
const generaById = new Map()
for (const name of generaFiles) {
  const path = dataPath(join('genera', name))
  const size = statSync(path).size
  generaStats.bytes += size
  const subtree = JSON.parse(readFileSync(path, 'utf-8'))
  if (size > generaStats.largest.bytes) generaStats.largest = { bytes: size, name: subtree.name }
  generaById.set(subtree.id, subtree)
  if (`${encodeURIComponent(subtree.id)}.json` !== name) {
    fail(`genera/${name}: root id ${subtree.id} does not match the file name`)
  }
  if (subtree.rank !== 'family') fail(`genera/${name}: root is a ${subtree.rank}, not a family`)
  let genera = 0
  ;(function walkGenera(node, isRoot) {
    generaStats.nodes += 1
    if (!isRoot) checkNode(node, `genera/${name}`, 'genera')
    if (node.rank === 'genus') {
      genera += 1
      generaStats.genera += 1
      if (!node.pending) generaStats.generaEnriched += 1
      if (node.wiki) generaStats.generaWithWiki += 1
    }
    if (node.rank === 'species') generaStats.species += 1
    if (node.wiki) generaStats.withWiki += 1
    if (node.img) generaStats.withImage += 1
    if (node.pending) {
      generaStats.pending += 1
      generaStats.desc.generated += 1
    } else if (!isRoot && DESC_SOURCES.has(node.descSrc)) {
      generaStats.desc[node.descSrc] += 1
    }
    if (subtree.focus && node.rank === 'genus' && node.kids && !(node.children?.length > 0)) {
      fail(`genera/${name}: focus family genus ${node.name} has children in COL but none inline`)
    }
    for (const child of node.children ?? []) walkGenera(child, false)
  })(subtree, true)
  if (genera === 0 && !(subtree.children?.length > 0)) {
    fail(`genera/${name}: file has no genera and no subdivisions`)
  }
}

for (const family of stats.gen) {
  const expected = `${encodeURIComponent(family.id)}.json`
  if (!generaFiles.includes(expected)) {
    fail(`family ${family.name} lists ${family.gen} genera but genera/${expected} is missing`)
  }
}
for (const family of stats.focus) {
  const subtree = generaById.get(family.id)
  if (!subtree) {
    fail(`focus family ${family.name} has no genera file`)
  } else if (!subtree.focus) {
    fail(`focus family ${family.name}: its genera file is not flagged focus`)
  }
}
if (generaStats.genera < MIN_GENERA) {
  fail(`only ${generaStats.genera} genera across the genera files (expected >= ${MIN_GENERA})`)
}

const pct = (part, whole) => (whole ? ((100 * part) / whole).toFixed(1) : '0.0')
console.log(
  `  tree: ${stats.nodes} nodes, ${stats.families} families, ${domains.length} domains, ` +
    `${stats.withWiki} with Wikipedia (${pct(stats.withWiki, stats.nodes)}%), ` +
    `${stats.withImage} with a free photo (${stats.withRep} representative); ` +
    `${rankStrings.size} rank strings, all defined`,
)
console.log(
  `  tree descriptions: wikipedia ${stats.desc.wikipedia}, wikidata ${stats.desc.wikidata}, ` +
    `col ${stats.desc.col}, generated ${stats.desc.generated} (all flagged)`,
)
console.log(
  `  genera files: ${generaStats.files} files, ${(generaStats.bytes / 1e6).toFixed(1)} MB, ` +
    `largest ${generaStats.largest.name} ${(generaStats.largest.bytes / 1e3).toFixed(0)} kB; ` +
    `${generaStats.nodes} nodes, ${generaStats.genera} genera ` +
    `(${generaStats.generaEnriched} enriched, ${generaStats.generaWithWiki} with Wikipedia), ` +
    `${generaStats.species} focus species inline, ${generaStats.pending} pending`,
)
console.log(
  `  genera descriptions: wikipedia ${generaStats.desc.wikipedia}, wikidata ${generaStats.desc.wikidata}, ` +
    `col ${generaStats.desc.col}, generated ${generaStats.desc.generated} (all flagged)`,
)

if (failures > 0) {
  console.error(`\nFAIL — ${failures} taxonomy problem(s).`)
  process.exit(1)
}
console.log('\nPASS — taxonomy artifacts are complete and honestly flagged.')
