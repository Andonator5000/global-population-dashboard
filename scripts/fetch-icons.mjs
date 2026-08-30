// Vendors the OpenMoji black-outline SVGs the product-icon table references
// into public/icons/openmoji/<HEXCODE>.svg, and fails loudly on any hexcode
// OpenMoji does not publish (a typo in the table must not become a broken
// image in production).
//
//   node scripts/fetch-icons.mjs
//
// Source: https://github.com/hfg-gmuend/openmoji (CC BY-SA 4.0). The black
// variant is a monochrome outline set at one stroke weight, which is what
// lets ~130 icons from one library read as one system. The app paints them
// through a CSS mask in currentColor, so they follow the theme.
//
// Run whenever src/data/product-icons.json or src/lib/icons.ts adds a code.
// The SVGs are committed; this script is not part of the ETL or CI.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'public/icons/openmoji')
const BASE = 'https://raw.githubusercontent.com/hfg-gmuend/openmoji/master/black/svg'

const table = JSON.parse(readFileSync(join(ROOT, 'src/data/product-icons.json'), 'utf8'))
const codes = new Set()
for (const [, hex] of table.rules) if (hex) codes.add(hex)
for (const [key, value] of Object.entries(table.categoryFallbacks)) {
  if (!key.startsWith('_')) codes.add(value[1])
}
// Codes referenced directly from src/lib/icons.ts (biomes, sectors, religions).
const iconsTs = readFileSync(join(ROOT, 'src/lib/icons.ts'), 'utf8')
for (const match of iconsTs.matchAll(/'([0-9A-F]{4,5}(?:-[0-9A-F]{4,5})*)'/g)) codes.add(match[1])

mkdirSync(OUT, { recursive: true })
let fetched = 0
let present = 0
const missing = []
for (const code of [...codes].sort()) {
  const target = join(OUT, `${code}.svg`)
  if (existsSync(target)) {
    present += 1
    continue
  }
  const response = await fetch(`${BASE}/${code}.svg`)
  if (!response.ok) {
    missing.push(code)
    continue
  }
  const svg = await response.text()
  if (!svg.includes('<svg')) {
    missing.push(code)
    continue
  }
  writeFileSync(target, svg)
  fetched += 1
}
console.log(`openmoji: ${present} already vendored, ${fetched} fetched, ${missing.length} missing`)
if (missing.length) {
  console.error(`unknown OpenMoji hexcodes: ${missing.join(', ')}`)
  process.exit(1)
}
