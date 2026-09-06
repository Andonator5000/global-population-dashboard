import { useMemo, useState } from 'react'

import { Unavailable } from '../components/viz/primitives'
import {
  formatMa,
  useEvolutionChart,
  useEvolutionEvents,
  type EvolutionEvent,
  type IcsInterval,
} from '../lib/evolution'

/**
 * /evolution — the history of life (Phase 6; round-2 §40 rework).
 *
 * The page is the ICS chart made habitable: full-width banners for every
 * Eon, Era and Period, NESTED visually, each carrying its dates (with the
 * chart's stated uncertainties), a plain-language description, and the
 * name's etymology with a cited source. Each unit's span is tinted with a
 * light wash of the chart's own CGMW colour — deeper nesting, slightly
 * stronger wash — while event cards sit on the raised surface so they
 * stay legible on every tint. Events attach to the finest unit that
 * contains their start date. The axis is deliberately not linear; every
 * date prints its stated uncertainty.
 */

const KIND_LABELS: Record<EvolutionEvent['kind'], string> = {
  event: 'Event',
  organism: 'Organism',
  extinction: 'Mass extinction',
}

/** PhyloPic silhouettes are black-on-transparent; a fixed light chip keeps
 *  them visible in dark mode too. */
const SILHOUETTE_BG = 'oklch(96% 0.004 250)'

function eventDateLabel(event: EvolutionEvent): string {
  if (event.endMa === null) return `~${formatMa(event.startMa)}`
  if (event.endMa === 0) return `${formatMa(event.startMa)} → present`
  return `${formatMa(event.startMa)} → ${formatMa(event.endMa)}`
}

function unitSpan(interval: IcsInterval): string {
  const start = formatMa(interval.startMa, interval.startError)
  const end = formatMa(interval.endMa, interval.endError)
  const startFlag = interval.startUncertain ? ' (boundary uncertain)' : ''
  return `${start}${startFlag} → ${end}`
}

function EventCard({ event }: { event: EvolutionEvent }) {
  return (
    <details className="section-disclosure group mb-2">
      <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 rounded px-1.5 py-1">
        <span
          aria-hidden="true"
          className="inline-block h-2 w-2 shrink-0 self-center rounded-full"
          style={{
            background:
              event.kind === 'extinction'
                ? 'var(--nav-history)'
                : 'var(--nav-evolution)',
          }}
        />
        <span
          className="font-sans text-xs tabular-nums"
          style={{ color: 'var(--text-muted)' }}
        >
          {eventDateLabel(event)}
        </span>
        <span className="text-sm font-medium">{event.title}</span>
        <span
          className="rounded border px-1 py-px font-sans text-[10px]"
          style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
        >
          {KIND_LABELS[event.kind]}
        </span>
      </summary>
      <div
        className="mb-2 ml-4 mt-1 flex flex-wrap gap-4 rounded-lg border p-3"
        style={{
          borderColor: 'var(--border)',
          background: 'var(--surface-raised)',
        }}
      >
        {event.image && (
          <figure className="w-40 shrink-0">
            <div
              className="flex items-center justify-center rounded-lg p-2"
              style={{
                background:
                  event.image.type === 'phylopic'
                    ? SILHOUETTE_BG
                    : 'var(--surface)',
              }}
            >
              <img
                src={event.image.url}
                alt={
                  event.image.type === 'phylopic'
                    ? `Silhouette of ${event.image.matched ?? event.title}`
                    : event.title
                }
                loading="lazy"
                className="max-h-32 w-auto max-w-full"
              />
            </div>
            <figcaption
              className="mt-1 text-[10px] leading-snug"
              style={{ color: 'var(--text-muted)' }}
            >
              {event.image.type === 'phylopic' ? 'Silhouette: ' : 'Image: '}
              {event.image.attribution ?? 'unknown author'} ·{' '}
              <a
                className="underline underline-offset-2"
                href={event.image.page}
                target="_blank"
                rel="noreferrer"
              >
                {event.image.type === 'phylopic' ? 'PhyloPic' : 'Commons'}
              </a>{' '}
              ·{' '}
              {/^https?:/.test(event.image.license) ? (
                <a
                  className="underline underline-offset-2"
                  href={event.image.license}
                  target="_blank"
                  rel="noreferrer"
                >
                  licence
                </a>
              ) : (
                event.image.license
              )}
            </figcaption>
          </figure>
        )}
        <div className="min-w-56 flex-1">
          <p className="max-w-2xl text-sm">{event.summary}</p>
          <p className="mt-2 flex flex-wrap gap-x-4 text-sm">
            <a
              className="underline underline-offset-2"
              href={event.wikipedia}
              target="_blank"
              rel="noreferrer"
            >
              Wikipedia
            </a>
            {event.sources
              .filter((url) => !url.includes('en.wikipedia.org'))
              .map((url) => (
                <a
                  key={url}
                  className="underline underline-offset-2"
                  href={url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {new URL(url).hostname.replace(/^www\./, '')}
                </a>
              ))}
          </p>
        </div>
      </div>
    </details>
  )
}

export function EvolutionPage() {
  const chartState = useEvolutionChart()
  const eventsState = useEvolutionEvents()
  const [showEpochNote] = useState(false)
  void showEpochNote

  const chart = chartState.status === 'ready' ? chartState.data : null
  const eventsFile = eventsState.status === 'ready' ? eventsState.data : null

  const { unitChildren, eventsByUnit, eons } = useMemo(() => {
    const childrenOf = new Map<string, IcsInterval[]>()
    const byId = new Map<string, IcsInterval>()
    const wanted = (chart?.intervals ?? []).filter((i) =>
      ['Eon', 'Era', 'Period'].includes(i.rank),
    )
    for (const interval of wanted) byId.set(interval.id, interval)
    for (const interval of wanted) {
      if (interval.parent && byId.has(interval.parent)) {
        const list = childrenOf.get(interval.parent) ?? []
        list.push(interval)
        childrenOf.set(interval.parent, list)
      }
    }
    for (const list of childrenOf.values()) {
      list.sort((a, b) => b.startMa - a.startMa)
    }
    const eonList = wanted
      .filter((i) => i.rank === 'Eon')
      .sort((a, b) => b.startMa - a.startMa)

    // Attach each event to the FINEST unit containing its start date.
    const byUnit = new Map<string, EvolutionEvent[]>()
    const contains = (unit: IcsInterval, ma: number) =>
      ma <= unit.startMa && ma > unit.endMa
    const finestFor = (ma: number): IcsInterval | null => {
      let current: IcsInterval | null =
        eonList.find((eon) => contains(eon, ma)) ??
        (ma >= (eonList[0]?.startMa ?? 0) ? (eonList[0] ?? null) : null)
      while (current) {
        const finer: IcsInterval | undefined = (
          childrenOf.get(current.id) ?? []
        ).find((child) => contains(child, ma))
        if (!finer) return current
        current = finer
      }
      return null
    }
    const sorted = [...(eventsFile?.events ?? [])].sort(
      (a, b) => b.startMa - a.startMa,
    )
    for (const event of sorted) {
      const unit = finestFor(Math.min(event.startMa, eonList[0]?.startMa ?? event.startMa))
      const key = unit?.id ?? 'unplaced'
      const list = byUnit.get(key) ?? []
      list.push(event)
      byUnit.set(key, list)
    }
    return { unitChildren: childrenOf, eventsByUnit: byUnit, eons: eonList }
  }, [chart, eventsFile])

  const loading =
    chartState.status === 'loading' || eventsState.status === 'loading'
  const error = chartState.status === 'error' || eventsState.status === 'error'

  function renderUnit(interval: IcsInterval, depth: number): React.ReactNode {
    const children = unitChildren.get(interval.id) ?? []
    const events = eventsByUnit.get(interval.id) ?? []
    const wash = 8 + depth * 5
    return (
      <section
        key={interval.id}
        className="mt-3 rounded-lg"
        style={{
          background: interval.color
            ? `color-mix(in oklab, ${interval.color} ${wash}%, var(--surface))`
            : 'var(--surface)',
        }}
      >
        {/* Full-width unit banner (round-2 §40): flow layout inside a
            block, so wrapping can never overlap anything. */}
        <div
          className="rounded-t-lg border-t-4 px-3 py-2 sm:px-4"
          style={{ borderColor: interval.color ?? 'var(--border-strong)' }}
        >
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
            <h2
              className="font-display m-0 leading-tight"
              style={{ fontSize: depth === 0 ? '1.35rem' : depth === 1 ? '1.15rem' : '1rem' }}
            >
              {interval.name}
            </h2>
            <span
              className="font-sans text-[10px] uppercase tracking-widest"
              style={{ color: 'var(--text-muted)' }}
            >
              {interval.rank}
            </span>
            <span
              className="text-xs tabular-nums"
              style={{ color: 'var(--text-muted)' }}
            >
              {unitSpan(interval)}
            </span>
          </div>
          {(interval.description || interval.etymology) && (
            <p
              className="mb-0 mt-1 max-w-4xl text-xs leading-snug"
              style={{ color: 'var(--text-muted)' }}
            >
              {interval.description}
              {interval.etymology && (
                <>
                  {' '}
                  <em>{interval.etymology}</em>
                  {interval.etymologySource && (
                    <>
                      {' '}
                      <a
                        className="underline underline-offset-2"
                        href={interval.etymologySource}
                        target="_blank"
                        rel="noreferrer"
                      >
                        [source]
                      </a>
                    </>
                  )}
                </>
              )}
            </p>
          )}
        </div>
        {(events.length > 0 || children.length > 0) && (
          <div className="px-2 pb-2 sm:px-3">
            {events.map((event) => (
              <EventCard key={event.id} event={event} />
            ))}
            {children.map((child) => renderUnit(child, depth + 1))}
          </div>
        )}
      </section>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Evolution</h1>
        <p
          className="mt-2 max-w-3xl text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          The history of life on Earth, structured by the{' '}
          <a
            className="underline underline-offset-2"
            href={chart?.url ?? 'https://stratigraphy.org/chart'}
            target="_blank"
            rel="noreferrer"
          >
            ICS International Chronostratigraphic Chart
          </a>{' '}
          — every eon, era and period as a banner in the chart's own
          colours, with what defined it and where its name came from. The
          axis is deliberately not linear; every date carries the
          uncertainty the evidence supports.
        </p>
      </header>

      {/* Round-2 §40.2: how the system works, collapsed by default. */}
      <details
        className="section-disclosure mt-5 rounded-lg border px-4 py-2"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
      >
        <summary className="cursor-pointer text-sm font-medium">
          Why deep time is divided this way
        </summary>
        <div
          className="mt-2 max-w-3xl space-y-2 pb-2 text-sm"
          style={{ color: 'var(--text)' }}
        >
          <p>
            Geologists slice Earth's 4.54 billion years into a nested
            hierarchy — eons, eras, periods, epochs and ages — with each
            boundary set where the rock record itself changes: a mass
            extinction's aftermath, a shift in ocean chemistry, the first
            appearance of a distinctive fossil.
          </p>
          <p>
            Since 1977, most boundaries have been pinned to a physical
            reference point: a Global Boundary Stratotype Section and Point
            (GSSP), or "golden spike" — an actual marked layer in an actual
            outcrop that defines, say, where the Cambrian begins. Boundaries
            deeper in time, where usable outcrops are scarce, are instead
            set at round numeric ages; that is why Precambrian boundaries
            look suspiciously tidy.
          </p>
          <p>
            The chart is maintained by the International Commission on
            Stratigraphy (ICS), which ratifies each spike and republishes
            the chart as dating improves — this page is built from the
            commission's own machine-readable edition, and the banner
            colours are the chart's official ones.
          </p>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Sources:{' '}
            <a
              className="underline underline-offset-2"
              href="https://stratigraphy.org/chart"
              target="_blank"
              rel="noreferrer"
            >
              ICS International Chronostratigraphic Chart
            </a>
            {' · '}
            <a
              className="underline underline-offset-2"
              href="https://en.wikipedia.org/wiki/Global_Boundary_Stratotype_Section_and_Point"
              target="_blank"
              rel="noreferrer"
            >
              GSSP (Wikipedia)
            </a>
          </p>
        </div>
      </details>

      {error && (
        <div className="mt-6">
          <Unavailable
            what="Evolution timeline"
            source="the ICS chart and editorial events file"
          />
        </div>
      )}
      {loading && !error && (
        <p className="mt-6" style={{ color: 'var(--text-muted)' }}>
          Loading the last 4.54 billion years…
        </p>
      )}

      {chart && eventsFile && (
        <>
          <div className="mt-4">
            {eons.map((eon) => renderUnit(eon, 0))}
          </div>
          <p className="mt-8 text-xs" style={{ color: 'var(--text-muted)' }}>
            {eventsFile.imageNote} Chart: International Commission on
            Stratigraphy, CC BY 4.0; banner colours follow the CGMW
            standard.
          </p>
        </>
      )}
    </div>
  )
}
