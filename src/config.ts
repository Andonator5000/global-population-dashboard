/**
 * App-side configuration.
 *
 * Mirrors the editorial constants in etl/config.py. Where a value must agree
 * across both (continent keys above all), the ETL is authoritative and this
 * file follows -- entities.json carries the continent key on every row, so a
 * drift here shows up immediately as an unknown-continent lookup rather than
 * as quietly miscounted totals.
 */

export const CONTINENTS = {
  AF: 'Africa',
  AN: 'Antarctica',
  AS: 'Asia',
  EU: 'Europe',
  NA: 'North America',
  OC: 'Oceania',
  SA: 'South America',
} as const

export type ContinentKey = keyof typeof CONTINENTS

/**
 * Map projection. Equal Earth is the default and the only one the design has
 * been checked against; mollweide and eckert4 are equal-area alternatives
 * kept swappable per the brief. Mercator is deliberately absent -- it is not
 * equal-area, and "Greenland reads visibly smaller than Africa" is an
 * acceptance criterion.
 *
 * 'globe' (orthographic, drag to rotate) is a PERSPECTIVE view, not an
 * equal-area projection: shapes foreshorten toward the horizon exactly as a
 * physical globe does. It was added on request (2026-08-15) as an optional
 * view; the flat defaults remain equal-area and the equal-area gates are
 * checked against them.
 */
export const PROJECTIONS = ['equalEarth', 'mollweide', 'eckert4', 'globe'] as const
export type ProjectionKey = (typeof PROJECTIONS)[number]

// Globe by default (2026-08-16, maintainer request); the equal-area flat
// projections remain one click away and keep their acceptance gates.
export const DEFAULT_PROJECTION: ProjectionKey = 'globe'

/**
 * Map colour directions (2026-08-29, Phase 2.4). Both are built and gated
 * by scripts/build-map-palette.mjs; the control on the home page switches
 * between them live. 'atlas' is the default.
 */
export const MAP_PALETTES = [
  'atlas',
  'paper',
  'antique',
  'pastel',
  'nautical',
  'mono',
] as const
export type MapPaletteKey = (typeof MAP_PALETTES)[number]
export const DEFAULT_MAP_PALETTE: MapPaletteKey = 'atlas'
export const MAP_PALETTE_LABELS: Record<MapPaletteKey, string> = {
  atlas: 'Atlas — restrained flag hues',
  paper: 'Paper — near-neutral tints',
  antique: 'Antique — parchment sepia',
  pastel: 'Vintage pastel',
  nautical: 'Old nautical — chart blues',
  mono: 'Monochrome (colour-blind-safe)',
}

/**
 * Base views for the country map (round-2 §37): political fills, Blue
 * Marble satellite imagery, or the hypsometric terrain relief.
 */
export const BASE_VIEWS = ['political', 'satellite', 'terrain'] as const
export type BaseViewKey = (typeof BASE_VIEWS)[number]
export const BASE_VIEW_LABELS: Record<BaseViewKey, string> = {
  political: 'Political',
  satellite: 'Satellite',
  terrain: 'Terrain',
}

/**
 * Top-level site sections (2026-09-05, Phase 2 design pass). The header
 * renders from this registry so adding a section (Biology, Space, …) is one
 * entry here plus a contrast-gated colour token pair in index.css — not
 * header surgery. Each section owns a hue so the buttons stay tellable at a
 * glance as the list grows; every pair must clear AA (check:contrast).
 */
export type SiteSection = {
  path: string
  label: string
  /** Themed nav-accent custom property, contrast-gated in index.css (§34). */
  accent: string
  /** Match only the exact path — the root section would otherwise claim every route. */
  end?: boolean
}

/**
 * Round-2 IA (2026-09, §34): Biology is gone as a grouping level; Taxonomy
 * and Evolution are top-level pages. Old /biology/* paths redirect in
 * App.tsx so bookmarks survive.
 */
export const SECTIONS: readonly SiteSection[] = [
  { path: '/', label: 'Global Data', accent: 'var(--nav-globaldata)', end: true },
  { path: '/history', label: 'Human History', accent: 'var(--nav-history)' },
  { path: '/taxonomy', label: 'Taxonomy', accent: 'var(--nav-taxonomy)' },
  { path: '/evolution', label: 'Evolution', accent: 'var(--nav-evolution)' },
  { path: '/space', label: 'Space', accent: 'var(--nav-space)' },
]

/** Continents excluded from per-capita, density, and population rankings. */
export const UNINHABITED_CONTINENTS: readonly ContinentKey[] = ['AN']

/**
 * Where the committed ETL artifacts are served from.
 *
 * Derived from Vite's BASE_URL rather than hardcoded to "/data", because
 * GitHub Pages serves this project from /<repo>/ and a root-absolute path
 * would 404 for every artifact — producing a page that renders its chrome and
 * then silently shows nothing. BASE_URL always carries a trailing slash.
 */
export const DATA_BASE_URL = `${import.meta.env.BASE_URL}data`
