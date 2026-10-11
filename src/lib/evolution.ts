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

// ---- Round 14 (DATA_DECISIONS section 73): the tree of life through time ----

export type TreeGroupKey =
  | 'bacteria'
  | 'archaea'
  | 'protist'
  | 'plant'
  | 'fungus'
  | 'invertebrate'
  | 'arthropod'
  | 'fish'
  | 'amphibian'
  | 'reptile'
  | 'bird'
  | 'mammal'

export interface TreeSource {
  title: string
  url: string
}

export interface TreeMerge {
  /** The donor lineage's node id (an alphaproteobacterium, a cyanobacterium). */
  from: string
  label: string
  note?: string
}

export interface TreeNode {
  id: string
  name: string
  scientific: string | null
  parent: string | null
  /** When the lineage split from its sister (divergence/estimate) or its oldest accepted fossil. */
  originMa: number
  originKind: 'divergence' | 'fossil' | 'estimate'
  /** [older, younger] bracket where the literature disagrees. */
  ageRange: [number, number] | null
  status: 'extant' | 'extinct'
  extinctMa: number | null
  group: TreeGroupKey
  summary: string
  wikipedia: string
  sources: TreeSource[]
  merges: TreeMerge[]
  image: EvolutionImage | null
}

export interface TreeBand {
  id: string
  name: string
  kind: 'extinction' | 'event'
  startMa: number
  endMa: number
  summary: string
  sources: TreeSource[]
  wikipedia: string | null
}

export interface EvolutionTreeFile {
  source: string
  version: number
  note: string
  imageNote: string
  root: string
  groups: Record<TreeGroupKey, string>
  bands: TreeBand[]
  nodes: TreeNode[]
}

export const useEvolutionTree = () =>
  useArtifact<EvolutionTreeFile>('biology/evolution/tree.json')

/** "4.0 billion years ago", "252 million years ago", "315,000 years ago". */
export function formatAge(ma: number): string {
  if (ma >= 1000) {
    const ga = ma / 1000
    return `${ga >= 10 ? Math.round(ga) : Math.round(ga * 100) / 100} billion years ago`
  }
  if (ma >= 1) {
    const value = ma >= 100 ? Math.round(ma) : Math.round(ma * 10) / 10
    return `${value} million years ago`
  }
  const years = Math.round(ma * 1000) * 1000
  return `${years.toLocaleString('en-US')} years ago`
}

/** Short axis form: "4 Ga", "541 Ma", "66 Ma", "today". */
export function formatAgeShort(ma: number): string {
  if (ma === 0) return 'today'
  if (ma >= 1000) {
    const ga = ma / 1000
    return `${Number.isInteger(ga) ? ga : ga.toFixed(1)} Ga`
  }
  if (ma >= 1) return `${ma >= 100 ? Math.round(ma) : Math.round(ma * 10) / 10} Ma`
  return `${Math.round(ma * 1000)} ka`
}
