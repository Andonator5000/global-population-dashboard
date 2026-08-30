/**
 * Theme parity gate.
 *
 * The dark palette has to be declared TWICE — once under
 * `@media (prefers-color-scheme: dark)` for the OS setting, and once under
 * `:root[data-theme="dark"]` so an explicit toggle wins. CSS gives no way to
 * OR a media query with a selector, so the duplication is unavoidable.
 *
 * The duplication is also a trap, and it caught us three separate times: the
 * two blocks are indented differently, so a find-and-replace across "the dark
 * block" silently updates only one of them. The most recent instance shipped
 * chart series colours that never switched under the explicit toggle — every
 * composition bar would have rendered light-mode hues on a dark surface.
 *
 * This script parses src/index.css and asserts the two dark blocks declare
 * exactly the same tokens with exactly the same values, and that every
 * themed token in `:root` is overridden in both.
 *
 * Run: npm run check:theme-parity
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const CSS_PATH = resolve(import.meta.dirname, '../src/index.css')
const css = readFileSync(CSS_PATH, 'utf-8')

/**
 * Tokens that are intentionally THEME-INVARIANT: declared once in :root and
 * deliberately not overridden for dark. Space is space in both themes, and
 * the brand button keeps a single identity everywhere. Listing one here is a
 * statement that its single declaration is a decision, not an omission.
 */
const LIGHT_ONLY = new Set([
  '--brand-bg',
  '--brand-text',
  '--history-bg',
  '--history-text',
  '--map-space',
  '--map-ocean',
])

function blockAfter(marker, from = 0) {
  const start = css.indexOf(marker, from)
  if (start === -1) return null
  const open = css.indexOf('{', start)
  if (open === -1) return null
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return { text: css.slice(open + 1, i), end: i }
    }
  }
  return null
}

function tokensIn(text) {
  const out = new Map()
  const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi
  let match
  while ((match = re.exec(text)) !== null) {
    out.set(match[1], match[2].trim().replace(/\s+/g, ' '))
  }
  return out
}

// `:root {` — the light block. Anchored to line start so it does not match
// `:root[data-theme=...]` or `:root:not(...)`.
const lightStart = css.search(/^:root\s*\{/m)
const light = blockAfter(':root', lightStart)
const media = blockAfter(':root:not([data-theme=', 0)
const explicit = blockAfter(":root[data-theme='dark']", 0)

const failures = []
if (!light) failures.push('could not locate the :root light block')
if (!media) failures.push('could not locate the prefers-color-scheme dark block')
if (!explicit) failures.push("could not locate the :root[data-theme='dark'] block")

if (failures.length === 0) {
  const lightTokens = tokensIn(light.text)
  const mediaTokens = tokensIn(media.text)
  const explicitTokens = tokensIn(explicit.text)

  console.log(
    `light: ${lightTokens.size} tokens · ` +
      `media-dark: ${mediaTokens.size} · explicit-dark: ${explicitTokens.size}`,
  )

  // 1. The two dark blocks must be identical.
  const allDarkKeys = new Set([...mediaTokens.keys(), ...explicitTokens.keys()])
  for (const key of [...allDarkKeys].sort()) {
    const a = mediaTokens.get(key)
    const b = explicitTokens.get(key)
    if (a === undefined) {
      failures.push(`${key}: missing from the prefers-color-scheme dark block`)
    } else if (b === undefined) {
      failures.push(`${key}: missing from the [data-theme="dark"] block`)
    } else if (a !== b) {
      failures.push(`${key}: dark blocks disagree — "${a}" vs "${b}"`)
    }
  }

  // 2. Every themed light token needs a dark counterpart.
  for (const key of [...lightTokens.keys()].sort()) {
    if (LIGHT_ONLY.has(key)) continue
    if (!mediaTokens.has(key)) {
      failures.push(`${key}: declared in :root but never overridden for dark`)
    }
  }
}

if (failures.length === 0) {
  console.log('\nPASS — both dark blocks declare identical tokens, and every')
  console.log('themed token has a dark counterpart.')
  process.exit(0)
}

console.log(`\nFAIL — ${failures.length} theme parity problem(s):`)
for (const failure of failures) console.log(`  ${failure}`)
process.exit(1)
