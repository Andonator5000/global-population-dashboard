import type { ContinentKey } from './config'

/** One row of data/entities.json -- the canonical registry from the ETL. */
export interface Entity {
  iso3: string
  iso2: string | null
  m49: number | null
  name_common: string
  name_official: string | null
  continent: ContinentKey
  continent_name: string
  un_member: boolean
  independent: boolean | null
  area_km2: number | null
  capital: string | null
  borders: string[]
  render: 'separate' | 'merged' | 'hidden'
  /** Non-null iff the entity's recognition status is contested. */
  status_label: string | null
  editorial_note: string | null
  continent_note: string | null
  factbook_path: string | null
  factbook_gec: string | null
  is_contested: boolean
}

/**
 * Provenance for one upstream source.
 *
 * The three dates are distinct and must be rendered distinctly:
 *   vintage          - the year the OBSERVATION describes (shown next to figures)
 *   upstream_release - when the publisher cut the release (null if not offered)
 *   fetched_at       - when we downloaded it. NOT a data date.
 */
export interface SourceRecord {
  title: string
  url: string
  licence: string
  fetched_at: string
  upstream_release: string | null
  vintage: string | null
  citation: string
  files: { url: string; sha256: string; size_bytes: number; fetched_at: string }[]
  notes: string | null
}

export interface ArtifactRecord {
  description: string
  sources: string[]
  row_count: number | null
  entity_count: number | null
}

export interface Manifest {
  manifest_version: number
  generated_at: string
  pipeline_version: string
  editorial_decisions_doc: string
  sources: Record<string, SourceRecord>
  artifacts: Record<string, ArtifactRecord>
  /** Non-fatal data-quality notes, surfaced in the freshness panel. */
  warnings: string[]
}

/**
 * A figure plus its provenance. Every number rendered in the app is wrapped in
 * one of these -- the brief makes untraceable figures non-negotiable, so the
 * type system is used to make an unattributed number awkward to construct.
 *
 * `value: null` means genuinely absent upstream and MUST render as an explicit
 * "not available from <source>" state -- never zero, never a blank chart.
 */
export interface Sourced<T> {
  value: T | null
  source: string
  vintage: string | null
  note?: string
}

/** One row of data/population/summary.json. */
export interface PopulationRow {
  iso3: string
  name: string
  continent: ContinentKey
  year: number
  available: boolean
  unavailableReason?: string
  population?: number | null
  growthRate?: number | null
  density?: number | null
  medianAge?: number | null
  fertilityRate?: number | null
  lifeExpectancy?: number | null
  births?: number | null
  deaths?: number | null
  netMigration?: number | null
}

export interface PopulationSummary {
  source: string
  revision: number
  variant: string
  year: number
  estimatesThrough: number
  latestProjectionYear: number
  units: Record<string, string>
  entities: PopulationRow[]
}

/** Properties the ETL stamps onto each TopoJSON geometry. */
export interface CountryGeometryProperties {
  iso3: string
  name: string
  continent: ContinentKey
  contested: boolean
}

/**
 * Minimal TopoJSON shape. topojson-client's own types are permissive about the
 * `properties` payload, so this narrows it to what the geometry stage writes.
 */
export interface CountryTopology {
  type: 'Topology'
  arcs: number[][][]
  transform?: { scale: [number, number]; translate: [number, number] }
  objects: {
    countries: {
      type: 'GeometryCollection'
      geometries: {
        type: string
        id?: string
        arcs: unknown
        properties: CountryGeometryProperties
      }[]
    }
    land: { type: string; arcs?: unknown }
  }
}

/** Populated entities too small to draw as polygons at 110m. */
export interface MapMarker {
  iso3: string
  name: string
  continent: ContinentKey
  /** GeoJSON order: [longitude, latitude]. */
  coordinates: [number, number]
  contested: boolean
}

export interface MarkerFile {
  note: string
  resolution: string
  markers: MapMarker[]
}

/**
 * Per-entity colour, from data/flags/map-palette.json.
 *
 * `fill` is the clamped map colour (flag hue at a graph-coloured lightness
 * tier). `accent` is the UNCLAMPED flag colour for the country detail page,
 * paired with a guaranteed-AA text step — 91 of 250 raw flag colours cannot
 * carry text at AA on the light surface, so `raw` is accent-only for those.
 */
export interface EntityPalette {
  iso3: string
  name: string
  hasFlagColour: boolean
  flagHue: number | null
  flag: { dominant: string; accents: string[] } | null
  tier: number
  fill: { light: string; dark: string }
  accent: {
    raw: string
    rawSafeAsTextLight: boolean
    rawSafeAsTextDark: boolean
    textLight: string
    textDark: string
    textLightContrast: number
    textDarkContrast: number
  } | null
}

export interface ContinentAccent {
  hue: number
  memberFlags: number
  light: string
  dark: string
}

/** data/population/series/<ISO3>.json */
export interface CountrySeries {
  iso3: string
  name: string
  wppLocationName: string
  revision: number
  variant: string
  estimatesThrough: number
  units: Record<string, string>
  years: number[]
  series: Record<string, (number | null)[]>
  bands?: {
    years: number[]
    low: (number | null)[]
    high: (number | null)[]
  }
}

/** data/population/pyramids/<ISO3>.json */
export interface CountryPyramid {
  iso3: string
  name: string
  revision: number
  variant: string
  units: string
  ageGroups: string[]
  years: number[]
  frames: Record<string, { male: (number | null)[]; female: (number | null)[] }>
}

/** One indicator inside data/indicators/by-country/<ISO3>.json */
export interface IndicatorSeries {
  label: string
  section: string
  unit: string
  available: boolean
  unavailableReason?: string
  /** `year` is THIS indicator's vintage; it differs across indicators. */
  latest: { year: number; value: number } | null
  years: number[]
  values: number[]
}

export interface CountryIndicators {
  iso3: string
  name: string
  source: string
  indicators: Record<string, IndicatorSeries>
}

/** data/factbook/<ISO3>.json */
export interface FactbookField {
  available: boolean
  unavailableReason?: string
  text?: string
  vintageYear?: number | null
  vintageQualifier?: string | null
  note?: string | null
  items?: string[]
}

export interface FactbookRecord {
  iso3: string
  name: string
  source: string
  factbookGec: string
  people: {
    ethnicGroups: import('./components/viz/CompositionBar').CompositionField
    religions: import('./components/viz/CompositionBar').CompositionField
    languages: import('./components/viz/CompositionBar').CompositionField
  }
  government: Record<string, FactbookField>
  economy: {
    industries: FactbookField
    agriculturalProducts: FactbookField
    exportCommodities: FactbookField
    exportPartners: import('./components/viz/CompositionBar').CompositionField
    importPartners: import('./components/viz/CompositionBar').CompositionField
  }
}

/**
 * data/population/timeline.json
 *
 * Values are in THOUSANDS (UN WPP's publication precision) to keep the payload
 * small; multiply by 1000 for persons. Lazy-loaded — the map's first paint
 * does not need it.
 */
export interface PopulationTimeline {
  note: string
  revision: number
  variant: string
  unit: string
  estimatesThrough: number
  years: number[]
  world: number[]
  worldEntityCount: number[]
  /** Births, deaths and net migration summed worldwide, in thousands/year. */
  worldComponents: Record<string, number[]>
  continents: Record<string, number[]>
  entities: Record<string, (number | null)[]>
}

/** data/biomes/biomes.json */
export interface BiomeShare {
  biome: string
  areaKm2: number
  share: number
}

export interface BiomeEntity {
  iso3: string
  name: string
  landAreaKm2: number
  biomes: BiomeShare[]
  topEcoregions: { name: string; areaKm2: number; share: number }[]
  /** Sum of shares. Below 100 means part of the polygon has no ecoregion. */
  coveredShare: number
  withinTolerance: boolean
}

export interface BiomeContinent {
  continent: string
  name: string
  landAreaKm2: number
  biomes: BiomeShare[]
  coveredShare: number
  memberEntitiesWithBiomeData: number
}

export interface BiomeFile {
  note: string
  equalAreaCrs: string
  simplifyToleranceM: number
  shareTolerancePct: number
  biomeNames: string[]
  entitiesWithData: number
  validationFailures: {
    iso3: string
    name: string
    coveredShare: number
    gap: number
  }[]
  entities: Record<string, BiomeEntity>
  continents: Record<string, BiomeContinent>
}

export interface MapPalette {
  note: string
  minNeighbourDeltaE: number
  verification: Record<
    string,
    {
      borderPairs: number
      minDeltaE: number
      medianDeltaE: number
      violations: { pair: string; deltaE: number }[]
      minSurfaceContrast: number
      lowContrastEntities: string[]
    }
  >
  continentAccent: Record<string, ContinentAccent>
  entities: Record<string, EntityPalette>
}
