/**
 * Human Anatomy artifacts (round 6, DATA_DECISIONS.md §55).
 *
 * data/anatomy/anatomy.json is produced by the `anatomy` ETL stage from
 * the editorial reference (etl/reference/anatomy.json, itself written by
 * etl/reference/build_anatomy.py). Nothing here is hand-typed: the page
 * renders what the stage validated and the images it downloaded through
 * the licence gate.
 */
import { useEffect, useState } from 'react'

import { DATA_BASE_URL } from '../config'
import type { AsyncState } from './data'

export interface AnatomySource {
  title: string
  url: string
  publisher: string
}

export interface AnatomyImage {
  file: string
  width: number
  height: number
  title: string
  author: string
  licence: string
  creditLine: string
  sourcePage: string
}

export interface AnatomyLayer {
  id: string
  label: string | null
  system: string
  caption: string
  image: AnatomyImage
}

export interface AnatomySystem {
  id: string
  name: string
  summary: string
  description: string[]
  functions: string[]
  organs: string[]
  worksWith: { system: string; how: string }[]
  source: AnatomySource
}

export interface AnatomyOrgan {
  id: string
  name: string
  systems: string[]
  location: string
  description: string[]
  function: string
  facts: { label: string; value: string }[]
  source: AnatomySource
  /** 3-D alias patterns (round 12); resolved to node names by the build script. */
  mesh?: { match?: string[]; except?: string[]; layer?: string }
}

// --------------------------------------------------------------------------
// 3-D body models (round 12, DATA_DECISIONS.md §62). One registered free
// model per sex, cut into six layers ordered bone -> flesh by
// scripts/build-anatomy-models.mjs; every structure is a named node and
// structures-<sex>.json says what it is and which organ entry it opens.
// --------------------------------------------------------------------------

export type Sex = 'male' | 'female'
export type LayerId = 'skeleton' | 'nervous' | 'organs' | 'vessels' | 'muscles' | 'skin'

/** Bone to flesh. Index = depth on the peel control. */
export const LAYER_ORDER: LayerId[] = ['skeleton', 'nervous', 'organs', 'vessels', 'muscles', 'skin']

/** The layer at a depth on the peel control (the skin when out of range). */
export function layerAt(depth: number): LayerId {
  return LAYER_ORDER[depth] ?? 'skin'
}

export interface ModelLayer {
  id: LayerId
  label: string
  file: string
  bytes: number
  sha256: string
  structures: number
  triangles: number
  sourceTriangles: number
  coverage: 'full' | 'partial'
  note: string
  /** Extra files drawn with this layer under their own licence (round 12:
      the female stomach and oesophagus, fitted from the male model). */
  supplements?: ModelSupplement[]
}

export interface ModelSupplement {
  id: string
  layer: LayerId
  file: string
  bytes: number
  sha256: string
  structures: number
  triangles: number
  sourceTriangles: number
  licence: string
  licenceUrl: string
  note: string
}

export interface ModelSource {
  id: string
  title: string
  author: string
  attribution: string | null
  licence: string
  licenceUrl: string
  sourcePage: string
  upstream?: { title: string; url: string; licence: string }[]
  doi?: string | null
  citationOverall?: string | null
  version?: string
  pinned?: { repository: string; commit: string }
  notice?: string
  /** Supplement sources only: why the model needed it. */
  why?: string
  files: { file: string; url: string; bytes: number; sha256: string }[]
}

export interface ModelSex {
  sex: Sex
  source: ModelSource
  /** Sources of the layers' supplements, credited beside the model's own. */
  supplements?: ModelSource[]
  layers: ModelLayer[]
  omitted: { what: string; count: number; why: string }[]
  totalBytes: number
  structureCount: number
}

export interface ModelManifest {
  version: number
  note: string
  budgets: { layerBytes: number; sexBytes: number }
  layers: { id: LayerId; label: string; order: number }[]
  encoding: string[]
  sexes: Record<Sex, ModelSex>
}

export interface ModelStructure {
  node: string
  layer: LayerId
  name: string
  latin?: string | null
  derived?: string
  hraLabel?: string | null
  ontology?: string | null
  system: string | null
  group: string | null
  organ: string | null
  /** Set when the structure was fitted in from the other sex's model. */
  fitted?: string | null
  triangles: number
}

const modelCache = new Map<string, Promise<unknown>>()

function loadJson<T>(path: string): Promise<T> {
  let hit = modelCache.get(path) as Promise<T> | undefined
  if (!hit) {
    hit = fetch(`${DATA_BASE_URL}/${path}`).then((response) => {
      if (!response.ok) {
        modelCache.delete(path)
        throw new Error(`${path}: HTTP ${response.status}`)
      }
      return response.json() as Promise<T>
    })
    modelCache.set(path, hit)
  }
  return hit
}

export function loadModelManifest(): Promise<ModelManifest> {
  return loadJson<ModelManifest>('anatomy/models/manifest.json')
}

export function loadStructures(sex: Sex): Promise<ModelStructure[]> {
  return loadJson<{ sex: Sex; structures: ModelStructure[] }>(`anatomy/models/structures-${sex}.json`).then(
    (file) => file.structures,
  )
}

export function anatomyModelUrl(file: string): string {
  return `${DATA_BASE_URL}/${file}`
}

/** Which of the page's systems a whole layer stands for when nothing is picked. */
export const LAYER_SYSTEMS: Record<LayerId, string[]> = {
  skeleton: ['skeletal'],
  nervous: ['nervous'],
  organs: ['digestive', 'respiratory', 'urinary', 'reproductive', 'endocrine', 'lymphatic'],
  vessels: ['circulatory', 'lymphatic'],
  muscles: ['muscular'],
  skin: ['integumentary'],
}

export interface AnatomyCooperation {
  title: string
  systems: string[]
  text: string
}

export interface AnatomyFile {
  version: number
  note: string
  layers: AnatomyLayer[]
  figures: AnatomyLayer[]
  systems: AnatomySystem[]
  organs: AnatomyOrgan[]
  cooperation: AnatomyCooperation[]
}

let pending: Promise<AnatomyFile> | null = null

function load(): Promise<AnatomyFile> {
  if (!pending) {
    pending = fetch(`${DATA_BASE_URL}/anatomy/anatomy.json`).then((response) => {
      if (!response.ok) {
        pending = null
        throw new Error(`anatomy/anatomy.json: HTTP ${response.status}`)
      }
      return response.json() as Promise<AnatomyFile>
    })
  }
  return pending
}

export function useAnatomy(): AsyncState<AnatomyFile> {
  const [state, setState] = useState<AsyncState<AnatomyFile>>({ status: 'loading' })
  useEffect(() => {
    let cancelled = false
    load()
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

export function anatomyImageUrl(image: AnatomyImage): string {
  return `${DATA_BASE_URL}/${image.file}`
}
