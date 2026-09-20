import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import {
  LAYER_ORDER,
  layerAt,
  type DiagramsFile,
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
 * see-through, labels, search, full screen, reset, the viewer itself, its
 * loading state and the attribution line the licences require. Everything
 * three.js lives in BodyViewer (lazy); this file is plain React so it
 * ships in the page chunk. Design notes (UI UX Pro Max, rounds 12-13):
 * 44 px touch targets with 8 px gaps, vertical scroll left to the page
 * (the canvas is touch-none), reduced motion honoured, every control
 * labelled, visible focus on every control including those in full
 * screen, the heavy asset lazy and compressed.
 *
 * Full screen (round 13) mirrors the globe (WorldMap.tsx §53.3): the
 * native Fullscreen API on the stage frame where the browser offers it,
 * and a CSS pseudo-fullscreen (the frame pinned over the page, the page
 * behind it not scrolling) on iOS, which has no element fullscreen. In
 * both, a compact overlay keeps the sex toggle, depth chips, see-through,
 * labels and the picked-structure card usable; Escape, the Done button
 * and the browser's Back all leave, and the page's scroll position is put
 * back where it was.
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
  diagrams: DiagramsFile | null
  sex: Sex
  onSex: (sex: Sex) => void
  depth: number
  onDepth: (depth: number) => void
  seeThrough: boolean
  onSeeThrough: (value: boolean) => void
  labelsOn: boolean
  onLabelsOn: (value: boolean) => void
  labelQuery: string
  onLabelQuery: (value: string) => void
  selected: ModelStructure | null
  selectedKey: string | null
  onPick: (structure: ModelStructure | null) => void
  highlightOrgan: string | null
  /** The picked-structure card, rendered inside the frame in full screen. */
  pickedCard: ReactNode
  compact: boolean
  reducedMotion: boolean
}

export function BodyStage({
  manifest,
  structures,
  structuresError,
  diagrams,
  sex,
  onSex,
  depth,
  onDepth,
  seeThrough,
  onSeeThrough,
  labelsOn,
  onLabelsOn,
  labelQuery,
  onLabelQuery,
  selected,
  selectedKey,
  onPick,
  highlightOrgan,
  pickedCard,
  compact,
  reducedMotion,
}: Props) {
  const [load, setLoad] = useState<LoadState>({ loaded: [], loading: null, error: null })
  const [resetToken, setResetToken] = useState(0)
  const record = manifest.sexes[sex]
  const layer = record.layers.find((l) => l.id === layerAt(depth)) ?? record.layers[0]
  const layerLabel = manifest.layers.find((l) => l.id === layerAt(depth))?.label ?? ''
  const hasWebgl = useMemo(() => webglAvailable(), [])

  // ---- Full screen (§53.3 pattern) -----------------------------------------
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [nativeFullscreen, setNativeFullscreen] = useState(false)
  const [pseudoFullscreen, setPseudoFullscreen] = useState(false)
  const isFullscreen = nativeFullscreen || pseudoFullscreen
  const scrollBefore = useRef<number | null>(null)
  const pushedHistory = useRef(false)

  useEffect(() => {
    const onChange = () => setNativeFullscreen(document.fullscreenElement === frameRef.current)
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  // Entering: remember the scroll, add a history entry so Back leaves.
  // Leaving: restore the scroll once the layout has settled.
  useEffect(() => {
    if (isFullscreen) {
      if (scrollBefore.current === null) scrollBefore.current = window.scrollY
      if (!pushedHistory.current) {
        pushedHistory.current = true
        history.pushState({ anatomyFullscreen: true }, '')
      }
      return
    }
    const y = scrollBefore.current
    scrollBefore.current = null
    if (pushedHistory.current) {
      pushedHistory.current = false
      if (history.state && (history.state as { anatomyFullscreen?: boolean }).anatomyFullscreen) history.back()
    }
    if (y !== null) {
      // After the frame is back in flow (and after the popstate's own
      // scroll restoration), put the page where it was.
      const restore = () => window.scrollTo({ top: y, behavior: 'auto' })
      requestAnimationFrame(restore)
      window.setTimeout(restore, 120)
    }
  }, [isFullscreen])

  useEffect(() => {
    const onPop = () => {
      // Back pressed while full screen: leave it (idempotent).
      pushedHistory.current = false
      setPseudoFullscreen(false)
      if (document.fullscreenElement === frameRef.current) void document.exitFullscreen()
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    if (!isFullscreen) return
    const previous = document.body.style.overflow
    if (pseudoFullscreen) document.body.style.overflow = 'hidden'
    // Escape leaves either mode (a browser exits native fullscreen on Esc by
    // itself; a synthetic key or a browser that does not should still work).
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setPseudoFullscreen(false)
      if (document.fullscreenElement === frameRef.current) void document.exitFullscreen()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.body.style.overflow = previous
      document.removeEventListener('keydown', onKey)
    }
  }, [isFullscreen, pseudoFullscreen])

  const toggleFullscreen = useCallback(() => {
    const frame = frameRef.current
    if (!frame) return
    // Remember the scroll BEFORE the request: a native fullscreen zeroes it.
    if (!pseudoFullscreen && document.fullscreenElement !== frame) scrollBefore.current = window.scrollY
    if (pseudoFullscreen) {
      setPseudoFullscreen(false)
      return
    }
    if (document.fullscreenElement === frame) {
      void document.exitFullscreen()
      return
    }
    if (typeof frame.requestFullscreen === 'function' && document.fullscreenEnabled) {
      frame.requestFullscreen().catch(() => setPseudoFullscreen(true))
    } else {
      setPseudoFullscreen(true)
    }
  }, [pseudoFullscreen])

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
          Diagrams tab shows the same layers, rendered from the same models, as flat figures.
        </p>
      </div>
    )
  }

  const sexToggle = (
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
  )
  const seeThroughToggle = (
    <label className="anatomy-toggle">
      <input
        type="checkbox"
        checked={seeThrough}
        onChange={(event) => onSeeThrough(event.target.checked)}
        disabled={depth === 0}
      />
      <span>See through {LAYER_SHORT[layerAt(depth)].toLowerCase()}</span>
    </label>
  )
  const labelsToggle = (
    <label className="anatomy-toggle">
      <input type="checkbox" checked={labelsOn} onChange={(event) => onLabelsOn(event.target.checked)} />
      <span>Labels</span>
    </label>
  )
  const searchBox = (
    <label className="anatomy-search">
      <span className="sr-only">Find a structure in this layer</span>
      <input
        type="search"
        value={labelQuery}
        placeholder="Find a structure…"
        onChange={(event) => onLabelQuery(event.target.value)}
        aria-label="Find a structure in this layer"
        enterKeyHint="search"
      />
    </label>
  )
  const chips = (
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
              {info?.coverage === 'partial' && <span className="anatomy-chip-flag" aria-label="partly fitted from the male model">◐</span>}
            </button>
          </li>
        )
      })}
    </ol>
  )

  const frameClass = `anatomy-fs-frame${pseudoFullscreen ? ' is-pseudo' : ''}${nativeFullscreen ? ' is-native' : ''}${compact ? ' is-compact' : ''}`

  return (
    <div className="anatomy-stage3d">
      {/* Sex toggle + view controls (outside full screen) */}
      {!isFullscreen && (
        <div className="anatomy-toolbar">
          {sexToggle}
          {seeThroughToggle}
          {labelsToggle}
          {searchBox}
        </div>
      )}

      {/* The frame that goes full screen: viewer + overlay chrome */}
      <div ref={frameRef} className={frameClass}>
        {isFullscreen && (
          <div className="anatomy-fs-bar anatomy-fs-top">
            <button type="button" className="anatomy-button" onClick={toggleFullscreen}>
              Done
            </button>
            {sexToggle}
            {labelsToggle}
            {!compact && searchBox}
          </div>
        )}
        <div className={`anatomy-frame${compact ? ' is-compact' : ''}${isFullscreen ? ' is-fullscreen' : ''}`}>
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
                diagrams={diagrams}
                depth={depth}
                seeThrough={seeThrough}
                selectedNode={selected?.node ?? null}
                selectedKey={selectedKey}
                highlightOrgan={highlightOrgan}
                labelsOn={labelsOn}
                labelQuery={labelQuery}
                onPick={onPick}
                onLabelOpen={(structure) => onPick(structure)}
                onLoadState={setLoad}
                resetToken={resetToken}
                fullscreen={isFullscreen}
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
          <div className="anatomy-stage-buttons">
            <button
              type="button"
              className="anatomy-button"
              onClick={() => setResetToken((n) => n + 1)}
              aria-label="Reset view"
              title="Reset view"
            >
              Reset view
            </button>
            {!isFullscreen && (
              <button
                type="button"
                className="anatomy-button"
                onClick={toggleFullscreen}
                aria-label="View the body full screen"
                title="Full screen"
              >
                Full screen
              </button>
            )}
          </div>
          {!isFullscreen && (
            <p className="anatomy-hint" aria-hidden="true">
              {compact ? 'Drag to rotate · pinch to zoom · tap a structure or a label' : 'Drag to rotate · scroll to zoom · right-drag to pan · click a structure or a label'}
            </p>
          )}
        </div>
        {isFullscreen && (
          <div className="anatomy-fs-bar anatomy-fs-bottom">
            {pickedCard && <div className="anatomy-fs-card">{pickedCard}</div>}
            <div className="anatomy-fs-controls">
              {chips}
              {seeThroughToggle}
            </div>
          </div>
        )}
      </div>

      {/* Depth control: slider + numbered chips, bone -> flesh */}
      {!isFullscreen && (
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
          {chips}
        </div>
      )}

      {/* What this layer holds in this model: native vs fitted, stated plainly */}
      <p className="anatomy-coverage">
        <strong>{layerLabel}</strong>
        {layer && (
          <>
            {' '}· {layer.structures.toLocaleString()} named structures
            {(layer.supplements ?? []).length > 0 && (
              <>
                {' '}+ {(layer.supplements ?? []).reduce((sum, s) => sum + s.structures, 0).toLocaleString()} fitted
              </>
            )}
            {' '}· {layer.note}.
          </>
        )}
        {sex === 'female' && (
          <>
            {' '}No free female whole-body model includes a full skeleton, muscles or peripheral nerves; what the
            Human Reference Atlas lacks is the male model fitted into the female frame, region by region, and every
            such structure is marked as fitted on its card and in the labels.
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
            {record.supplements?.map((extra) => (
              <span key={extra.id}>
                {' '}
                · {extra.title}: {extra.author} ·{' '}
                <a href={extra.licenceUrl} target="_blank" rel="noreferrer">
                  {extra.licence}
                </a>{' '}
                (share-alike; {extra.why}) ·{' '}
                <a href={extra.sourcePage} target="_blank" rel="noreferrer">
                  Anatria3D
                </a>
                .
              </span>
            ))}
          </>
        )}
      </p>
    </div>
  )
}
