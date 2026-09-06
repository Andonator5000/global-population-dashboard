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
