/**
 * Loaders and types for the Space section (Phase 7, DATA_DECISIONS.md §33).
 */

import { useEffect, useState } from 'react'

import { DATA_BASE_URL } from '../config'
import type { AsyncState } from './data'

export interface BodyFacts {
  massKg?: number | null
  equatorialRadiusKm?: number | null
  densityKgM3?: number | null
  gravityMS2?: number | null
  escapeKmS?: number | null
  rotationPeriodHours?: number | null
  semimajorAxisKm?: number | null
  semimajorAxisAu?: number | null
  orbitalPeriodDays?: number | null
  eccentricity?: number | null
  axialTiltDeg?: number | null
  meanTempK?: number | null
}

export interface BodyImage {
  url: string
  title: string | null
  nasaId: string | null
  page: string
  credit: string
}

export interface BodyNotes {
  naming: string
  atmosphere: string
  features: string
  missions: string
  source: string
}

export interface TrekLayer {
  urlTemplate: string
  ext: string
  credit: string
}

export interface SpaceBody {
  id: string
  name: string
  kind: 'star' | 'planet' | 'dwarf' | 'moon'
  primary: string | null
  facts: BodyFacts
  moonCount: number | null
  source: string | null
  vintage: string | null
  links: { wikipedia: string }
  image: BodyImage | null
  discovery?: { by: string; year: number }
  /** Round-2 §41: committed CC-BY texture path under /data, or null. */
  texture?: string | null
  /** 8k variant for the full-screen globe view only (round-2 feedback). */
  texture8k?: string | null
  notes?: BodyNotes
  /** NASA Trek WMTS layer for deep-zoom globes (streamed at runtime). */
  trek?: TrekLayer
}

export interface NomenclatureFeature {
  name: string
  lat: number
  lon: number
  dKm: number
  type: string | null
  /** Naming origin, e.g. '"Ocean of Storms."' or the person honoured. */
  origin: string | null
  /** IAU approval year. */
  approved: string | null
  /** Cultural/linguistic origin of the name (gazetteer "ethnicity"). */
  culture: string | null
  /** USGS Gazetteer feature page. */
  link: string | null
}

export interface Nomenclature {
  target: string
  features: NomenclatureFeature[]
}

/** Plain-language gloss for IAU feature-type descriptors, keyed on the
    first word of the gazetteer type string ("Mons, montes" -> "mons"). */
const FEATURE_TYPE_GLOSS: Record<string, string> = {
  crater: 'impact crater',
  mons: 'mountain',
  montes: 'mountain range',
  vallis: 'valley',
  valles: 'valley system',
  mare: 'volcanic plain (a lunar "sea")',
  oceanus: 'vast volcanic plain (an "ocean")',
  sinus: 'bay-shaped plain',
  lacus: 'small plain (a "lake")',
  palus: 'small irregular plain (a "marsh")',
  planitia: 'low-lying plain',
  planum: 'high plateau',
  terra: 'extensive highland region',
  tholus: 'small domed mountain',
  fossa: 'long narrow trench',
  fossae: 'system of trenches',
  rupes: 'scarp (cliff)',
  dorsum: 'wrinkle ridge',
  dorsa: 'system of ridges',
  chasma: 'deep steep-sided canyon',
  chasmata: 'canyon system',
  patera: 'irregular shallow crater',
  rima: 'narrow channel (rille)',
  rimae: 'channel system',
  promontorium: 'cape or headland',
  catena: 'chain of craters',
  regio: 'large distinctively coloured region',
  labyrinthus: 'maze of intersecting valleys',
  tessera: 'polygonal terrain (Venus)',
  tesserae: 'polygonal terrain (Venus)',
  corona: 'oval volcano-tectonic structure',
  coronae: 'oval volcano-tectonic structures',
  colles: 'field of small hills',
  scopulus: 'lobate or irregular scarp',
  vastitas: 'immense lowland plain',
  'albedo feature': 'region named for its brightness contrast',
  landing: 'spacecraft landing site',
}

export function featureTypeGloss(type: string | null): string | null {
  if (!type) return null
  const key = type.split(',')[0]?.trim().toLowerCase() ?? ''
  return FEATURE_TYPE_GLOSS[key] ?? FEATURE_TYPE_GLOSS[type.toLowerCase()] ?? null
}

export interface PhenomenaFile {
  source: string
  version: number
  imageNote: string
  entries: {
    id: string
    title: string
    description: string
    facts: string[]
    image: BodyImage | null
    wikipedia: string
    nasa: string
  }[]
}

export interface SpaceRegion {
  id: string
  name: string
  innerAu: number
  outerAu: number
  note: string
  wikipedia: string
}

export interface SpaceBodiesFile {
  bodies: SpaceBody[]
  regions: SpaceRegion[]
  moonCatalog: { source: string; counts: Record<string, number> }
  notes: { factSheets: string; nulls: string }
}

export interface MoonRecord {
  name: string
  aKm: number | null
  e: number | null
  iDeg: number | null
  periodDays: number | null
  radiusKm: number | null
  massKg: number | null
  densityGCm3: number | null
  discoveryYear: number | null
  discoveredBy: string | null
  major: boolean
}

const cache = new Map<string, Promise<unknown>>()

function load<T>(path: string): Promise<T> {
  let pending = cache.get(path)
  if (!pending) {
    pending = fetch(`${DATA_BASE_URL}/${path}`).then((response) => {
      if (!response.ok) {
        cache.delete(path)
        throw new Error(`${path}: HTTP ${response.status}`)
      }
      return response.json()
    })
    cache.set(path, pending)
  }
  return pending as Promise<T>
}

export function useSpaceBodies(): AsyncState<SpaceBodiesFile> {
  const [state, setState] = useState<AsyncState<SpaceBodiesFile>>({
    status: 'loading',
  })
  useEffect(() => {
    let cancelled = false
    load<SpaceBodiesFile>('space/bodies.json')
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
  }, [])
  return state
}

export const loadMoons = (planetId: string) =>
  load<{ planet: string; moons: MoonRecord[] }>(
    `space/moons/${encodeURIComponent(planetId)}.json`,
  )

export const loadNomenclature = (bodyId: string) =>
  load<Nomenclature>(`space/nomenclature/${encodeURIComponent(bodyId)}.json`)

export function usePhenomena(): AsyncState<PhenomenaFile> {
  const [state, setState] = useState<AsyncState<PhenomenaFile>>({
    status: 'loading',
  })
  useEffect(() => {
    let cancelled = false
    load<PhenomenaFile>('space/phenomena.json')
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
  }, [])
  return state
}

/** "1.898e27 kg" style scientific formatting for planetary masses. */
export function formatKg(kg: number): string {
  const exponent = Math.floor(Math.log10(kg))
  const mantissa = kg / 10 ** exponent
  return `${mantissa.toFixed(3)} × 10${superscript(exponent)} kg`
}

function superscript(value: number): string {
  const digits = '⁰¹²³⁴⁵⁶⁷⁸⁹'
  return String(value)
    .split('')
    .map((ch) => (ch === '-' ? '⁻' : digits[Number(ch)] ?? ch))
    .join('')
}

export function formatDays(days: number): string {
  if (days >= 365.25 * 2) return `${(days / 365.25).toFixed(1)} years`
  return `${days.toLocaleString('en', { maximumFractionDigits: 2 })} days`
}

export function formatHours(hours: number): string {
  const abs = Math.abs(hours)
  const suffix = hours < 0 ? ' (retrograde)' : ''
  if (abs >= 48) return `${(abs / 24).toFixed(2)} days${suffix}`
  return `${abs.toFixed(2)} hours${suffix}`
}
