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
