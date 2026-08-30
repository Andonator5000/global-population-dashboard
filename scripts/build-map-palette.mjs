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
    // 2026-08-29 (Phase 2.4): the maintainer asked for something more
    // restrained and cohesive than the 0.10-chroma band of 2026-08-15.
    // Chroma drops to 0.045; the lightness tiers widen to 0.055 steps so the
    // neighbour separation (dE = dL*100 for same-hue pairs) stays above the
    // 4.0 floor without leaning on hue at all -- which is also what keeps
    // the palette legible under every common colour-vision deficiency:
    // lightness is the one channel CVD never removes.
    chroma: 0.045,
    // The TOP tier is capped at 0.845 because anything lighter drifts too
    // close to the water and drops below the fill/water contrast floor --
    // measured, not guessed (0.89 scored 1.29 against a 1.35 floor).
    tiers: [0.68, 0.735, 0.79, 0.845],
  },
  dark: {
    surface: 'oklch(13% 0.010 235)',
    stroke: 'oklch(13% 0.010 235)',
    chroma: 0.05,
    tiers: [0.34, 0.4, 0.46, 0.52],
  },
}

/**
 * Palette DIRECTIONS (2026-08-29, Phase 2.4). Both are emitted so the
 * maintainer can compare them live via the "Map colours" control; the
 * default is `atlas`.
 *
 *   atlas  the flag hue, restrained: chroma 0.045, four lightness tiers.
 *          Reads as a printed atlas -- identity survives, saturation does
 *          not.
 *   paper  the flag hue at chroma 0.022 over a warm paper base (hue 80),
 *          so the whole map is near-neutral and the lightness tiers carry
 *          the borders. The hue is a faint tint, not a colour.
 *
 * Every direction passes the same gates: neighbour dE >= 4.0 in both
 * themes, fill/water contrast >= 1.35, and every LIGHT fill >= 2.0 against
 * the globe ocean (light fills double as the globe's land in both themes).
 */
const DIRECTIONS = {
  atlas: { chroma: { light: 0.045, dark: 0.05 }, blendTo: null },
  paper: { chroma: { light: 0.022, dark: 0.028 }, blendTo: 80 },
}
const DEFAULT_DIRECTION = 'atlas'

/**
 * Continent REGIONS for the continent view (Phase 2.4): one cohesive fill
 * per continent, all at the same lightness so none reads as "more", with
 * hues spread around the wheel. Identity still comes from the label -- seven
 * hues cannot clear every CVD pair (DATA_DECISIONS 6.3) -- but the regions
 * now read as distinct blocks rather than one emphasised continent against
 * grey. Lightness matches the middle tiers so the globe ocean contrast
 * floor holds for these too.
 */
// Hues at least 50 degrees apart so every pair clears the neighbour floor
// at this chroma (dE = 2*C*sin(dHue/2)*100 -> 5.9 at 50 degrees, 0.07).
// Antarctica is ice: near-white, no hue, and lighter than the others.
const CONTINENT_HUES = { AF: 65, AS: 15, EU: 250, NA: 305, SA: 140, OC: 195, AN: 250 }
const CONTINENT_REGION = {
  light: { l: 0.79, c: 0.07 },
  dark: { l: 0.44, c: 0.07 },
}
const ANTARCTICA_REGION = {
  light: { l: 0.93, c: 0.004 },
  dark: { l: 0.62, c: 0.004 },
}

/** Bordering fills must clear this. Above JND for large adjacent fields. */
const MIN_NEIGHBOUR_DE = 4.0
/** Every fill must stay at least this distinguishable from the water. */
const MIN_SURFACE_CONTRAST = 1.35
/**
 * The globe view's ocean (MUST mirror --map-ocean in src/index.css). Every
 * LIGHT fill doubles as a globe fill, so each must clear the ocean too --
 * this is what makes "blue land vs blue ocean" confusion impossible: land
 * blues sit tiers of lightness above this.
 */
const GLOBE_OCEAN = 'oklch(31% 0.06 255)'
const MIN_OCEAN_CONTRAST = 2.0

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

const fillFor = (theme, tierIndex, hue, direction = DEFAULT_DIRECTION) => {
  const spec = DIRECTIONS[direction]
  // "paper" pulls every hue a third of the way toward the paper base, so
  // the map reads as one warm sheet with tints rather than as colours.
  let h = hue
  if (spec.blendTo !== null) {
    const d = ((spec.blendTo - hue + 540) % 360) - 180
    h = (hue + d / 3 + 360) % 360
  }
  return formatHex(
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
          c: spec.chroma[theme],
          h,
        },
        'oklch',
      ),
    ),
  )
}

const regionFor = (theme, continent) => {
  const band = continent === 'AN' ? ANTARCTICA_REGION[theme] : CONTINENT_REGION[theme]
  return formatHex(
    toRgb(
      clampChroma(
        { mode: 'oklch', l: band.l, c: band.c, h: CONTINENT_HUES[continent] ?? 250 },
        'oklch',
      ),
    ),
  )
}

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
    // Every direction, for the live comparison control. `fill` above is
    // the default direction.
    directions: Object.fromEntries(
      Object.keys(DIRECTIONS).map((name) => [
        name,
        {
          light: fillFor('light', tierIndex, hue, name),
          dark: fillFor('dark', tierIndex, hue, name),
        },
      ]),
    ),
  }
}

const continentRegions = Object.fromEntries(
  Object.keys(CONTINENT_HUES).map((key) => [
    key,
    { light: regionFor('light', key), dark: regionFor('dark', key) },
  ]),
)

// --- verification ----------------------------------------------------------

const report = { light: {}, dark: {}, directions: {} }
let hardFailures = 0

function verifyDirection(direction) {
  const out = { light: {}, dark: {} }
  const fillOf = (iso3, theme) => palette[iso3].directions[direction][theme]
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
        const d = deltaE(fillOf(entity.iso3, theme), fillOf(other, theme))
        pairDeltas.push(d)
        if (d < MIN_NEIGHBOUR_DE) {
          violations.push({ pair: key, deltaE: Number(d.toFixed(2)) })
        }
      }
    }

    const contrasts = entities.map((e) => ({
      iso3: e.iso3,
      ratio: contrast(fillOf(e.iso3, theme), surface),
    }))
    const lowContrast = contrasts.filter((c) => c.ratio < MIN_SURFACE_CONTRAST)

    // Light fills double as the globe's land colours; check them against
    // the globe ocean once (during the light pass).
    if (theme === 'light') {
      const oceanFailures = entities.filter(
        (e) => contrast(fillOf(e.iso3, 'light'), GLOBE_OCEAN) < MIN_OCEAN_CONTRAST,
      )
      out.globe = {
        ocean: GLOBE_OCEAN,
        minContrast: Number(
          Math.min(
            ...entities.map((e) => contrast(fillOf(e.iso3, 'light'), GLOBE_OCEAN)),
          ).toFixed(2),
        ),
        floor: MIN_OCEAN_CONTRAST,
        failures: oceanFailures.map((e) => e.iso3),
      }
      if (oceanFailures.length > 0) hardFailures += 1
    }

    pairDeltas.sort((a, b) => a - b)
    out[theme] = {
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
  return out
}

for (const direction of Object.keys(DIRECTIONS)) {
  report.directions[direction] = verifyDirection(direction)
}
// The top-level report describes the default direction (what `fill` is).
report.light = report.directions[DEFAULT_DIRECTION].light
report.dark = report.directions[DEFAULT_DIRECTION].dark
report.globe = report.directions[DEFAULT_DIRECTION].globe

// Continent regions: every region must clear the globe ocean and the water,
// and no two regions may sit within the neighbour floor of each other.
{
  const regionPairs = []
  const keys = Object.keys(continentRegions)
  for (let i = 0; i < keys.length; i += 1) {
    for (let j = i + 1; j < keys.length; j += 1) {
      for (const theme of ['light', 'dark']) {
        const d = deltaE(continentRegions[keys[i]][theme], continentRegions[keys[j]][theme])
        regionPairs.push({ pair: `${keys[i]}|${keys[j]}`, theme, deltaE: Number(d.toFixed(2)) })
      }
    }
  }
  const regionViolations = regionPairs.filter((p) => p.deltaE < MIN_NEIGHBOUR_DE)
  const oceanFailures = keys.filter(
    (k) => contrast(continentRegions[k].light, GLOBE_OCEAN) < MIN_OCEAN_CONTRAST,
  )
  report.continentRegions = {
    minDeltaE: Math.min(...regionPairs.map((p) => p.deltaE)),
    violations: regionViolations,
    oceanFailures,
  }
  if (regionViolations.length > 0 || oceanFailures.length > 0) hardFailures += 1
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
  ' *',
  ' * --fill-globe-* are the LIGHT fills, theme-invariant: the globe view is',
  ' * sunlit land on a dark ocean against space in both themes, so its land',
  ' * colours must not swap to the dark tiers, which would sink into the',
  ' * ocean colour.',
  ' *',
  ' * --fill-globe-<dir>-* are the per-DIRECTION light fills (atlas, paper);',
  ' * the map selects one by the "Map colours" control. --region-* are the',
  ' * continent-view fills.',
  ' */',
  ':root {',
  ...entities.map((e) => `  --fill-${e.iso3}: ${palette[e.iso3].fill.light};`),
  ...entities.map(
    (e) => `  --fill-globe-${e.iso3}: ${palette[e.iso3].fill.light};`,
  ),
  ...Object.keys(DIRECTIONS).flatMap((direction) =>
    entities.map(
      (e) =>
        `  --fill-globe-${direction}-${e.iso3}: ${palette[e.iso3].directions[direction].light};`,
    ),
  ),
  ...Object.keys(continentRegions).map(
    (k) => `  --region-${k}: ${continentRegions[k].light};`,
  ),
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
      directions: DIRECTIONS,
      defaultDirection: DEFAULT_DIRECTION,
      continentRegions,
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

for (const direction of Object.keys(DIRECTIONS)) {
  for (const theme of ['light', 'dark']) {
  const r = report.directions[direction][theme]
  console.log(`\n  ${direction.toUpperCase()} / ${theme.toUpperCase()}`)
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
}
console.log(
  `\n  continent regions: min pairwise dE ${report.continentRegions.minDeltaE} ` +
    `(${report.continentRegions.violations.length ? 'FAIL' : 'PASS'}), ` +
    `ocean failures ${report.continentRegions.oceanFailures.length}`,
)

const unsafeLight = Object.values(palette).filter(
  (p) => p.accent && !p.accent.rawSafeAsTextLight,
).length
console.log(
  `\n  ${unsafeLight} raw flag colours fail AA as text on the light surface; ` +
    `those render accent-only with a safe text step alongside.`,
)
console.log(`\n  wrote ${OUT_FILE}`)

process.exit(hardFailures > 0 ? 1 : 0)
