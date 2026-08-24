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
  /** [{code, name, symbol}] from the metadata source; may be empty. */
  currencies: { code: string; name: string | null; symbol: string | null }[]
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
  /** How often the data is re-checked, and when a change is committed. */
  refresh_policy?: string
  /**
   * SHA-256 of every artifact except the manifest itself. Lets the monthly
   * refresh distinguish a real data change from a manifest carrying nothing
   * but new timestamps.
   */
  content_fingerprint?: string | null
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
  /** Path of the committed flag SVG relative to /data, or null if none. */
  flagSvg: string | null
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

/**
 * One series inside data/owid/by-country/<ISO3>.json.
 *
 * Same shape as IndicatorSeries plus provenance that names the underlying
 * producer (V-Dem, Global Carbon Budget, ...) — OWID is the distribution
 * channel, and the citation must say who made the measurement.
 */
export interface OwidIndicatorSeries extends IndicatorSeries {
  kind: 'number' | 'category'
  citation: string
}

export interface CountryOwid {
  iso3: string
  name: string
  source: string
  indicators: Record<string, OwidIndicatorSeries>
}

/** data/indicators/gdp-summary.json — latest GDP per entity for the table. */
export interface GdpSummary {
  source: string
  indicator: string
  label: string
  note: string
  entities: Record<string, { value: number; year: number } | null>
}

/** data/leaders/leaders.json — heads of state/government with portraits. */
export interface LeaderRecord {
  name: string | null
  /** Number of truthy office-holders; >1 means a collective office, no photo. */
  holders: number
  image: string | null
  commonsPage: string | null
}

export interface LeadersFile {
  note: string
  source: string
  imageWidth: number
  entities: Record<string, { hos?: LeaderRecord; hog?: LeaderRecord }>
}

/** One property in data/heritage/sites.json. */
export interface HeritageSite {
  name: string
  category: 'Cultural' | 'Natural' | 'Mixed' | null
  year: number | null
  danger: boolean
  /** Shared across several states; appears under each of them. */
  transnational: boolean
  url: string | null
}

export interface HeritageFile {
  note: string
  source: string
  totalSites: number
  entities: Record<string, { count: number; sites: HeritageSite[] }>
}

/** data/factbook/<ISO3>.json */
export interface FactbookField {
  available: boolean
  unavailableReason?: string
  text?: string
  /**
   * Descriptive phrases the source mixed into a list field ("highly
   * diversified, world leading..."), separated by the ETL so they render as
   * prose instead of bullet items.
   */
  summary?: string | null
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
  /**
   * Set when the drawn polygon disagrees with the published land area by more
   * than 25% — a boundary-definition difference, not a measurement error.
   */
  areaDiffersFromPublishedPct?: number
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

/** data/freedom/press-freedom.json — RSF World Press Freedom Index. */
export interface PressFreedomFile {
  source: string
  year: number
  scale: string
  rankedCountries: number
  entities: Record<string, { score: number; rank: number }>
}

/** data/crime/unodc-prisons.json */
export interface UnodcPrisonsFile {
  source: string
  note: string
  entities: Record<
    string,
    {
      prisoners?: { value: number; year: number }
      facilities?: { value: number; year: number }
    }
  >
}

/** data/crime/death-penalty.json */
export interface DeathPenaltyFile {
  source: string
  statusLabels: Record<string, string>
  executionsYear: number | null
  note: string
  entities: Record<
    string,
    {
      status: 'A' | 'E' | 'L' | 'P'
      statusLabel: string
      retained: boolean
      lastExecutionYear?: number
      abolishedYear?: number
      /** Verbatim Amnesty figure — may be "972+", "1,000s", never parsed. */
      recentExecutions?: string
    }
  >
}

/** data/education/education.json */
export interface EducationFile {
  cwurYear: number
  notes: Record<string, string>
  entities: Record<
    string,
    {
      universities?: number
      publicLibraries?: number
      topUniversities?: {
        name: string
        worldRank: number
        nationalRank: number
      }[]
    }
  >
}

/** data/economy/debt.json — IMF WEO series incl. projections. */
export interface DebtFile {
  source: string
  projectionsFrom: number
  note: string
  entities: Record<
    string,
    {
      debtPctGdp?: { years: number[]; values: number[] }
      gdpUsdBillions?: { years: number[]; values: number[] }
    }
  >
}

/** data/economy/currency-images.json */
export interface CurrencyImagesFile {
  source: string
  note: string
  currencies: Record<
    string,
    {
      name: string
      file: string
      imageUrl: string
      commonsPage: string
      license: string | null
      author: string | null
      curated: boolean
    }
  >
}

/** data/subdivisions/<ISO3>.json */
export interface SubdivisionsFile {
  iso3: string
  name: string
  source: string
  note: string
  divisions: { name: string; population: number | null; qid: string }[]
}

/** data/climate/climate.json */
export interface ClimateFile {
  source: string
  citation: string
  note: string
  entities: Record<
    string,
    {
      latestTempC: { year: number; value: number }
      warming?: { value: number; baseline: string; recent: string }
    }
  >
}

/** data/climate/capitals.json */
export interface CapitalsFile {
  source: string
  note: string
  entities: Record<
    string,
    { name: string; lat: number; lon: number; population: number }
  >
}

/** A hotlinked Commons image plus the attribution its licence requires. */
export interface CommonsImage {
  imageUrl: string
  commonsPage: string
  license: string | null
  author: string | null
}

/** data/inventions/<ISO3>.json */
export interface InventionsFile {
  iso3: string
  name: string
  source: string
  note: string
  inventions: {
    name: string
    inventors?: string[]
    year?: number
    image?: CommonsImage
  }[]
}

/** data/airports/<ISO3>.json */
export interface AirportsFile {
  iso3: string
  name: string
  source: string
  note: string
  airports: {
    name: string
    iata: string | null
    municipality: string | null
    large: boolean
    passengers: number | null
  }[]
}

/** data/flora-fauna/<ISO3>.json */
export interface FloraFaunaSymbol {
  name: string
  type?: string
  scientificName?: string
  image?: CommonsImage
}

export interface FloraFaunaFile {
  iso3: string
  name: string
  source: string
  note: string
  animals?: FloraFaunaSymbol[]
  tree?: FloraFaunaSymbol
  flower?: FloraFaunaSymbol
}

/** data/cuisine/<ISO3>.json */
export interface CuisineFile {
  iso3: string
  name: string
  source: string
  note: string
  dishes: { name: string; image?: CommonsImage }[]
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
