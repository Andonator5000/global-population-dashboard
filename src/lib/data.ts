import { useEffect, useState } from 'react'

import { DATA_BASE_URL } from '../config'
import type { Entity, Manifest } from '../types'

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
