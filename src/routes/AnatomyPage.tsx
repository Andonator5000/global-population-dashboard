import { useEffect, useMemo, useRef, useState } from 'react'

import { CollapsibleSources } from '../components/CollapsibleSources'
import { Unavailable } from '../components/viz/primitives'
import {
  anatomyImageUrl,
  useAnatomy,
  type AnatomyFile,
  type AnatomyLayer,
  type AnatomyOrgan,
  type AnatomySystem,
} from '../lib/anatomy'

/**
 * /anatomy — the human body in layers (round 6, DATA_DECISIONS.md §55).
 *
 * The stage shows one whole-body diagram at a time, ordered from the
 * outside in — skin, muscles, heart and vessels, airways, gut, lymph,
 * nerves, glands, kidneys, skeleton — and the reader steps through them
 * with the depth control (buttons, the chip list, or the arrow keys).
 * Each layer IS a system: the panel beside it carries that system's
 * description, functions, the systems it works with (a chip jumps to
 * that layer) and its organs, each of which opens to its own entry.
 * Systems that have no whole-body layer of their own (reproductive)
 * get a view built from their figures. Below the viewer, the
 * cooperation notes describe how the systems act together, because
 * that is the part a list of organs never conveys.
 *
 * Everything shown comes from data/anatomy/anatomy.json; the diagrams
 * are the original Commons files, credited under the stage.
 */

interface View {
  id: string
  label: string
  system: string
  images: AnatomyLayer[]
  /** True for the whole-body layers; false for a figure-backed view. */
  isLayer: boolean
}

function readHash(): { kind: 'system' | 'organ'; id: string } | null {
  const hash = window.location.hash.replace('#', '')
  if (!hash) return null
  if (hash.startsWith('organ-')) return { kind: 'organ', id: hash.slice(6) }
  return { kind: 'system', id: hash }
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

  const [viewIndex, setViewIndex] = useState(0)
  const [figureIndex, setFigureIndex] = useState(0)
  const [openOrgan, setOpenOrgan] = useState<string | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const organRefs = useRef(new Map<string, HTMLElement>())

  const systemsById = useMemo(
    () => new Map((file?.systems ?? []).map((system) => [system.id, system])),
    [file],
  )
  const organsById = useMemo(
    () => new Map((file?.organs ?? []).map((organ) => [organ.id, organ])),
    [file],
  )

  const view = views[viewIndex] ?? null
  const system = view ? systemsById.get(view.system) ?? null : null

  // Deep links: /anatomy#skeleton opens that view, /anatomy#organ-heart
  // opens the heart's system and expands the organ.
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
      return
    }
    const index = views.findIndex((v) => v.system === target.id || v.id === target.id)
    if (index >= 0) setViewIndex(index)
  }, [file, views, organsById])

  useEffect(() => {
    setFigureIndex(0)
    setOpenOrgan(null)
  }, [viewIndex])

  useEffect(() => {
    if (!openOrgan) return
    const node = organRefs.current.get(openOrgan)
    node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [openOrgan])

  const goTo = (index: number) => {
    const next = Math.max(0, Math.min(views.length - 1, index))
    setViewIndex(next)
    const target = views[next]
    if (target) history.replaceState(null, '', `#${target.system}`)
  }

  const jumpToSystem = (systemId: string) => {
    const index = views.findIndex((v) => v.system === systemId)
    if (index >= 0) {
      goTo(index)
      panelRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }
  }

  const current = view?.images[figureIndex] ?? view?.images[0] ?? null
  const figuresForSystem = useMemo(
    () => (file && system ? file.figures.filter((f) => f.system === system.id) : []),
    [file, system],
  )

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
          The body in layers, from the skin inward to the skeleton. Each layer is
          one of the body's systems: read what it does, open its organs, and follow
          the links to the systems it works with. Below the diagram, how the systems
          act together. Descriptions follow OpenStax Anatomy and Physiology 2e and cite
          their chapter; every diagram carries its author and licence.
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

      {file && view && system && current && (
        <>
          {/* Depth control: the layers in order, outer to inner. */}
          <div className="mt-5 flex flex-wrap items-center gap-2">
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

          <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
            {/* Stage: every view's first image is stacked and cross-faded so
                a step to the next layer never flashes empty. */}
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

            {/* The layer's system. */}
            <div ref={panelRef} className="min-w-0 scroll-mt-4">
              <SystemPanel
                system={system}
                file={file}
                figures={figuresForSystem}
                systemsById={systemsById}
                organsById={organsById}
                openOrgan={openOrgan}
                onOpenOrgan={(id) => {
                  setOpenOrgan((prev) => (prev === id ? null : id))
                  if (id) history.replaceState(null, '', `#organ-${id}`)
                }}
                onJumpSystem={jumpToSystem}
                registerOrgan={(id, node) => {
                  if (node) organRefs.current.set(id, node)
                  else organRefs.current.delete(id)
                }}
              />
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
                        const index = views.findIndex((v) => v.system === organ.systems[0])
                        if (index >= 0) goTo(index)
                        // The view change resets the open organ; open it after.
                        requestAnimationFrame(() => {
                          setOpenOrgan(organ.id)
                          history.replaceState(null, '', `#organ-${organ.id}`)
                        })
                      }}
                    >
                      {organ.name}
                    </button>
                  </li>
                ))}
            </ul>
          </section>

          <div className="mt-8">
            <CollapsibleSources count={file.systems.length + file.layers.length + file.figures.length}>
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
