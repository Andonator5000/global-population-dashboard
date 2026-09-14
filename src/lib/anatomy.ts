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
