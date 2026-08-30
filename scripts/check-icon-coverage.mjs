// Reports how well src/data/product-icons.json covers the DISTINCT industry,
// agricultural-product and export-commodity strings across every Factbook
// artifact, and writes the unmatched remainder for editorial review.
//
//   node scripts/check-icon-coverage.mjs           # report
//   node scripts/check-icon-coverage.mjs --strict  # exit 1 below the floor
//
// Output: etl/logs/icon-coverage.json (summary, per-tier counts, unmatched
// list with mention counts). Coverage is measured over MENTIONS as well as
// distinct strings, because "milk" appearing on 138 country pages matters
// more than a one-off.

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const table = JSON.parse(readFileSync(join(ROOT, 'src/data/product-icons.json'), 'utf8'))
const rules = table.rules.map(([source, hex, name, tier]) => ({
  regex: new RegExp(source, 'i'),
  hex,
  name,
  tier,
}))
const fallbacks = Object.entries(table.categoryFallbacks)
  .filter(([key]) => !key.startsWith('_'))
  .map(([key, [source, hex, name]]) => ({ key, regex: new RegExp(source, 'i'), hex, name }))

export function resolveIcon(item) {
  const needle = item.toLowerCase()
  for (const rule of rules) {
    if (rule.regex.test(needle)) return { hex: rule.hex, name: rule.name, tier: rule.tier }
  }
  for (const fb of fallbacks) {
    if (fb.regex.test(needle)) return { hex: fb.hex, name: fb.name, tier: `category:${fb.key}` }
  }
  return null
}

const counts = new Map()
const dir = join(ROOT, 'data/factbook')
for (const file of readdirSync(dir)) {
  if (!file.endsWith('.json') || file === 'coverage.json') continue
  const doc = JSON.parse(readFileSync(join(dir, file), 'utf8'))
  for (const key of ['industries', 'agriculturalProducts', 'exportCommodities']) {
    for (const item of doc.economy?.[key]?.items ?? []) {
      const k = item.toLowerCase().trim()
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
  }
}

const tiers = { exact: 0, category: 0, none: 0 }
const mentions = { exact: 0, category: 0, none: 0 }
const unmatched = []
const byIcon = new Map()
for (const [item, n] of counts) {
  const hit = resolveIcon(item)
  const tier = hit === null ? 'none' : hit.tier === 'exact' ? 'exact' : 'category'
  tiers[tier] += 1
  mentions[tier] += n
  if (hit === null) unmatched.push({ item, mentions: n })
  else if (hit.hex) byIcon.set(hit.hex, (byIcon.get(hit.hex) ?? 0) + n)
}
unmatched.sort((a, b) => b.mentions - a.mentions || a.item.localeCompare(b.item))

const distinct = counts.size
const totalMentions = [...counts.values()].reduce((a, b) => a + b, 0)
const report = {
  note: 'Coverage of the curated keyword-to-icon table over every distinct Factbook item string. "exact" = the icon depicts the item; "category" = closest category icon (crop, mineral, factory...); "none" = labelled chip with no icon.',
  distinctItems: distinct,
  totalMentions,
  distinct: { ...tiers, coveredPct: +(((distinct - tiers.none) / distinct) * 100).toFixed(1) },
  mentions: { ...mentions, coveredPct: +(((totalMentions - mentions.none) / totalMentions) * 100).toFixed(1) },
  iconsUsed: byIcon.size,
  unmatched,
}
mkdirSync(join(ROOT, 'etl/logs'), { recursive: true })
writeFileSync(join(ROOT, 'etl/logs/icon-coverage.json'), JSON.stringify(report, null, 2) + '\n')
console.log(
  `icon coverage: ${report.distinct.coveredPct}% of ${distinct} distinct items ` +
    `(${tiers.exact} exact, ${tiers.category} category, ${tiers.none} unmatched); ` +
    `${report.mentions.coveredPct}% of ${totalMentions} mentions; ${byIcon.size} icons used`,
)
if (process.argv.includes('--strict') && report.mentions.coveredPct < 95) {
  console.error('icon coverage below the 95% mentions floor')
  process.exit(1)
}
