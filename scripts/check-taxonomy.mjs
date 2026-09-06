/**
 * Gate: the taxonomy artifacts are structurally sound and honestly sourced.
 *
 * What it proves (Phase 5, DATA_DECISIONS.md §31):
 * - The tree reaches from the Life root through >= 3 domains to a plausible
 *   number of families -- a stump (a traversal that quietly stopped early)
 *   fails loudly here instead of shipping.
 * - EVERY node -- tree and focus subtrees alike -- carries a non-empty name,
 *   a rank, and an explicit `wiki` key: either a Wikipedia title or null
 *   meaning "checked, none recorded". A node with the key absent means the
 *   mapping step never saw it, and that is a failure, not a null.
 * - Every family flagged `focus` has its genus/species artifact on disk.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = fileURLToPath(
  new URL('../data/biology/taxonomy/', import.meta.url),
)
const dataPath = (name) => join(DATA_DIR, name)

const MIN_FAMILIES = 8000
const MIN_DOMAINS = 3

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

let tree
try {
  tree = JSON.parse(readFileSync(dataPath('tree.json'), 'utf-8'))
} catch (error) {
  console.error(`  FAIL  cannot read tree.json: ${error.message}`)
  process.exit(1)
}

const stats = { nodes: 0, families: 0, withWiki: 0, focusFlags: [] }

function walk(node, where) {
  stats.nodes += 1
  if (!node.name || typeof node.name !== 'string') {
    fail(`${where}: node ${node.id ?? '?'} has no name`)
  }
  if (!node.rank) fail(`${where}: ${node.name ?? node.id} has no rank`)
  if (!('wiki' in node)) {
    fail(
      `${where}: ${node.name} (${node.rank}) lacks the wiki key -- ` +
        `neither a Wikipedia title nor an explicit null`,
    )
  } else if (node.wiki !== null && typeof node.wiki !== 'string') {
    fail(`${where}: ${node.name} wiki is neither string nor null`)
  }
  if (node.wiki) stats.withWiki += 1
  if (node.rank === 'family') stats.families += 1
  if (node.focus) stats.focusFlags.push(node)
  for (const child of node.children ?? []) walk(child, where)
}

walk(tree.tree, 'tree.json')

const domains = (tree.tree.children ?? []).filter(
  (node) => node.rank === 'domain',
)
if (domains.length < MIN_DOMAINS) {
  fail(
    `expected >= ${MIN_DOMAINS} domains under the root, found ` +
      `${domains.length}`,
  )
}
if (stats.families < MIN_FAMILIES) {
  fail(
    `only ${stats.families} family-rank nodes (expected >= ${MIN_FAMILIES}); ` +
      `the traversal probably stopped early`,
  )
}

let focusFiles = []
try {
  focusFiles = readdirSync(dataPath('focus')).filter((name) =>
    name.endsWith('.json'),
  )
} catch {
  fail('focus/ directory missing')
}

const focusStats = { nodes: 0, withWiki: 0, genera: 0 }
for (const name of focusFiles) {
  const subtree = JSON.parse(readFileSync(dataPath(join('focus', name)), 'utf-8'))
  const before = focusStats.nodes
  ;(function walkFocus(node) {
    focusStats.nodes += 1
    if (!('wiki' in node)) {
      fail(`focus/${name}: ${node.name} (${node.rank}) lacks the wiki key`)
    }
    if (node.wiki) focusStats.withWiki += 1
    if (node.rank === 'genus') focusStats.genera += 1
    for (const child of node.children ?? []) walkFocus(child)
  })(subtree)
  if (focusStats.nodes - before < 2) {
    fail(`focus/${name}: subtree has no children at all`)
  }
}

for (const family of stats.focusFlags) {
  const expected = `${encodeURIComponent(family.id)}.json`
  if (!focusFiles.includes(expected)) {
    fail(`family ${family.name} is flagged focus but focus/${expected} is missing`)
  }
}

console.log(
  `  tree: ${stats.nodes} nodes, ${stats.families} families, ` +
    `${domains.length} domains, ${stats.withWiki} with Wikipedia ` +
    `(${((100 * stats.withWiki) / stats.nodes).toFixed(1)}%)`,
)
console.log(
  `  focus: ${focusFiles.length} families, ${focusStats.nodes} nodes, ` +
    `${focusStats.genera} genera, ${focusStats.withWiki} with Wikipedia`,
)

if (failures > 0) {
  console.error(`\nFAIL — ${failures} taxonomy problem(s).`)
  process.exit(1)
}
console.log('\nPASS — taxonomy artifacts are complete and honestly flagged.')
