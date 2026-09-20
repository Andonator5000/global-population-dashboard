import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { BodyStage } from '../components/anatomy/BodyStage'
import { CollapsibleSources } from '../components/CollapsibleSources'
import { Unavailable } from '../components/viz/primitives'
import {
  LAYER_ORDER,
  LAYER_SYSTEMS,
  anatomyImageUrl,
  layerAt,
  loadModelManifest,
  loadStructures,
  useAnatomy,
  type AnatomyFile,
  type AnatomyLayer,
  type AnatomyOrgan,
  type AnatomySystem,
  type LayerId,
  type ModelManifest,
  type ModelStructure,
  type Sex,
} from '../lib/anatomy'

/**
 * /anatomy — the human body in layers (round 6, DATA_DECISIONS.md §55;
 * round 12, §62: the 3-D body).
 *
 * The page opens on a three-dimensional body — one registered free model
 * per sex (male: Z-Anatomy, CC BY-SA 4.0; female: NIH Human Reference
 * Atlas, CC BY 4.0), cut into six layers ordered bone -> flesh so each
 * sits flush on the one beneath — with a depth control, a Male / Female
 * toggle, orbit and zoom, and clickable structures whose names come from
 * the models themselves (Terminologia Anatomica for the male, the HRA's
 * labels for the female). Picking a structure opens its organ entry in
 * the panel beside the stage; a structure with no entry of its own still
 * says exactly what it is. The "Diagrams" tab keeps the OpenStax layer
 * stage from round 7 (and is the fallback without WebGL).
 *
 * The panel carries that system's description, functions, the systems it
 * works with (a chip jumps to it) and its organs, each opening to its own
 * entry. Below the viewer, the cooperation notes describe how the systems
 * act together, because that is the part a list of organs never conveys.
 *
 * Everything shown comes from data/anatomy/; the diagrams are the
 * original Commons files and the models carry their manifest's
 * attribution, credited under the stage.
 */

interface View {
  id: string
  label: string
  system: string
  images: AnatomyLayer[]
  /** True for the whole-body layers; false for a figure-backed view. */
  isLayer: boolean
}

type Tab = '3d' | 'diagrams'
const SEX_KEY = 'anatomy.sex'
const TAB_KEY = 'anatomy.tab'

function readHash(): { kind: 'system' | 'organ'; id: string } | null {
  const hash = window.location.hash.replace('#', '')
  if (!hash) return null
  if (hash.startsWith('organ-')) return { kind: 'organ', id: hash.slice(6) }
  return { kind: 'system', id: hash }
}

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key)
    return value && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
  } catch {
    return fallback
  }
}

function store(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* private mode: the choice simply does not persist */
  }
}

function layerForSystem(systemId: string): number {
  const index = LAYER_ORDER.findIndex((id) => LAYER_SYSTEMS[id].includes(systemId))
  return index >= 0 ? index : LAYER_ORDER.length - 1
}

export function AnatomyPage() {
  const state = useAnatomy()
  const file = state.status === 'ready' ? state.data : null

  const views = useMemo<View[]>(() => {
    if (!file) return []
    const layerViews: View[] = file.layers.map((layer) => ({
      id: layer.id,
      label: layer.label ?? layer.system,
      system: layer.system,
      images: [layer],
      isLayer: true,
    }))
    const covered = new Set(layerViews.map((view) => view.system))
    const extra: View[] = file.systems
      .filter((system) => !covered.has(system.id))
      .map((system) => ({
        id: `system-${system.id}`,
        label: system.name.replace(/ system$/i, ''),
        system: system.id,
        images: file.figures.filter((figure) => figure.system === system.id),
        isLayer: false,
      }))
      .filter((view) => view.images.length > 0)
    return [...layerViews, ...extra]
  }, [file])

  // ---- Shared state --------------------------------------------------------
  const [tab, setTab] = useState<Tab>(() => readStored<Tab>(TAB_KEY, ['3d', 'diagrams'], '3d'))
  const [viewIndex, setViewIndex] = useState(0)
  const [figureIndex, setFigureIndex] = useState(0)
  const [openOrgan, setOpenOrgan] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const organRefs = useRef(new Map<string, HTMLElement>())

  // ---- 3-D state -------------------------------------------------------------
  const [sex, setSexState] = useState<Sex>(() => readStored<Sex>(SEX_KEY, ['male', 'female'], 'male'))
  const [depth, setDepth] = useState(LAYER_ORDER.length - 1)
  const [seeThrough, setSeeThrough] = useState(false)
  const [selected, setSelected] = useState<ModelStructure | null>(null)
  const [panelSystem, setPanelSystem] = useState<string | null>(null)
  const [manifest, setManifest] = useState<ModelManifest | null>(null)
  const [manifestError, setManifestError] = useState<string | null>(null)
  const [structures, setStructures] = useState<{ sex: Sex; list: ModelStructure[] } | null>(null)
  const [structuresError, setStructuresError] = useState<string | null>(null)

  const compact = useMemo(
    () => window.matchMedia('(pointer: coarse) and (max-width: 768px)').matches,
    [],
  )
  const reducedMotion = useMemo(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches, [])

  useEffect(() => {
    let cancelled = false
    loadModelManifest()
      .then((data) => {
        if (!cancelled) setManifest(data)
      })
      .catch((error: unknown) => {
        if (!cancelled) setManifestError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setStructuresError(null)
    loadStructures(sex)
      .then((list) => {
        if (!cancelled) setStructures({ sex, list })
      })
      .catch((error: unknown) => {
        if (!cancelled) setStructuresError(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [sex])

  const structureList = structures?.sex === sex ? structures.list : null

  const systemsById = useMemo(
    () => new Map((file?.systems ?? []).map((system) => [system.id, system])),
    [file],
  )
  const organsById = useMemo(
    () => new Map((file?.organs ?? []).map((organ) => [organ.id, organ])),
    [file],
  )
  const organNames = useMemo(
    () => new Map((file?.organs ?? []).map((organ) => [organ.id, organ.name])),
    [file],
  )

  /** Which layer holds most of an organ's meshes in the current model. */
  const layerOfOrgan = useCallback(
    (organId: string): number | null => {
      if (!structureList) return null
      const counts = new Map<LayerId, number>()
      for (const structure of structureList) {
        if (structure.organ === organId) counts.set(structure.layer, (counts.get(structure.layer) ?? 0) + 1)
      }
      let best: LayerId | null = null
      let bestCount = 0
      for (const [layer, count] of counts) {
        if (count > bestCount) {
          best = layer
          bestCount = count
        }
      }
      return best ? LAYER_ORDER.indexOf(best) : null
    },
    [structureList],
  )

  const setSex = (next: Sex) => {
    setSexState(next)
    store(SEX_KEY, next)
    setSelected(null)
  }
  const chooseTab = (next: Tab) => {
    setTab(next)
    store(TAB_KEY, next)
  }

  // Deep links: /anatomy#skeleton opens that layer / view, /anatomy#organ-heart
  // opens the heart's system, expands the organ and selects it in 3-D.
  useEffect(() => {
    if (!file || views.length === 0) return
    const target = readHash()
    if (!target) return
    if (target.kind === 'organ') {
      const organ = organsById.get(target.id)
      if (!organ) return
      const index = views.findIndex((v) => v.system === organ.systems[0])
      if (index >= 0) setViewIndex(index)
      setOpenOrgan(organ.id)
      setPanelSystem(organ.systems[0] ?? null)
      return
    }
    const index = views.findIndex((v) => v.system === target.id || v.id === target.id)
    if (index >= 0) setViewIndex(index)
    if (systemsById.has(target.id)) {
      setPanelSystem(target.id)
      setDepth(layerForSystem(target.id))
    }
  }, [file, views, organsById, systemsById])

  // Once the structure index is in, move the depth to the deep-linked organ's layer.
  useEffect(() => {
    if (!openOrgan || !structureList) return
    const layer = layerOfOrgan(openOrgan)
    if (layer !== null) setDepth(layer)
  }, [structureList, openOrgan, layerOfOrgan])

  useEffect(() => {
    setFigureIndex(0)
  }, [viewIndex])

  useEffect(() => {
    if (!openOrgan) return
    const node = organRefs.current.get(openOrgan)
    node?.scrollIntoView({ block: 'nearest', behavior: reducedMotion ? 'auto' : 'smooth' })
  }, [openOrgan, reducedMotion])

  const goTo = (index: number) => {
    const next = Math.max(0, Math.min(views.length - 1, index))
    setViewIndex(next)
    setOpenOrgan(null)
    const target = views[next]
    if (target) {
      setPanelSystem(target.system)
      history.replaceState(null, '', `#${target.system}`)
    }
  }

  const jumpToSystem = (systemId: string) => {
    setPanelSystem(systemId)
    setOpenOrgan(null)
    setSelected(null)
    if (tab === '3d') {
      setDepth(layerForSystem(systemId))
      history.replaceState(null, '', `#${systemId}`)
    } else {
      const index = views.findIndex((v) => v.system === systemId)
      if (index >= 0) goTo(index)
    }
    panelRef.current?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' })
  }

  /** Open an organ entry and, in 3-D, move to its layer and light it up. */
  const revealOrgan = (organId: string, options: { fromModel?: boolean } = {}) => {
    const organ = organsById.get(organId)
    if (!organ) return
    setOpenOrgan(organId)
    setPanelSystem(organ.systems[0] ?? null)
    history.replaceState(null, '', `#organ-${organId}`)
    if (tab === '3d') {
      const layer = layerOfOrgan(organId)
      if (layer !== null && !options.fromModel) setDepth(layer)
      if (!options.fromModel) setSelected(null)
    } else {
      const index = views.findIndex((v) => v.system === organ.systems[0])
      if (index >= 0) setViewIndex(index)
    }
  }

  const onPick = (structure: ModelStructure | null) => {
    setSelected(structure)
    if (!structure) return
    if (structure.organ && organsById.has(structure.organ)) {
      revealOrgan(structure.organ, { fromModel: true })
    } else {
      setOpenOrgan(null)
      if (structure.system && systemsById.has(structure.system)) setPanelSystem(structure.system)
    }
  }

  const onDepthChange = (next: number) => {
    setDepth(next)
    setSelected(null)
    setOpenOrgan(null)
    const first = LAYER_SYSTEMS[layerAt(next)][0] ?? null
    setPanelSystem(first)
    if (first) history.replaceState(null, '', `#${first}`)
  }

  // ---- Derived for rendering -------------------------------------------------
  const view = views[viewIndex] ?? null
  const diagramSystem = view ? systemsById.get(view.system) ?? null : null
  const layerSystems = useMemo(() => {
    const ids = new Set<string>(LAYER_SYSTEMS[layerAt(depth)])
    if (structureList) {
      for (const structure of structureList) {
        if (structure.layer === layerAt(depth) && structure.system && systemsById.has(structure.system)) {
          ids.add(structure.system)
        }
      }
    }
    return [...ids]
  }, [depth, structureList, systemsById])
  const system =
    tab === '3d'
      ? systemsById.get(panelSystem ?? '') ?? systemsById.get(layerSystems[0] ?? '') ?? null
      : diagramSystem
  const current = view?.images[figureIndex] ?? view?.images[0] ?? null
  const figuresForSystem = useMemo(
    () => (file && system ? file.figures.filter((f) => f.system === system.id) : []),
    [file, system],
  )
  const selectedOrgan = selected?.organ ? organsById.get(selected.organ) ?? null : null

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6">
      <header>
        <p
          className="font-sans text-xs font-medium uppercase tracking-widest"
          style={{ color: 'var(--text-muted)' }}
        >
          Anatomy
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Human Anatomy</h1>
        <p className="mt-2 max-w-3xl text-sm" style={{ color: 'var(--text-muted)' }}>
          The body in layers, from the skeleton out to the skin. Rotate and zoom a
          three-dimensional body, peel it layer by layer, switch between the male and the
          female model, and click any structure to read what it is; each layer is one or more of
          the body's systems, and the panel beside the body carries the system's description,
          its organs and the systems it works with. Descriptions follow OpenStax Anatomy and
          Physiology 2e and cite their chapter; every model and diagram carries its author and
          licence.
        </p>
      </header>

      {state.status === 'error' && (
        <div className="mt-6">
          <Unavailable what="Human Anatomy" source="the anatomy artifacts" reason={state.error.message} />
        </div>
      )}
      {state.status === 'loading' && (
        <p className="mt-6 text-sm" style={{ color: 'var(--text-muted)' }}>
          Loading the anatomy reference…
        </p>
      )}

      {file && view && (
        <>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <div className="anatomy-tabs" role="tablist" aria-label="Stage">
              <button type="button" role="tab" aria-selected={tab === '3d'} onClick={() => chooseTab('3d')}>
                3-D body
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'diagrams'}
                onClick={() => chooseTab('diagrams')}
              >
                Diagrams
              </button>
            </div>
            {tab === 'diagrams' && (
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                OpenStax Figure 1.4 panels, outer to inner
              </span>
            )}
          </div>

          {tab === 'diagrams' && (
            <>
              {/* Depth control: the layers in order, outer to inner. */}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => goTo(viewIndex - 1)}
                  disabled={viewIndex === 0}
                  className="rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                  aria-label="Previous layer (outward)"
                >
                  ← Outward
                </button>
                <button
                  type="button"
                  onClick={() => goTo(viewIndex + 1)}
                  disabled={viewIndex >= views.length - 1}
                  className="rounded-lg border px-3 py-2 text-sm font-medium disabled:opacity-40"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                  aria-label="Next layer (deeper)"
                >
                  Deeper →
                </button>
                <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                  Layer {viewIndex + 1} of {views.length}
                </span>
              </div>
              <ol
                className="anatomy-layers mt-3 flex gap-1.5 overflow-x-auto pb-1"
                aria-label="Layers, outer to inner"
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                    event.preventDefault()
                    goTo(viewIndex + 1)
                  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                    event.preventDefault()
                    goTo(viewIndex - 1)
                  }
                }}
              >
                {views.map((item, index) => {
                  const active = index === viewIndex
                  return (
                    <li key={item.id} className="shrink-0">
                      <button
                        type="button"
                        aria-current={active ? 'step' : undefined}
                        onClick={() => goTo(index)}
                        className="rounded-full border px-3 py-1.5 text-xs font-medium"
                        style={{
                          borderColor: active ? 'transparent' : 'var(--border)',
                          background: active ? 'var(--control-selected-bg)' : 'var(--surface-raised)',
                          color: active ? 'var(--control-selected-text)' : 'var(--text)',
                        }}
                      >
                        {index + 1}. {item.label}
                      </button>
                    </li>
                  )
                })}
              </ol>
            </>
          )}

          <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,30rem)_minmax(0,1fr)]">
            {tab === '3d' ? (
              <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
                {manifest ? (
                  <BodyStage
                    manifest={manifest}
                    structures={structureList}
                    structuresError={structuresError}
                    sex={sex}
                    onSex={setSex}
                    depth={depth}
                    onDepth={onDepthChange}
                    seeThrough={seeThrough}
                    onSeeThrough={setSeeThrough}
                    selected={selected}
                    onPick={onPick}
                    highlightOrgan={openOrgan}
                    organNames={organNames}
                    onOpenOrgan={(id) => revealOrgan(id, { fromModel: true })}
                    compact={compact}
                    reducedMotion={reducedMotion}
                  />
                ) : manifestError ? (
                  <Unavailable what="the 3-D body" source="data/anatomy/models" reason={manifestError} />
                ) : (
                  <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
                    Loading the model index…
                  </p>
                )}
              </div>
            ) : (
              current && (
                /* Stage: every view's first image is stacked and cross-faded so
                   a step to the next layer never flashes empty. */
                <figure className="m-0 lg:sticky lg:top-4 lg:self-start">
                  <div
                    className="anatomy-stage relative w-full overflow-hidden rounded-xl border"
                    style={{
                      borderColor: 'var(--border)',
                      background: 'oklch(99% 0 0)',
                      aspectRatio: '3 / 4',
                    }}
                  >
                    {views.map((item, index) => {
                      const image = index === viewIndex ? current : item.images[0]
                      if (!image) return null
                      const shown = index === viewIndex
                      return (
                        <img
                          key={`${item.id}-${image.id}`}
                          src={anatomyImageUrl(image.image)}
                          alt={shown ? `${item.label}: ${image.caption}` : ''}
                          aria-hidden={!shown}
                          loading={Math.abs(index - viewIndex) <= 1 ? 'eager' : 'lazy'}
                          className="absolute inset-0 h-full w-full object-contain p-3 transition-opacity duration-300"
                          style={{ opacity: shown ? 1 : 0 }}
                        />
                      )
                    })}
                  </div>
                  {view.images.length > 1 && (
                    <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Figures">
                      {view.images.map((image, index) => (
                        <button
                          key={image.id}
                          type="button"
                          aria-pressed={index === figureIndex}
                          onClick={() => setFigureIndex(index)}
                          className="rounded border px-2 py-1 text-xs"
                          style={{
                            borderColor: 'var(--border)',
                            background: index === figureIndex ? 'var(--control-selected-bg)' : 'transparent',
                            color: index === figureIndex ? 'var(--control-selected-text)' : 'var(--text)',
                          }}
                        >
                          {image.label ?? image.id.replace(/-/g, ' ')}
                        </button>
                      ))}
                    </div>
                  )}
                  <figcaption className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {current.caption}{' '}
                    <span className="block">
                      {current.image.author} · {current.image.licence} ·{' '}
                      <a
                        className="underline underline-offset-2"
                        href={current.image.sourcePage}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Wikimedia Commons
                      </a>
                    </span>
                  </figcaption>
                </figure>
              )
            )}

            {/* The layer's system, and in 3-D the picked structure. */}
            <div ref={panelRef} className="min-w-0 scroll-mt-4 space-y-4">
              {tab === '3d' && selected && (
                <div className="anatomy-picked" aria-live="polite">
                  <h3>{selected.name}</h3>
                  <p className="anatomy-picked-meta m-0">
                    {selected.latin && <span>{selected.latin} · </span>}
                    {selected.hraLabel && selected.hraLabel.toLowerCase() !== selected.name.toLowerCase() && (
                      <span>HRA label: {selected.hraLabel} · </span>
                    )}
                    {selected.ontology && <span>{selected.ontology} · </span>}
                    {selected.system && systemsById.has(selected.system)
                      ? systemsById.get(selected.system)!.name
                      : 'system not recorded by the source'}
                    {selected.group && ` · ${selected.group}`}
                  </p>
                  <p className="m-0 text-sm">
                    {selectedOrgan ? (
                      <>
                        Entry: <strong>{selectedOrgan.name}</strong>, opened below.
                      </>
                    ) : (
                      <>Detailed entry not available for this structure; its name and system are as the model records them.</>
                    )}
                  </p>
                  <div className="anatomy-picked-actions">
                    <button type="button" className="anatomy-button" onClick={() => setSelected(null)}>
                      Clear selection
                    </button>
                  </div>
                </div>
              )}
              {tab === '3d' && layerSystems.length > 1 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="Systems in this layer">
                  <span style={{ color: 'var(--text-muted)' }}>In this layer:</span>
                  {layerSystems.map((id) => {
                    const item = systemsById.get(id)
                    if (!item) return null
                    const active = system?.id === id
                    return (
                      <button
                        key={id}
                        type="button"
                        aria-pressed={active}
                        className="rounded-full border px-2.5 py-1.5"
                        style={{
                          borderColor: active ? 'transparent' : 'var(--border)',
                          background: active ? 'var(--control-selected-bg)' : 'var(--surface-raised)',
                          color: active ? 'var(--control-selected-text)' : 'var(--text)',
                          minHeight: 32,
                        }}
                        onClick={() => {
                          setPanelSystem(id)
                          setOpenOrgan(null)
                        }}
                      >
                        {item.name.replace(/ system$/i, '').replace(/ \(.*\)$/, '')}
                      </button>
                    )
                  })}
                </div>
              )}
              {system && (
                <SystemPanel
                  system={system}
                  file={file}
                  figures={figuresForSystem}
                  systemsById={systemsById}
                  organsById={organsById}
                  openOrgan={openOrgan}
                  onOpenOrgan={(id) => {
                    if (id && id !== openOrgan) revealOrgan(id)
                    else {
                      setOpenOrgan(null)
                      setSelected(null)
                    }
                  }}
                  onJumpSystem={jumpToSystem}
                  registerOrgan={(id, node) => {
                    if (node) organRefs.current.set(id, node)
                    else organRefs.current.delete(id)
                  }}
                />
              )}
            </div>
          </div>

          <section className="mt-10" aria-labelledby="cooperation-heading">
            <h2 id="cooperation-heading" className="text-xl">
              How the systems work together
            </h2>
            <p className="mt-1 max-w-3xl text-sm" style={{ color: 'var(--text-muted)' }}>
              No system works alone. Each of these is one job traced across the
              systems that share it; the chips jump to a system's layer.
            </p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {file.cooperation.map((note) => (
                <article
                  key={note.title}
                  className="rounded-xl border px-4 py-4"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                >
                  <h3 className="m-0 text-base font-semibold">{note.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed">{note.text}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {note.systems.map((id) => (
                      <SystemChip key={id} system={systemsById.get(id)} onJump={jumpToSystem} />
                    ))}
                  </div>
                </article>
              ))}
            </div>
          </section>

          <section className="mt-10" aria-labelledby="index-heading">
            <h2 id="index-heading" className="text-xl">
              All organs
            </h2>
            <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
              {file.organs.length} entries across {file.systems.length} systems; an organ that
              belongs to several is listed once, under its first.
            </p>
            <ul className="mt-3 flex flex-wrap gap-1.5">
              {[...file.organs]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((organ) => (
                  <li key={organ.id}>
                    <button
                      type="button"
                      className="rounded-full border px-2.5 py-1 text-xs"
                      style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
                      onClick={() => {
                        revealOrgan(organ.id)
                        panelRef.current?.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' })
                      }}
                    >
                      {organ.name}
                    </button>
                  </li>
                ))}
            </ul>
          </section>

          <div className="mt-8">
            <CollapsibleSources count={file.systems.length + file.layers.length + file.figures.length + 2}>
              <ul className="space-y-1 text-xs">
                <li>
                  Text: plain-language paraphrases written for this site after{' '}
                  <a
                    className="underline underline-offset-2"
                    href="https://openstax.org/books/anatomy-and-physiology-2e/pages/1-introduction"
                    target="_blank"
                    rel="noreferrer"
                  >
                    OpenStax, Anatomy and Physiology 2e
                  </a>{' '}
                  (Rice University, CC BY 4.0); each system and organ cites its chapter.
                </li>
                {manifest &&
                  (['male', 'female'] as Sex[]).map((id) => {
                    const source = manifest.sexes[id].source
                    return (
                      <li key={id} style={{ color: 'var(--text-muted)' }}>
                        3-D {id} model:{' '}
                        <a className="underline underline-offset-2" href={source.sourcePage} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>{' '}
                        — {source.author} ·{' '}
                        <a className="underline underline-offset-2" href={source.licenceUrl} target="_blank" rel="noreferrer">
                          {source.licence}
                        </a>
                        {source.attribution ? ` · ${source.attribution}` : ''} · {(manifest.sexes[id].totalBytes / 1e6).toFixed(1)} MB in{' '}
                        {manifest.sexes[id].layers.length} layers, {manifest.sexes[id].structureCount.toLocaleString()} named structures;
                        provenance (source URLs, sha256) in data/anatomy/models/manifest.json.
                      </li>
                    )
                  })}
                {[...file.layers, ...file.figures].map((image) => (
                  <li key={image.id} style={{ color: 'var(--text-muted)' }}>
                    <a
                      className="underline underline-offset-2"
                      href={image.image.sourcePage}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {image.image.title}
                    </a>{' '}
                    — {image.image.author} · {image.image.licence} · Wikimedia Commons
                  </li>
                ))}
              </ul>
            </CollapsibleSources>
          </div>
        </>
      )}
    </div>
  )
}

function SystemChip({
  system,
  onJump,
}: {
  system: AnatomySystem | undefined
  onJump: (id: string) => void
}) {
  if (!system) return null
  return (
    <button
      type="button"
      onClick={() => onJump(system.id)}
      className="rounded-full border px-2.5 py-1 text-xs"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      {system.name.replace(/ system$/i, '').replace(/ \(.*\)$/, '')}
    </button>
  )
}

function SystemPanel({
  system,
  file,
  figures,
  systemsById,
  organsById,
  openOrgan,
  onOpenOrgan,
  onJumpSystem,
  registerOrgan,
}: {
  system: AnatomySystem
  file: AnatomyFile
  figures: AnatomyLayer[]
  systemsById: Map<string, AnatomySystem>
  organsById: Map<string, AnatomyOrgan>
  openOrgan: string | null
  onOpenOrgan: (id: string | null) => void
  onJumpSystem: (id: string) => void
  registerOrgan: (id: string, node: HTMLElement | null) => void
}) {
  // Organs that name this system second (the pancreas under endocrine,
  // the diaphragm under respiratory) are listed too, marked as shared.
  const shared = file.organs.filter(
    (organ) => organ.systems.includes(system.id) && !system.organs.includes(organ.id),
  )
  return (
    <div
      className="rounded-xl border px-5 py-5"
      style={{
        borderColor: 'var(--border)',
        background: 'var(--surface-raised)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      <h2 className="m-0 text-xl">{system.name}</h2>
      <p className="mt-1 text-sm font-medium">{system.summary}</p>
      <div className="mt-3 space-y-3 text-sm leading-relaxed">
        {system.description.map((paragraph, index) => (
          <p key={index} className="m-0">
            {paragraph}
          </p>
        ))}
      </div>

      <h3 className="mt-5 text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        What it does
      </h3>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-sm">
        {system.functions.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>

      <h3 className="mt-5 text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        Works with
      </h3>
      <ul className="mt-1.5 space-y-1.5 text-sm">
        {system.worksWith.map((link) => {
          const other = systemsById.get(link.system)
          return (
            <li key={link.system} className="flex flex-wrap items-baseline gap-x-2">
              <SystemChip system={other} onJump={onJumpSystem} />
              <span>{link.how}</span>
            </li>
          )
        })}
      </ul>

      {figures.length > 0 && (
        <>
          <h3 className="mt-5 text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
            Figures
          </h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {figures.map((figure) => (
              <figure key={figure.id} className="m-0">
                <img
                  src={anatomyImageUrl(figure.image)}
                  alt={figure.caption}
                  loading="lazy"
                  className="w-full rounded-lg border object-contain"
                  style={{ borderColor: 'var(--border)', background: 'oklch(99% 0 0)', maxHeight: '18rem' }}
                />
                <figcaption className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {figure.caption} — {figure.image.author} · {figure.image.licence}
                </figcaption>
              </figure>
            ))}
          </div>
        </>
      )}

      <h3 className="mt-5 text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
        Organs
      </h3>
      <ul className="mt-2 space-y-2">
        {[...system.organs.map((id) => organsById.get(id)), ...shared]
          .filter((organ): organ is AnatomyOrgan => organ !== undefined)
          .map((organ) => (
            <OrganCard
              key={organ.id}
              organ={organ}
              open={openOrgan === organ.id}
              onToggle={() => onOpenOrgan(openOrgan === organ.id ? null : organ.id)}
              shared={!system.organs.includes(organ.id)}
              systemsById={systemsById}
              onJumpSystem={onJumpSystem}
              register={(node) => registerOrgan(organ.id, node)}
            />
          ))}
      </ul>

      <p className="mt-4 text-xs" style={{ color: 'var(--text-muted)' }}>
        After{' '}
        <a className="underline underline-offset-2" href={system.source.url} target="_blank" rel="noreferrer">
          {system.source.title}
        </a>{' '}
        ({system.source.publisher}).
      </p>
    </div>
  )
}

function OrganCard({
  organ,
  open,
  onToggle,
  shared,
  systemsById,
  onJumpSystem,
  register,
}: {
  organ: AnatomyOrgan
  open: boolean
  onToggle: () => void
  shared: boolean
  systemsById: Map<string, AnatomySystem>
  onJumpSystem: (id: string) => void
  register: (node: HTMLElement | null) => void
}) {
  const bodyId = `organ-body-${organ.id}`
  return (
    <li
      ref={register}
      id={`organ-${organ.id}`}
      className="scroll-mt-4 rounded-lg border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full items-baseline justify-between gap-3 px-3 py-2.5 text-left"
      >
        <span>
          <span className="text-sm font-semibold">{organ.name}</span>
          {shared && (
            <span className="ml-2 text-xs" style={{ color: 'var(--text-muted)' }}>
              also under {systemsById.get(organ.systems[0] ?? '')?.name.replace(/ system$/i, '') ?? ''}
            </span>
          )}
          <span className="block text-xs" style={{ color: 'var(--text-muted)' }}>
            {organ.function}
          </span>
        </span>
        <span aria-hidden="true" className="shrink-0 text-xs" style={{ color: 'var(--text-muted)' }}>
          {open ? '▲' : '▼'}
        </span>
      </button>
      <div id={bodyId} hidden={!open} className="border-t px-3 pb-3 pt-2 text-sm" style={{ borderColor: 'var(--border)' }}>
        <p className="m-0 text-xs" style={{ color: 'var(--text-muted)' }}>
          <strong style={{ fontWeight: 600 }}>Where:</strong> {organ.location}
        </p>
        <div className="mt-2 space-y-2 leading-relaxed">
          {organ.description.map((paragraph, index) => (
            <p key={index} className="m-0">
              {paragraph}
            </p>
          ))}
        </div>
        {organ.facts.length > 0 && (
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {organ.facts.map((fact) => (
              <div key={fact.label} className="contents">
                <dt style={{ color: 'var(--text-muted)' }}>{fact.label}</dt>
                <dd className="m-0 tabular-nums">{fact.value}</dd>
              </div>
            ))}
          </dl>
        )}
        {organ.systems.length > 1 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
            <span style={{ color: 'var(--text-muted)' }}>Systems:</span>
            {organ.systems.map((id) => (
              <SystemChip key={id} system={systemsById.get(id)} onJump={onJumpSystem} />
            ))}
          </div>
        )}
        <p className="mt-3 text-xs" style={{ color: 'var(--text-muted)' }}>
          After{' '}
          <a className="underline underline-offset-2" href={organ.source.url} target="_blank" rel="noreferrer">
            {organ.source.title}
          </a>
          .
        </p>
      </div>
    </li>
  )
}

export default AnatomyPage
