/**
 * Loaders and types for the Evolution page (Phase 6, DATA_DECISIONS.md §32).
 */

import { useEffect, useState } from 'react'

import { DATA_BASE_URL } from '../config'
import type { AsyncState } from './data'

export interface IcsInterval {
  id: string
  name: string
  rank: string
  parent: string | null
  startMa: number
  endMa: number
  startError?: number
  endError?: number
  startUncertain?: boolean
  endUncertain?: boolean
  color?: string
  order?: number
  /** Round-2 §40: editorial banner copy merged in the ETL. */
  description?: string
  etymology?: string
  etymologySource?: string
}

export interface EvolutionChart {
  source: string
  url: string
  license: string
  intervals: IcsInterval[]
}

export interface EvolutionImage {
  type: 'phylopic' | 'commons'
  url: string
  license: string
  attribution: string | null
  page: string
  matched?: string
}

export interface EvolutionEvent {
  id: string
  title: string
  kind: 'event' | 'organism' | 'extinction'
  startMa: number
  endMa: number | null
  summary: string
  image: EvolutionImage | null
  sources: string[]
  wikipedia: string
}

export interface EvolutionEventsFile {
  source: string
  version: number
  note: string
  imageNote: string
  events: EvolutionEvent[]
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

function useArtifact<T>(path: string): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    load<T>(path)
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
  }, [path])
  return state
}

export const useEvolutionChart = () =>
  useArtifact<EvolutionChart>('biology/evolution/chart.json')

export const useEvolutionEvents = () =>
  useArtifact<EvolutionEventsFile>('biology/evolution/events.json')

/** "4540 Ma", "252.0 ± 0.1 Ma", "430 ka", "present". */
export function formatMa(ma: number, error?: number): string {
  if (ma === 0) return 'present'
  if (ma < 1) {
    const ka = ma * 1000
    const value = ka >= 100 ? Math.round(ka) : Math.round(ka * 10) / 10
    return error
      ? `${value} ± ${Math.round(error * 1000)} ka`
      : `${value} ka`
  }
  const value = ma >= 100 ? Math.round(ma * 10) / 10 : Math.round(ma * 100) / 100
  return error ? `${value} ± ${error} Ma` : `${value} Ma`
}
