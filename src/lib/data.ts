import { useEffect, useState } from 'react'

import { DATA_BASE_URL } from '../config'
import type {
  BiomeFile,
  CountryIndicators,
  CountryOwid,
  CountryPyramid,
  CountrySeries,
  CountryTopology,
  Entity,
  FactbookRecord,
  GdpSummary,
  HeritageFile,
  LeadersFile,
  Manifest,
  MapPalette,
  MarkerFile,
  PopulationSummary,
  PopulationTimeline,
} from '../types'

/**
 * Loads a committed ETL artifact from /data.
 *
 * These are static files produced by the pipeline, not live API calls -- the
 * app never talks to an upstream source at render time. Responses are cached
 * per-URL for the session because artifacts are immutable between deploys.
 */
const cache = new Map<string, Promise<unknown>>()

function loadArtifact<T>(filename: string): Promise<T> {
  const url = `${DATA_BASE_URL}/${filename}`
  let pending = cache.get(url) as Promise<T> | undefined
  if (!pending) {
    pending = fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(
          `Could not load ${filename} (HTTP ${response.status}). ` +
            `Run \`python etl/run.py\` to regenerate /data.`,
        )
      }
      return response.json() as Promise<T>
    })
    cache.set(url, pending)
  }
  return pending
}

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'error'; error: Error }
  | { status: 'ready'; data: T }

function useArtifact<T>(filename: string): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    loadArtifact<T>(filename)
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [filename])

  return state
}

export const useEntities = (): AsyncState<Entity[]> =>
  useArtifact<Entity[]>('entities.json')

export const useManifest = (): AsyncState<Manifest> =>
  useArtifact<Manifest>('manifest.json')

export const usePopulationSummary = (): AsyncState<PopulationSummary> =>
  useArtifact<PopulationSummary>('population/summary.json')

export const useCountryTopology = (): AsyncState<CountryTopology> =>
  useArtifact<CountryTopology>('geo/countries-110m.json')

export const useMapMarkers = (): AsyncState<MarkerFile> =>
  useArtifact<MarkerFile>('geo/markers.json')

export const useMapPalette = (): AsyncState<MapPalette> =>
  useArtifact<MapPalette>('flags/map-palette.json')

export const useBiomes = (): AsyncState<BiomeFile> =>
  useArtifact<BiomeFile>('biomes/biomes.json')

export const useHeritage = (): AsyncState<HeritageFile> =>
  useArtifact<HeritageFile>('heritage/sites.json')

export const useGdpSummary = (): AsyncState<GdpSummary> =>
  useArtifact<GdpSummary>('indicators/gdp-summary.json')

export const useLeaders = (): AsyncState<LeadersFile> =>
  useArtifact<LeadersFile>('leaders/leaders.json')

/**
 * Year-by-year population, fetched when `enabled` becomes true.
 *
 * The home page passes `true` immediately, because the live counter needs two
 * annual anchors to interpolate between and the summary artifact only carries
 * one year. At 181 KB (about 60 KB over the wire) that is an acceptable cost
 * for the hero figure; the `enabled` flag remains so other callers can defer
 * it.
 */
export function usePopulationTimeline(
  enabled: boolean,
): AsyncState<PopulationTimeline | null> {
  const [state, setState] = useState<AsyncState<PopulationTimeline | null>>({
    status: 'ready',
    data: null,
  })

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    setState({ status: 'loading' })
    loadArtifact<PopulationTimeline>('population/timeline.json')
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [enabled])

  return state
}

/**
 * Per-country artifacts, loaded on demand.
 *
 * These are deliberately NOT bundled into one file: the map only needs the
 * summary, and pulling 14 MB of per-country detail to paint the home page
 * would blow the interaction budget.
 *
 * A 404 here is an expected state, not a failure -- 8 entities have no
 * Factbook entry and 13 have no WPP series. The hook resolves to `null` so the
 * page can render an explicit "not published" section rather than an error.
 */
function useOptionalArtifact<T>(path: string | null): AsyncState<T | null> {
  const [state, setState] = useState<AsyncState<T | null>>({ status: 'loading' })

  useEffect(() => {
    if (!path) {
      setState({ status: 'ready', data: null })
      return
    }
    let cancelled = false
    loadArtifact<T>(path)
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data })
      })
      .catch(() => {
        // Absent upstream, not broken. The caller renders it as such.
        if (!cancelled) setState({ status: 'ready', data: null })
      })
    return () => {
      cancelled = true
    }
  }, [path])

  return state
}

export const useCountrySeries = (iso3: string | undefined) =>
  useOptionalArtifact<CountrySeries>(
    iso3 ? `population/series/${iso3}.json` : null,
  )

export const useCountryPyramid = (iso3: string | undefined) =>
  useOptionalArtifact<CountryPyramid>(
    iso3 ? `population/pyramids/${iso3}.json` : null,
  )

export const useCountryIndicators = (iso3: string | undefined) =>
  useOptionalArtifact<CountryIndicators>(
    iso3 ? `indicators/by-country/${iso3}.json` : null,
  )

export const useCountryFactbook = (iso3: string | undefined) =>
  useOptionalArtifact<FactbookRecord>(iso3 ? `factbook/${iso3}.json` : null)

export const useCountryOwid = (iso3: string | undefined) =>
  useOptionalArtifact<CountryOwid>(iso3 ? `owid/by-country/${iso3}.json` : null)
