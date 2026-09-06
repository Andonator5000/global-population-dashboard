/**
 * Loaders for the map detail artifacts (Phase 4, DATA_DECISIONS.md §30):
 * admin-1 borders and labels, lakes, rivers, populated places, and the
 * terrain tier index. Everything is fetched lazily -- the world view costs
 * nothing; layers arrive as the zoom crosses their thresholds -- and each
 * fetch happens at most once per session (module-level promise cache).
 */

import { DATA_BASE_URL } from '../config'

export interface DetailFeature {
  type: 'Feature'
  properties: { name?: string; rank?: number }
  geometry: unknown
}

export interface DetailCollection {
  type: 'FeatureCollection'
  features: DetailFeature[]
}

export interface Admin1Label {
  name: string
  a0: string
  lon: number
  lat: number
}

export interface PlacePoint {
  name: string
  lon: number
  lat: number
  rank: number
  pop?: number
  cap?: 1
}

export interface TerrainTier {
  level: number
  width: number
  height: number
  cols: number
  rows: number
  tile_px: number
  tiles: string[]
}

export interface TerrainMeta {
  source: string
  vintage: string
  attribution: string
  tiers: TerrainTier[]
}

export type DetailLayerKey =
  | 'admin1-lines'
  | 'lakes-50m'
  | 'lakes-10m'
  | 'rivers-50m'
  | 'rivers-10m'

const cache = new Map<string, Promise<unknown>>()

function loadJson<T>(path: string): Promise<T> {
  let pending = cache.get(path)
  if (!pending) {
    pending = fetch(`${DATA_BASE_URL}/${path}`).then((response) => {
      if (!response.ok) {
        // Drop the failed promise so a transient error can be retried on
        // the next zoom crossing instead of poisoning the session.
        cache.delete(path)
        throw new Error(`${path}: HTTP ${response.status}`)
      }
      return response.json()
    })
    cache.set(path, pending)
  }
  return pending as Promise<T>
}

export const loadDetailLayer = (key: DetailLayerKey) =>
  loadJson<DetailCollection>(`geo/detail/${key}.json`)

export const loadAdmin1Labels = () =>
  loadJson<Admin1Label[]>('geo/detail/admin1-labels.json')

export const loadPlaces = () => loadJson<PlacePoint[]>('geo/detail/places.json')

export const loadTerrainMeta = (base: string) =>
  loadJson<TerrainMeta>(`${base}/meta.json`)

export const terrainTileUrl = (base: string, name: string) =>
  `${DATA_BASE_URL}/${base}/${name}`
