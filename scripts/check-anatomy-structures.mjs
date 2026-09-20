// Anatomy structure descriptions gate (round 13, DATA_DECISIONS.md section 66).
//
// data/anatomy/structures-wiki.json is what the 3-D viewer reads when a label
// is clicked, so this proves it is complete and honest before it ships:
//
//   * every named structure in BOTH models has an entry, keyed by its
//     normalised name (the normalisation is reimplemented here, and this file
//     is the reference the viewer's TypeScript mirrors);
//   * every entry either describes the structure -- title + Wikipedia URL +
//     an extract of at least 20 words -- or says title: null WITH a reason;
//   * no extract is a disambiguation page ("may refer to");
//   * at least 80% of the names are described;
//   * the CC BY-SA licence block Wikipedia's text obliges us to carry is there,
//     and every described entry carries the article title and URL that make
//     the attribution usable.
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = new URL('../data/anatomy/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const MODEL_DIR = join(DATA_DIR, 'models')
const FILE = join(DATA_DIR, 'structures-wiki.json')

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

if (!existsSync(FILE)) {
  console.error(`  FAIL  data/anatomy/structures-wiki.json missing — run \`python etl/run.py --only anatomy_structures\``)
  process.exit(1)
}
const file = JSON.parse(readFileSync(FILE, 'utf-8'))

// --- the normalisation contract (mirror of etl/sources/anatomy_structures.py) ---
const SIDE = /\s*\((?:left|right)(?:\s*,\s*[^)]*)?\)\s*$/i
const PART = /\s*[—–-]\s*part\s+\S+\s*$/i
const normalise = (name) => {
  let text = String(name ?? '').split(/\s+/).filter(Boolean).join(' ')
  let previous = null
  while (previous !== text) {
    previous = text
    text = text.replace(SIDE, '').replace(PART, '').trim()
  }
  return text
}

const entries = file.structures ?? {}
if (!file.version) fail('no version')
if (!file.generated) fail('no generated timestamp')
const source = file.source ?? {}
if (!source.title) fail('source.title missing')
if (!/^CC BY-SA/i.test(source.licence ?? '')) fail(`source.licence is ${source.licence ?? 'missing'} (Wikipedia text is CC BY-SA 4.0)`)
if (!/^https:\/\/creativecommons\.org\//.test(source.licenceUrl ?? '')) fail('source.licenceUrl is not a creativecommons.org URL')
if (!file.normalisation) fail('no normalisation contract stated for the viewer')

// --- every model name is present and answered ---
const names = new Set()
const perSex = {}
for (const sex of ['male', 'female']) {
  const path = join(MODEL_DIR, `structures-${sex}.json`)
  if (!existsSync(path)) { fail(`structures-${sex}.json missing`); continue }
  const sexNames = new Set()
  for (const structure of JSON.parse(readFileSync(path, 'utf-8')).structures) {
    const key = normalise(structure.name)
    if (!key) continue
    names.add(key)
    sexNames.add(key)
  }
  perSex[sex] = sexNames
}

const missing = [...names].filter((name) => !(name in entries))
if (missing.length) {
  fail(`${missing.length} model name(s) have no entry, e.g. ${missing.slice(0, 5).map((n) => JSON.stringify(n)).join(', ')}`)
}

// --- every entry is complete, or null with a reason ---
const SCOPES = new Set(['exact', 'broader'])
const RUNGS = new Set(['override', 'override-broader', 'ontology', 'name', 'stripped', 'singular', 'ofthe', 'head', 'parent', 'shortened'])
let described = 0
let broader = 0
let shortest = Infinity
const problems = { short: 0, url: 0, disambiguation: 0, scope: 0, reason: 0 }
for (const [name, entry] of Object.entries(entries)) {
  if (entry.title == null) {
    if (!entry.reason) { problems.reason += 1; fail(`${name}: no title and no reason`) }
    continue
  }
  described += 1
  if (entry.scope === 'broader') broader += 1
  if (!SCOPES.has(entry.scope)) { problems.scope += 1; fail(`${name}: scope is ${JSON.stringify(entry.scope)}`) }
  if (!RUNGS.has(entry.resolvedBy)) { problems.scope += 1; fail(`${name}: resolvedBy is ${JSON.stringify(entry.resolvedBy)}`) }
  if (!/^https:\/\/en\.wikipedia\.org\/wiki\/\S+$/.test(entry.url ?? '')) {
    problems.url += 1
    if (problems.url <= 5) fail(`${name}: url is not a Wikipedia article URL (${entry.url})`)
  }
  const words = String(entry.extract ?? '').trim().split(/\s+/).filter(Boolean).length
  shortest = Math.min(shortest, words)
  if (words < 20) {
    problems.short += 1
    if (problems.short <= 5) fail(`${name}: extract is ${words} words (need 20)`)
  }
  if (/may (?:also )?refer to/i.test(entry.extract ?? '')) {
    problems.disambiguation += 1
    if (problems.disambiguation <= 5) fail(`${name}: extract reads as a disambiguation page`)
  }
}
if (problems.url > 5) fail(`… and ${problems.url - 5} more non-Wikipedia URLs`)
if (problems.short > 5) fail(`… and ${problems.short - 5} more extracts under 20 words`)

// --- coverage ---
const total = Object.keys(entries).length
const coverage = total ? described / total : 0
if (coverage < 0.8) fail(`coverage is ${(coverage * 100).toFixed(1)}% of ${total} names (floor 80%)`)
for (const [sex, sexNames] of Object.entries(perSex)) {
  const covered = [...sexNames].filter((name) => entries[name]?.title).length
  const share = sexNames.size ? covered / sexNames.size : 0
  if (share < 0.8) fail(`${sex} model: ${(share * 100).toFixed(1)}% of ${sexNames.size} names described (floor 80%)`)
  console.log(`  ${sex}: ${covered}/${sexNames.size} names described (${(share * 100).toFixed(1)}%)`)
}

const rungs = {}
for (const entry of Object.values(entries)) {
  if (entry.title) rungs[entry.resolvedBy] = (rungs[entry.resolvedBy] ?? 0) + 1
}
console.log(`  ${described}/${total} names described (${(coverage * 100).toFixed(1)}%) — ${described - broader} name the structure itself, ${broader} a broader article`)
console.log(`  by rung: ${Object.entries(rungs).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ${n}`).join(', ')}`)
console.log(`  shortest extract: ${Number.isFinite(shortest) ? shortest : 0} words · licence ${source.licence}`)

if (failures > 0) {
  console.error(`\nFAIL — ${failures} anatomy-structure problem(s).`)
  process.exit(1)
}
console.log('\nPASS — every named structure answers with a sourced, attributed description or an explicit reason.')
