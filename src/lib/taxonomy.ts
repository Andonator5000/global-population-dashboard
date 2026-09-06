/**
 * Loaders and types for the Taxonomy page (Phase 5, DATA_DECISIONS.md §31).
 *
 * The tree artifact holds Life down to family rank in one document -- the
 * page renders it lazily, so the DOM only ever carries expanded branches.
 * Focus families (genus/species depth) live in per-family artifacts
 * fetched on expand.
 */

import { useEffect, useState } from 'react'

import { DATA_BASE_URL } from '../config'
import type { AsyncState } from './data'

export interface TaxonNode {
  id: string
  name: string
  rank: string
  /** Descendant names recorded beneath this taxon in Catalogue of Life. */
  names: number
  auth?: string
  /** English Wikipedia title, or null meaning "checked, none recorded". */
  wiki: string | null
  common?: string
  desc?: string
  /** Contested-placement annotation (etl/reference/taxonomy_notes.json). */
  note?: string
  provisional?: boolean
  /** Children were capped at fetch time; the list is knowingly incomplete. */
  truncated?: boolean
  /** A focus family: genus/species depth exists in focus/{id}.json. */
  focus?: boolean
  children?: TaxonNode[]
}

export interface TaxonomyFile {
  source: string
  release: string
  rank_floor: string
  col_dataset_url: string
  tree: TaxonNode
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

export function useTaxonomyTree(): AsyncState<TaxonomyFile> {
  const [state, setState] = useState<AsyncState<TaxonomyFile>>({
    status: 'loading',
  })
  useEffect(() => {
    let cancelled = false
    load<TaxonomyFile>('biology/taxonomy/tree.json')
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

export const loadFocusFamily = (id: string) =>
  load<TaxonNode>(`biology/taxonomy/focus/${encodeURIComponent(id)}.json`)

export const colTaxonUrl = (datasetUrl: string, id: string) =>
  `${datasetUrl}/taxon/${encodeURIComponent(id)}`

export const wikipediaUrl = (title: string) =>
  `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`

/** Ranks whose names are conventionally italicised. */
export const ITALIC_RANKS = new Set([
  'genus',
  'subgenus',
  'species',
  'subspecies',
  'variety',
])
