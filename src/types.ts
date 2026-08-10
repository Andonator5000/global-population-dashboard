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
