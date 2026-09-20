import { Suspense, lazy, useEffect, useMemo, useState } from 'react'

import {
  LAYER_ORDER,
  layerAt,
  type LayerId,
  type ModelManifest,
  type ModelStructure,
  type Sex,
} from '../../lib/anatomy'
import type { LoadState } from './BodyViewer'
import './anatomy.css'

const BodyViewer = lazy(() => import('./BodyViewer'))

/**
 * The 3-D stage: depth control (bone -> flesh), the Male / Female toggle,
 * see-through, reset, the viewer itself, its loading state and the
 * attribution line the licences require. Everything three.js lives in
 * BodyViewer (lazy); this file is plain React so it ships in the page
 * chunk. Design notes (UI UX Pro Max, round 12): 44 px touch targets with
 * 8 px gaps, vertical scroll left to the page (the canvas is touch-none),
 * reduced motion honoured, every control labelled, the heavy asset lazy
 * and compressed.
 */

export const LAYER_SHORT: Record<LayerId, string> = {
  skeleton: 'Skeleton',
  nervous: 'Nerves',
  organs: 'Organs',
  vessels: 'Vessels',
  muscles: 'Muscles',
  skin: 'Skin',
}

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

interface Props {
  manifest: ModelManifest
  structures: ModelStructure[] | null
  structuresError: string | null
  sex: Sex
  onSex: (sex: Sex) => void
  depth: number
  onDepth: (depth: number) => void
  seeThrough: boolean
  onSeeThrough: (value: boolean) => void
  selected: ModelStructure | null
  onPick: (structure: ModelStructure | null) => void
  highlightOrgan: string | null
  organNames: Map<string, string>
  onOpenOrgan: (organ: string) => void
  compact: boolean
  reducedMotion: boolean
}

export function BodyStage({
  manifest,
  structures,
  structuresError,
  sex,
  onSex,
  depth,
  onDepth,
  seeThrough,
  onSeeThrough,
  selected,
  onPick,
  highlightOrgan,
  organNames,
  onOpenOrgan,
  compact,
  reducedMotion,
}: Props) {
  const [load, setLoad] = useState<LoadState>({ loaded: [], loading: null, error: null })
  const [resetToken, setResetToken] = useState(0)
  const record = manifest.sexes[sex]
  const layer = record.layers.find((l) => l.id === layerAt(depth)) ?? record.layers[0]
  const layerLabel = manifest.layers.find((l) => l.id === layerAt(depth))?.label ?? ''
  const hasWebgl = useMemo(() => webglAvailable(), [])

  useEffect(() => {
    setLoad({ loaded: [], loading: null, error: null })
  }, [sex])

  const pending = LAYER_ORDER.filter((id) => !load.loaded.includes(id))
  const currentReady = load.loaded.includes(layerAt(depth))

  if (!hasWebgl) {
    return (
      <div className="anatomy-nowebgl" role="status">
        <p className="m-0 text-sm">
          The three-dimensional body needs WebGL, which this browser does not offer. The
          layered diagrams tab shows the same systems as flat figures.
        </p>
      </div>
    )
  }

  return (
    <div className="anatomy-stage3d">
      {/* Sex toggle + view controls */}
      <div className="anatomy-toolbar">
        <div className="anatomy-segmented" role="group" aria-label="Model">
          {(['male', 'female'] as Sex[]).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={sex === option}
              className={sex === option ? 'is-selected' : ''}
              onClick={() => onSex(option)}
            >
              {option === 'male' ? 'Male' : 'Female'}
            </button>
          ))}
        </div>
        <label className="anatomy-toggle">
          <input
            type="checkbox"
            checked={seeThrough}
            onChange={(event) => onSeeThrough(event.target.checked)}
            disabled={depth === 0}
          />
          <span>See through {LAYER_SHORT[layerAt(depth)].toLowerCase()}</span>
        </label>
      </div>

      {/* The viewer */}
      <div className={`anatomy-frame${compact ? ' is-compact' : ''}`}>
        {structuresError ? (
          <div className="anatomy-loading" role="alert">
            The structure index for this model could not be loaded: {structuresError}
          </div>
        ) : structures ? (
          <Suspense fallback={<div className="anatomy-loading">Loading the viewer…</div>}>
            <BodyViewer
              sex={sex}
              manifest={manifest}
              structures={structures}
              depth={depth}
              seeThrough={seeThrough}
              selectedNode={selected?.node ?? null}
              highlightOrgan={highlightOrgan}
              organNames={organNames}
              onPick={onPick}
              onPinOpen={onOpenOrgan}
              onLoadState={setLoad}
              resetToken={resetToken}
              reducedMotion={reducedMotion}
              compact={compact}
            />
          </Suspense>
        ) : (
          <div className="anatomy-loading">Loading the structure index…</div>
        )}
        {(!currentReady || load.loading) && !load.error && structures && (
          <div className="anatomy-progress" role="status" aria-live="polite">
            {!currentReady ? `Loading ${LAYER_SHORT[layerAt(depth)].toLowerCase()}…` : `Loading ${LAYER_SHORT[load.loading as LayerId].toLowerCase()} in the background`}
            {pending.length > 0 && (
              <span className="anatomy-progress-count"> · {LAYER_ORDER.length - pending.length} of {LAYER_ORDER.length} layers</span>
            )}
          </div>
        )}
        {load.error && (
          <div className="anatomy-progress is-error" role="alert">
            A layer failed to load: {load.error}
          </div>
        )}
        <button
          type="button"
          className="anatomy-button anatomy-reset"
          onClick={() => setResetToken((n) => n + 1)}
          aria-label="Reset view"
          title="Reset view"
        >
          Reset view
        </button>
        <p className="anatomy-hint" aria-hidden="true">
          {compact ? 'Drag to rotate · pinch to zoom · tap a structure' : 'Drag to rotate · scroll to zoom · right-drag to pan · click a structure'}
        </p>
      </div>

      {/* Depth control: slider + numbered chips, bone -> flesh */}
      <div className="anatomy-depth">
        <label className="anatomy-depth-label" htmlFor="anatomy-depth-slider">
          Depth: <strong>{layerLabel}</strong>
          <span className="anatomy-depth-hint"> bone → flesh</span>
        </label>
        <input
          id="anatomy-depth-slider"
          className="anatomy-slider"
          type="range"
          min={0}
          max={LAYER_ORDER.length - 1}
          step={1}
          value={depth}
          aria-valuetext={layerLabel}
          onChange={(event) => onDepth(Number(event.target.value))}
        />
        <ol
          className="anatomy-chips"
          aria-label="Layers, bone to flesh"
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
              event.preventDefault()
              onDepth(Math.min(LAYER_ORDER.length - 1, depth + 1))
            } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
              event.preventDefault()
              onDepth(Math.max(0, depth - 1))
            }
          }}
        >
          {LAYER_ORDER.map((id, index) => {
            const info = record.layers.find((l) => l.id === id)
            const active = index === depth
            return (
              <li key={id}>
                <button
                  type="button"
                  aria-current={active ? 'step' : undefined}
                  className={`anatomy-chip${active ? ' is-active' : ''}${index < depth ? ' is-below' : ''}`}
                  onClick={() => onDepth(index)}
                  title={info?.note ?? ''}
                >
                  <span className="anatomy-chip-n">{index + 1}</span>
                  {LAYER_SHORT[id]}
                  {info?.coverage === 'partial' && <span className="anatomy-chip-flag" aria-label="partial in this model">◐</span>}
                </button>
              </li>
            )
          })}
        </ol>
      </div>

      {/* What this layer holds in this model */}
      <p className="anatomy-coverage">
        <strong>{layerLabel}</strong>
        {layer && (
          <>
            {' '}· {layer.structures.toLocaleString()} named structures · {layer.coverage === 'partial' ? 'partial in this model: ' : ''}
            {layer.note}.
          </>
        )}
        {sex === 'female' && (
          <>
            {' '}No free female whole-body model includes a full skeleton, muscles or peripheral nerves; those are
            not borrowed from the male model.
          </>
        )}
      </p>

      {/* Attribution, exactly as the manifest records it */}
      <p className="anatomy-credit">
        {sex === 'male' ? (
          <>
            Male model: {record.source.author} ·{' '}
            <a href={record.source.licenceUrl} target="_blank" rel="noreferrer">
              {record.source.licence}
            </a>{' '}
            · {record.source.upstream?.map((u, i) => (
              <span key={u.url}>
                {i > 0 && ', '}
                <a href={u.url} target="_blank" rel="noreferrer">
                  {u.title}
                </a>{' '}
                ({u.licence})
              </span>
            ))}{' '}
            · GLB export{' '}
            <a href={record.source.sourcePage} target="_blank" rel="noreferrer">
              Anatria3D
            </a>
            ; simplified and re-encoded for this site, and so also {record.source.licence} (share-alike).
          </>
        ) : (
          <>
            Female model: {(record.source.attribution ?? record.source.title).replace(/\*/g, '')} ·{' '}
            <a href={record.source.licenceUrl} target="_blank" rel="noreferrer">
              {record.source.licence}
            </a>{' '}
            ·{' '}
            <a href={record.source.sourcePage} target="_blank" rel="noreferrer">
              HuBMAP Human Reference Atlas 3D Reference Library
            </a>
            {record.source.doi && (
              <>
                {' '}
                ·{' '}
                <a href={record.source.doi} target="_blank" rel="noreferrer">
                  DOI
                </a>
              </>
            )}
            ; {record.source.author}. Simplified and re-encoded for this site.
          </>
        )}
      </p>
    </div>
  )
}
