/**
 * Decorative icons for categorical data: biomes, GDP sectors, Factbook
 * industries / agricultural products / export commodities, and religions.
 *
 * ONE icon set (2026-08-29, maintainer request): OpenMoji's black-outline
 * variant, vendored as SVG under public/icons/openmoji and painted in
 * currentColor through <Icon>. Every function here returns an OpenMoji
 * HEXCODE (or null), never a glyph -- the previous emoji approach rendered
 * in whatever style the viewer's platform shipped and had no coverage for
 * most industrial terms.
 *
 * Product icons come from the curated table in src/data/product-icons.json,
 * built from the full list of distinct Factbook item strings. A miss gets
 * the closest CATEGORY icon (crop, mineral, factory...) and is reported by
 * `npm run check:icons`; there is no gear catch-all. Icons are ALWAYS
 * decoration -- aria-hidden at the call site, never the only carrier of
 * meaning.
 */

import table from '../data/product-icons.json'

export type IconTier = 'exact' | 'category'

export interface IconMatch {
  /** OpenMoji hexcode; null means "no icon, labelled chip only". */
  code: string | null
  /** OpenMoji annotation, for titles and debugging. */
  name: string
  tier: IconTier
}

/** RESOLVE Ecoregions 2017 biome names, matched exactly. */
const BIOME_ICONS: Record<string, string> = {
  'Boreal Forests/Taiga': '1F332',
  'Deserts & Xeric Shrublands': '1F3DC',
  'Flooded Grasslands & Savannas': '1FAB7',
  Mangroves: '1F33F',
  'Mediterranean Forests, Woodlands & Scrub': '1FAD2',
  'Montane Grasslands & Shrublands': '26F0',
  'Rock, ice and inland water': '1F9CA',
  'Temperate Broadleaf & Mixed Forests': '1F333',
  'Temperate Conifer Forests': '1F332',
  'Temperate Grasslands, Savannas & Shrublands': '1F33E',
  'Tropical & Subtropical Coniferous Forests': '1F332',
  'Tropical & Subtropical Dry Broadleaf Forests': '1F342',
  'Tropical & Subtropical Grasslands, Savannas & Shrublands': '1F992',
  'Tropical & Subtropical Moist Broadleaf Forests': '1F334',
  Tundra: '2744',
}

export function biomeIcon(name: string): string | null {
  return BIOME_ICONS[name] ?? null
}

/** GDP value-added sectors. */
const SECTOR_ICONS: Record<string, string> = {
  Agriculture: '1F33E',
  Industry: '1F3ED',
  Services: '1F4BC',
}

export function sectorIcon(label: string): string | null {
  return SECTOR_ICONS[label] ?? null
}

interface Rule {
  regex: RegExp
  code: string | null
  name: string
  tier: IconTier
}

const PRODUCT_RULES: Rule[] = (
  table.rules as [string, string | null, string, string][]
).map(([source, code, name, tier]) => ({
  regex: new RegExp(source, 'i'),
  code,
  name,
  tier: tier as IconTier,
}))

const CATEGORY_FALLBACKS: Rule[] = Object.entries(table.categoryFallbacks)
  .filter(([key]) => !key.startsWith('_'))
  .map(([, value]) => {
    const [source, code, name] = value as [string, string, string]
    return { regex: new RegExp(source, 'i'), code, name, tier: 'category' as const }
  })

/**
 * Display renames for individual list items, applied AT RENDER only -- the
 * committed artifact keeps the source wording. Keys are lowercase.
 */
const ITEM_RENAMES: Record<string, string> = {
  cars: 'motor vehicles',
}

export function itemDisplayName(item: string): string {
  return ITEM_RENAMES[item.toLowerCase()] ?? item
}

/** First matching rule, then the coarse category fallback, then null. */
export function productIcon(item: string): IconMatch | null {
  const needle = item.toLowerCase()
  for (const rule of PRODUCT_RULES) {
    if (rule.regex.test(needle)) {
      return { code: rule.code, name: rule.name, tier: rule.tier }
    }
  }
  for (const rule of CATEGORY_FALLBACKS) {
    if (rule.regex.test(needle)) {
      return { code: rule.code, name: rule.name, tier: rule.tier }
    }
  }
  return null
}

/**
 * Human History timeline categories (Phase 3). Crossed swords stand for
 * wars: no open icon set draws a sword crossed with a gun, and the
 * crossed-swords glyph is the conventional conflict mark.
 */
const HISTORY_CATEGORY_ICONS: Record<string, string> = {
  'evolution-prehistory': '1F9EC', // dna
  'invention-technology': '1F6E0', // hammer and wrench
  'scientific-discovery': '1F4A1', // light bulb
  'other-discovery': '1F9ED', // compass
  'war-conflict': '2694', // crossed swords
  religion: '1F6D0', // place of worship
  'rights-document': '1F4DC', // scroll
}

export function historyCategoryIcon(category: string): string | null {
  return HISTORY_CATEGORY_ICONS[category] ?? null
}

/** Religion keyword rules; first match wins. */
const RELIGION_RULES: [RegExp, string][] = [
  [/catholic|christian|protestant|orthodox|anglican|evangelical|methodist|baptist|lutheran|presbyterian|pentecostal|adventist|church|mormon|latter[- ]day/, '271D'],
  [/muslim|islam|sunni|shia|shi'a|ibadhi/, '262A'],
  [/jewish|judaism/, '2721'],
  [/hindu/, '1F549'],
  [/buddhis/, '2638'],
  [/sikh/, '1FAAF'],
  [/shinto/, '26E9'],
  [/tao|daois|confucian|chinese folk/, '262F'],
  [/baha'?i/, '2734'],
  [/folk|animis|traditional|indigenous|spiritis|vodou|voodoo|shaman/, '1FA98'],
  [/\bnone\b|atheis|agnosti|unaffiliated|no religion|secular/, '26AA'],
  // Catch-alls LAST: "Other Christian" must match the Christian rule above
  // before "other" can claim it.
  [/unspecified|don'?t know|refused|no answer|undeclared|\bother\b|smaller categories/, '2753'],
]

export function religionIcon(label: string): string | null {
  const needle = label.toLowerCase()
  for (const [pattern, code] of RELIGION_RULES) {
    if (pattern.test(needle)) return code
  }
  return null
}
