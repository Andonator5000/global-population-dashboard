/**
 * Map palette: normalise flag colours into a coherent band and guarantee that
 * no two bordering countries share a fill.
 *
 * WHY THIS DOES NOT SIMPLY NUDGE HUE
 * ----------------------------------
 * The brief prescribes clamping lightness and chroma to a narrow band and then
 * "nudging hue within a small tolerance" to separate neighbours. That cannot
 * work, and the reason is geometric rather than a matter of tuning.
 *
 * Two fills sharing lightness and chroma sit on a circle of radius C in the
 * OKLab a/b plane, so their separation is the chord 2*C*sin(dHue/2). At the
 * prescribed chroma of 0.055 that yields:
 *
 *     12 deg nudge -> dE 1.15      18 deg nudge -> dE 1.72
 *     even OPPOSITE hues          -> dE 11.0  (the hard cap, 2*C)
 *
 * Roughly 2-3 dE is the just-noticeable difference for large adjacent colour
 * fields, so a "small" hue nudge is invisible. Raising chroma until hue
 * differences read would make every country a saturated block, which the
 * dataviz guidance rules out for large marks.
 *
 * Lightness is the efficient channel: dE equals dL*100 directly, so a 0.06
 * step buys dE 6.0 -- more than opposite hues can buy at low chroma.
 *
 * THE DESIGN
 * ----------
 *   hue        <- the flag's dominant hue, UNMODIFIED (carries identity)
 *   chroma     <- constant and low (keeps the map one coherent system)
 *   lightness  <- one of four tiers, assigned by greedy graph colouring over
 *                 the border adjacency list
 *
 * Four tiers is not arbitrary: the four-colour theorem guarantees any planar
 * map is colourable with four, so "no two bordering countries share a fill"
 * becomes a GUARANTEE of the construction rather than something we hope the
 * data allows. Tiers span a narrow range, so the map still reads as one system.
 *
 * The cost, stated plainly: lightness now varies for reasons unrelated to any
 * value. The legend says so explicitly, because a reader could otherwise infer
 * that darker means more populous.
 *
 * Run: npm run palette
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

import { clampChroma, converter, formatHex, parse } from 'culori'

const ROOT = resolve(import.meta.dirname, '..')
const OUT_DIR = resolve(ROOT, 'data/flags')
const OUT_FILE = resolve(OUT_DIR, 'map-palette.json')

const toRgb = converter('rgb')
const toOklab = converter('oklab')
const toOklch = converter('oklch')

// ---------------------------------------------------------------------------
// Band definition
// ---------------------------------------------------------------------------

const THEMES = {
  light: {
    surface: 'oklch(98% 0.010 235)', // map water
    stroke: 'oklch(98% 0.010 235)',
    // Raised from 0.055 (2026-08): the muted band read as drab, and the
    // maintainer asked for a brighter map. Higher chroma also WIDENS
    // neighbour separation -- the hue chord is 2*C*sin(dHue/2), so it scales
    // linearly with chroma. Fills are clamped into sRGB gamut per hue, so a
    // hue that cannot carry this chroma at its tier degrades to the most
    // saturated displayable colour instead of channel-clipping.
    chroma: 0.1,
    // Four tiers, 0.055 apart -> dE 5.5 minimum between adjacent tiers.
    // The TOP tier is capped at 0.845 because anything lighter drifts too
    // close to the water and drops below the fill/water contrast floor --
    // measured, not guessed (0.89 scored 1.29 against a 1.35 floor).
    tiers: [0.68, 0.735, 0.79, 0.845],
  },
  dark: {
    surface: 'oklch(13% 0.010 235)',
    stroke: 'oklch(13% 0.010 235)',
    chroma: 0.11, // raised from 0.06 -- see the light-theme note
    // Lifted from [0.30..0.45] (2026-08) for the same brightening pass:
    // more lightness against the near-black water, and 0.06 steps -> dE 6
    // minimum between adjacent tiers, up from 5.
    tiers: [0.34, 0.4, 0.46, 0.52],
  },
}

/** Bordering fills must clear this. Above JND for large adjacent fields. */
const MIN_NEIGHBOUR_DE = 4.0
/** Every fill must stay at least this distinguishable from the water. */
const MIN_SURFACE_CONTRAST = 1.35

// ---------------------------------------------------------------------------
// Colour maths
// ---------------------------------------------------------------------------

function deltaE(a, b) {
  const x = toOklab(parse(a))
  const y = toOklab(parse(b))
  return (
    Math.hypot(x.l - y.l, (x.a ?? 0) - (y.a ?? 0), (x.b ?? 0) - (y.b ?? 0)) * 100
  )
}

function relativeLuminance(colour) {
  const c = toRgb(parse(colour))
  const f = (v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b)
}

function contrast(a, b) {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const fillFor = (theme, tierIndex, hue) =>
  formatHex(
    toRgb(
      // clampChroma walks chroma down (holding L and H) until the colour is
      // displayable in sRGB. Without it, formatHex would clip channels
      // independently, shifting both hue and lightness -- and a shifted
      // lightness silently breaks the tier guarantee the graph colouring
      // depends on.
      clampChroma(
        {
          mode: 'oklch',
          l: THEMES[theme].tiers[tierIndex],
          c: THEMES[theme].chroma,
          h: hue,
        },
        'oklch',
      ),
    ),
  )

// ---------------------------------------------------------------------------
// Graph colouring
// ---------------------------------------------------------------------------

/**
 * Exact k-colouring by DSATUR ordering with backtracking.
 *
 * A plain greedy pass (Welsh-Powell) is NOT good enough here, and this is not
 * a theoretical worry: it left Czechia, Georgia and Nigeria uncoloured on the
 * real border graph, which then collided with their neighbours at dE 0.14.
 * The four-colour theorem guarantees a 4-colouring EXISTS for a planar map; it
 * does not promise a greedy algorithm will find it.
 *
 * DSATUR picks the uncoloured vertex with the highest saturation (most
 * distinctly-coloured neighbours), breaking ties by degree, which is far
 * stronger. Backtracking on top makes the result exact rather than heuristic,
 * so "no two bordering countries share a fill" is a property of the output and
 * not a hope. The graph is ~250 vertices and ~325 edges, so this runs in
 * milliseconds.
 */
function colourGraph(nodes, neighbours, tierCount, stepBudget = 5_000_000) {
  const tier = new Map()
  const adjacency = new Map(
    nodes.map((n) => [n, [...(neighbours.get(n) ?? [])].filter((m) => neighbours.has(m))]),
  )
  let steps = 0

  function pickNext() {
    let best = null
    let bestSaturation = -1
    let bestDegree = -1
    for (const node of nodes) {
      if (tier.has(node)) continue
      const distinct = new Set()
      for (const other of adjacency.get(node)) {
        if (tier.has(other)) distinct.add(tier.get(other))
      }
      const degree = adjacency.get(node).length
      if (
        distinct.size > bestSaturation ||
        (distinct.size === bestSaturation && degree > bestDegree)
      ) {
        best = node
        bestSaturation = distinct.size
        bestDegree = degree
      }
    }
    return best
  }

  function solve(remaining) {
    if (remaining === 0) return true
    if (steps++ > stepBudget) return false
    const node = pickNext()
    if (node === null) return true

    const taken = new Set()
    for (const other of adjacency.get(node)) {
      if (tier.has(other)) taken.add(tier.get(other))
    }
    for (let t = 0; t < tierCount; t += 1) {
      if (taken.has(t)) continue
      tier.set(node, t)
      if (solve(remaining - 1)) return true
      tier.delete(node)
    }
    return false
  }

  const solved = solve(nodes.length)
  const failures = solved ? [] : nodes.filter((n) => !tier.has(n))
  // Any node the search abandoned still needs a value so the map renders;
  // it is reported so the failure is never silent.
  for (const node of failures) tier.set(node, 0)
  return { tier, failures, solved }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const entities = JSON.parse(
  readFileSync(resolve(ROOT, 'data/entities.json'), 'utf-8'),
)
const raw = JSON.parse(
  readFileSync(resolve(ROOT, 'data/flags/raw-palette.json'), 'utf-8'),
)

const neighbours = new Map()
for (const entity of entities) {
  neighbours.set(entity.iso3, new Set(entity.borders))
}

const nodes = entities.map((e) => e.iso3)
const { tier, failures, solved } = colourGraph(nodes, neighbours, 4)

const palette = {}
for (const entity of entities) {
  const flag = raw.flags[entity.iso3]
  const tierIndex = tier.get(entity.iso3) ?? 0
  // Entities with no extracted flag colour keep a neutral hue rather than a
  // fabricated one; they are still tiered so borders stay separated.
  const hue = flag ? flag.dominant.oklch.h : 250

  palette[entity.iso3] = {
    iso3: entity.iso3,
    name: entity.name_common,
    hasFlagColour: Boolean(flag),
    flagHue: flag ? flag.dominant.oklch.h : null,
    // Unclamped flag palette, for the country detail page.
    flag: flag
      ? { dominant: flag.dominant.hex, accents: flag.accents.map((a) => a.hex) }
      : null,
    // Path (relative to /data) of the committed flag SVG, written by
    // extract-flag-colors.mjs. Checked on disk rather than inferred from the
    // raw palette, because an achromatic flag has an SVG but no colour entry.
    flagSvg: existsSync(resolve(ROOT, 'data/flags/svg', `${entity.iso3}.svg`))
      ? `flags/svg/${entity.iso3}.svg`
      : null,
    tier: tierIndex,
    fill: {
      light: fillFor('light', tierIndex, hue),
      dark: fillFor('dark', tierIndex, hue),
    },
  }
}

// --- verification ----------------------------------------------------------

const report = { light: {}, dark: {} }
let hardFailures = 0

for (const theme of ['light', 'dark']) {
  const surface = THEMES[theme].surface
  const seen = new Set()
  const pairDeltas = []
  const violations = []

  for (const entity of entities) {
    for (const other of entity.borders) {
      if (!palette[other]) continue
      const key = [entity.iso3, other].sort().join('|')
      if (seen.has(key)) continue
      seen.add(key)
      const d = deltaE(
        palette[entity.iso3].fill[theme],
        palette[other].fill[theme],
      )
      pairDeltas.push(d)
      if (d < MIN_NEIGHBOUR_DE) {
        violations.push({ pair: key, deltaE: Number(d.toFixed(2)) })
      }
    }
  }

  const contrasts = entities.map((e) => ({
    iso3: e.iso3,
    ratio: contrast(palette[e.iso3].fill[theme], surface),
  }))
  const lowContrast = contrasts.filter((c) => c.ratio < MIN_SURFACE_CONTRAST)

  pairDeltas.sort((a, b) => a - b)
  report[theme] = {
    borderPairs: pairDeltas.length,
    minDeltaE: Number((pairDeltas[0] ?? 0).toFixed(2)),
    medianDeltaE: Number(
      (pairDeltas[Math.floor(pairDeltas.length / 2)] ?? 0).toFixed(2),
    ),
    violations,
    minSurfaceContrast: Number(
      Math.min(...contrasts.map((c) => c.ratio)).toFixed(2),
    ),
    lowContrastEntities: lowContrast.map((c) => c.iso3),
  }
  if (violations.length > 0 || lowContrast.length > 0) hardFailures += 1
}

// --- continent accents -----------------------------------------------------
// Circular mean of member flag hues; a plain average would put a continent
// straddling 350 and 10 degrees at 180 (cyan), which is nobody's flag.

const continentAccent = {}
const byContinent = new Map()
for (const entity of entities) {
  if (!byContinent.has(entity.continent)) byContinent.set(entity.continent, [])
  const flag = raw.flags[entity.iso3]
  if (flag) byContinent.get(entity.continent).push(flag.dominant.oklch.h)
}
for (const [continent, hues] of byContinent) {
  if (hues.length === 0) continue
  const sin = hues.reduce((s, h) => s + Math.sin((h * Math.PI) / 180), 0)
  const cos = hues.reduce((s, h) => s + Math.cos((h * Math.PI) / 180), 0)
  const hue = ((Math.atan2(sin / hues.length, cos / hues.length) * 180) / Math.PI + 360) % 360
  continentAccent[continent] = {
    hue: Number(hue.toFixed(2)),
    memberFlags: hues.length,
    // Accent steps, not fills: chosen for text/UI contrast in each theme.
    light: formatHex(toRgb({ mode: 'oklch', l: 0.48, c: 0.13, h: hue })),
    dark: formatHex(toRgb({ mode: 'oklch', l: 0.78, c: 0.12, h: hue })),
  }
}

// --- country page accent, with a contrast fallback -------------------------
// The brief allows the UNCLAMPED flag colour on the country page. Many flag
// colours (yellow especially) cannot carry text at AA, so each entity records
// whether its raw colour is safe as text, and a guaranteed-safe step to use
// when it is not. The raw colour is then accent-only.

for (const entity of entities) {
  const record = palette[entity.iso3]
  if (!record.flag) {
    record.accent = null
    continue
  }
  const rawHex = record.flag.dominant
  const oklch = toOklch(parse(rawHex))
  const safe = {
    light: formatHex(
      toRgb({ mode: 'oklch', l: 0.45, c: Math.min(oklch.c ?? 0.1, 0.14), h: oklch.h ?? 0 }),
    ),
    dark: formatHex(
      toRgb({ mode: 'oklch', l: 0.8, c: Math.min(oklch.c ?? 0.1, 0.13), h: oklch.h ?? 0 }),
    ),
  }
  record.accent = {
    raw: rawHex,
    rawSafeAsTextLight:
      contrast(rawHex, 'oklch(99% 0.002 250)') >= 4.5,
    rawSafeAsTextDark: contrast(rawHex, 'oklch(17% 0.006 250)') >= 4.5,
    textLight: safe.light,
    textDark: safe.dark,
    textLightContrast: Number(contrast(safe.light, 'oklch(99% 0.002 250)').toFixed(2)),
    textDarkContrast: Number(contrast(safe.dark, 'oklch(17% 0.006 250)').toFixed(2)),
  }
}

// --- generated stylesheet --------------------------------------------------
//
// Fills are emitted as CSS custom properties rather than inline attributes so
// the light/dark swap is handled by CSS itself. Inline fills would need the
// app to detect the theme in JS and re-render 250 paths on every change, which
// breaks for `prefers-color-scheme` without a listener and flashes the wrong
// palette on first paint.

const cssLines = [
  '/*',
  ' * GENERATED by scripts/build-map-palette.mjs -- do not edit.',
  ' * Regenerate with `npm run palette`.',
  ' *',
  ' * One custom property per entity, in both themes. Hue comes from the',
  ' * flag; lightness is a graph-coloured tier that guarantees no two',
  ' * bordering countries share a fill. Lightness carries NO value meaning.',
  ' */',
  ':root {',
  ...entities.map((e) => `  --fill-${e.iso3}: ${palette[e.iso3].fill.light};`),
  '}',
  '',
  '@media (prefers-color-scheme: dark) {',
  '  :root:not([data-theme="light"]) {',
  ...entities.map((e) => `    --fill-${e.iso3}: ${palette[e.iso3].fill.dark};`),
  '  }',
  '}',
  '',
  ':root[data-theme="dark"] {',
  ...entities.map((e) => `  --fill-${e.iso3}: ${palette[e.iso3].fill.dark};`),
  '}',
  '',
]
const GENERATED_DIR = resolve(ROOT, 'src/generated')
mkdirSync(GENERATED_DIR, { recursive: true })
writeFileSync(
  resolve(GENERATED_DIR, 'flag-fills.css'),
  cssLines.join('\n'),
  'utf-8',
)

mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      note:
        'Map fills derived from flag hues. Hue is the flag\'s dominant hue, ' +
        'unmodified. Lightness is one of four graph-coloured tiers so that no ' +
        'two bordering countries share a fill -- a small hue nudge cannot ' +
        'achieve that at low chroma (see scripts/build-map-palette.mjs). ' +
        'Lightness carries NO value meaning.',
      bands: THEMES,
      minNeighbourDeltaE: MIN_NEIGHBOUR_DE,
      verification: report,
      graphColouringFailures: failures,
      continentAccent,
      entities: palette,
    },
    null,
    2,
  ) + '\n',
  'utf-8',
)

// --- console report --------------------------------------------------------

console.log(`Built map palette for ${entities.length} entities.`)
console.log(
  solved
    ? '4-tier graph colouring: SOLVED exactly (DSATUR + backtracking).'
    : `4-tier graph colouring FAILED for ${failures.length}: ${failures.join(', ')}`,
)

for (const theme of ['light', 'dark']) {
  const r = report[theme]
  console.log(`\n  ${theme.toUpperCase()}`)
  console.log(`    bordering pairs checked : ${r.borderPairs}`)
  console.log(
    `    neighbour dE            : min ${r.minDeltaE}, median ${r.medianDeltaE} ` +
      `(floor ${MIN_NEIGHBOUR_DE})`,
  )
  console.log(
    `    pairs below floor       : ${r.violations.length} ` +
      `${r.violations.length ? '<-- FAIL' : 'PASS'}`,
  )
  for (const v of r.violations.slice(0, 8)) {
    console.log(`        ${v.pair}  dE ${v.deltaE}`)
  }
  console.log(
    `    min fill/water contrast : ${r.minSurfaceContrast} ` +
      `(floor ${MIN_SURFACE_CONTRAST}) ` +
      `${r.lowContrastEntities.length ? '<-- FAIL' : 'PASS'}`,
  )
  if (r.lowContrastEntities.length) {
    console.log(`        ${r.lowContrastEntities.slice(0, 10).join(', ')}`)
  }
}

const unsafeLight = Object.values(palette).filter(
  (p) => p.accent && !p.accent.rawSafeAsTextLight,
).length
console.log(
  `\n  ${unsafeLight} raw flag colours fail AA as text on the light surface; ` +
    `those render accent-only with a safe text step alongside.`,
)
console.log(`\n  wrote ${OUT_FILE}`)

process.exit(hardFailures > 0 ? 1 : 0)
