/**
 * Contrast gate for the theme tokens.
 *
 * "Contrast passes AA in light and dark" is an acceptance criterion, so it gets
 * a script rather than an eyeball. Run with `npm run check:contrast`; it exits
 * non-zero on any failure, which makes it usable as a CI gate.
 *
 * The token values here MUST mirror src/index.css and src/map-theme.css. They
 * are duplicated deliberately: importing CSS custom properties into Node means
 * parsing CSS, and a drifted copy that fails loudly beats a clever loader that
 * silently checks nothing.
 */
import { converter, formatHex, parse } from 'culori'

const rgb = converter('rgb')

function relativeLuminance(color) {
  const channel = (v) =>
    v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  return (
    0.2126 * channel(color.r) +
    0.7152 * channel(color.g) +
    0.0722 * channel(color.b)
  )
}

function contrast(a, b) {
  const la = relativeLuminance(rgb(parse(a)))
  const lb = relativeLuminance(rgb(parse(b)))
  const [hi, lo] = la > lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

const hex = (value) => formatHex(rgb(parse(value)))

// Theme-invariant tokens (declared once in :root, inherited by dark).
const INVARIANT = {
  brandBg: 'oklch(44% 0.12 155)',
  brandText: 'oklch(100% 0 0)',
  mapSpace: 'oklch(8% 0.005 260)',
  mapOcean: 'oklch(31% 0.06 255)',
}

const THEMES = {
  light: {
    surface: 'oklch(99% 0.002 250)',
    raised: 'oklch(100% 0 0)',
    pageTint: 'oklch(95.5% 0.035 250)',
    border: 'oklch(90% 0.004 250)',
    text: 'oklch(22% 0.008 250)',
    textMuted: 'oklch(45% 0.008 250)',
    accent: 'oklch(52% 0.13 250)',
    mapWater: 'oklch(98% 0.010 235)',
    mapLand: 'oklch(84% 0.014 250)',
    mapLandStroke: 'oklch(98% 0.010 235)',
    mapAccentFill: 'oklch(70% 0.13 250)',
    mapNoData: 'oklch(92% 0.003 250)',
    controlSelectedBg: 'oklch(88% 0.065 250)',
    controlSelectedText: 'oklch(25% 0.02 250)',
  },
  dark: {
    surface: 'oklch(17% 0.006 250)',
    raised: 'oklch(21% 0.007 250)',
    pageTint: 'oklch(21% 0.025 250)',
    border: 'oklch(31% 0.008 250)',
    text: 'oklch(94% 0.003 250)',
    textMuted: 'oklch(72% 0.006 250)',
    accent: 'oklch(76% 0.11 250)',
    mapWater: 'oklch(13% 0.010 235)',
    mapLand: 'oklch(34% 0.014 250)',
    mapLandStroke: 'oklch(13% 0.010 235)',
    mapAccentFill: 'oklch(60% 0.13 250)',
    mapNoData: 'oklch(22% 0.004 250)',
    controlSelectedBg: 'oklch(38% 0.075 250)',
    controlSelectedText: 'oklch(96% 0.005 250)',
  },
}

/** [label, foreground, background, minimum ratio] */
const checks = (t) => [
  // WCAG AA text
  ['body text on surface', t.text, t.surface, 4.5],
  ['body text on raised', t.text, t.raised, 4.5],
  // Tinted page backgrounds (home page and flag-tinted country pages sit at
  // the same lightness/chroma band as this token).
  ['body text on page tint', t.text, t.pageTint, 4.5],
  ['muted text on page tint', t.textMuted, t.pageTint, 4.5],
  // Brand button and globe-view tokens are theme-invariant.
  ['brand button label', INVARIANT.brandText, INVARIANT.brandBg, 4.5],
  ['globe ocean vs space', INVARIANT.mapOcean, INVARIANT.mapSpace, 1.5],
  ['muted text on surface', t.textMuted, t.surface, 4.5],
  ['muted text on raised', t.textMuted, t.raised, 4.5],
  ['link/accent text on surface', t.accent, t.surface, 4.5],
  // WCAG AA non-text (UI components, focus indicator)
  ['focus ring vs surface', t.accent, t.surface, 3.0],
  ['border vs surface', t.border, t.surface, 1.2],
  // Map legibility. Land/water and hover/rest are shape-and-state boundaries
  // rather than text, so they carry perceptual minimums, not WCAG ones.
  //
  // These floors were RAISED after looking at the rendered map: the original
  // 1.2 land-vs-water floor passed a coastline so faint the continents washed
  // into the ocean. The lesson is in the skill's step 7 -- the validator checks
  // colour, not whether the thing reads. Look at it, then set the number.
  ['map land vs water', t.mapLand, t.mapWater, 1.5],
  ['map land vs country stroke', t.mapLand, t.mapLandStroke, 1.5],
  ['map hover fill vs land', t.mapAccentFill, t.mapLand, 1.5],
  ['map hover fill vs water', t.mapAccentFill, t.mapWater, 1.5],
  ['map no-data vs water', t.mapNoData, t.mapWater, 1.08],
  ['map no-data vs land', t.mapNoData, t.mapLand, 1.08],
  // Selected toggle state. Added after an in-browser audit caught the active
  // "Country" button at 3.3:1 in dark mode -- it was reusing the map fill
  // token, which is tuned for polygons that carry no text.
  ['selected control label', t.controlSelectedText, t.controlSelectedBg, 4.5],
  ['selected control vs surface', t.controlSelectedBg, t.surface, 1.2],
]

let failures = 0
for (const [mode, tokens] of Object.entries(THEMES)) {
  console.log(`\n===== ${mode.toUpperCase()} =====`)
  for (const [name, value] of Object.entries(tokens)) {
    console.log(`  ${name.padEnd(15)} ${hex(value)}`)
  }
  console.log('')
  for (const [label, fg, bg, min] of checks(tokens)) {
    const ratio = contrast(fg, bg)
    const ok = ratio >= min
    if (!ok) failures += 1
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(30)} ` +
        `${ratio.toFixed(2)}  (min ${min})`,
    )
  }
}

console.log(
  failures === 0
    ? '\nAll contrast checks passed.'
    : `\n${failures} contrast check(s) FAILED.`,
)
process.exit(failures === 0 ? 0 : 1)
