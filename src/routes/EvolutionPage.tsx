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
 * /biology/evolution -- the history of life on Earth (Phase 6).
 *
 * Follows the Human History timeline's editorial ruling on time axes: the
 * axis is deliberately NOT linear -- a linear 4.54-billion-year axis would
 * crush the entire Phanerozoic into a sliver -- so the page is banded by
 * ICS chart intervals at a reader-chosen granularity, every band states
 * its own span, and every event prints its dates with their stated
 * uncertainty. Events open in place (<details>) with the illustration,
 * its licence and attribution, and links out.
 */

const GRANULARITIES = ['Eon', 'Era', 'Period'] as const
type Granularity = (typeof GRANULARITIES)[number]

/** PhyloPic silhouettes are black-on-transparent; a fixed light chip keeps
 *  them visible in dark mode too. */
const SILHOUETTE_BG = 'oklch(96% 0.004 250)'

const KIND_LABELS: Record<EvolutionEvent['kind'], string> = {
  event: 'Event',
  organism: 'Organism',
  extinction: 'Mass extinction',
}

function eventDateLabel(event: EvolutionEvent): string {
  if (event.endMa === null) return `~${formatMa(event.startMa)}`
  if (event.endMa === 0) return `${formatMa(event.startMa)} → present`
  return `${formatMa(event.startMa)} → ${formatMa(event.endMa)}`
}

export function EvolutionPage() {
  const chartState = useEvolutionChart()
  const eventsState = useEvolutionEvents()
  const [granularity, setGranularity] = useState<Granularity>('Era')

  const chart = chartState.status === 'ready' ? chartState.data : null
  const eventsFile = eventsState.status === 'ready' ? eventsState.data : null

  /**
   * Bands: chart intervals at the chosen rank, oldest first. The chart has
   * no interval covering the pre-Hadean accretion window, and the Hadean
   * itself has no subdivisions, so ranks finer than Eon fall back to the
   * eon where no finer interval exists (the Precambrian at 'Period' rank).
   */
  const bands = useMemo(() => {
    if (!chart) return []
    const wanted = chart.intervals.filter((i) => i.rank === granularity)
    const eons = chart.intervals.filter((i) => i.rank === 'Eon')
    const covered = (ma: number) =>
      wanted.some((i) => ma <= i.startMa && ma > i.endMa)
    const fallback = eons.filter((eon) => !covered(eon.startMa - 1e-9))
    return [...wanted, ...fallback].sort((a, b) => b.startMa - a.startMa)
  }, [chart, granularity])

  const eventsByBand = useMemo(() => {
    const map = new Map<string, EvolutionEvent[]>()
    if (!eventsFile) return map
    const list = [...eventsFile.events].sort((a, b) => b.startMa - a.startMa)
    for (const event of list) {
      const band = bands.find(
        (i) => event.startMa <= i.startMa && event.startMa > i.endMa,
      )
      const key = band ? band.id : 'pre-chart'
      const bucket = map.get(key)
      if (bucket) bucket.push(event)
      else map.set(key, [event])
    }
    return map
  }, [eventsFile, bands])

  const loading =
    chartState.status === 'loading' || eventsState.status === 'loading'
  const error = chartState.status === 'error' || eventsState.status === 'error'

  function renderBand(interval: IcsInterval | null, events: EvolutionEvent[]) {
    const key = interval?.id ?? 'pre-chart'
    const name = interval?.name ?? 'Before the geologic record'
    const span = interval
      ? `${formatMa(interval.startMa, interval.startError)} → ${formatMa(interval.endMa, interval.endError)}`
      : 'accretion of the Earth'
    return (
      <section key={key} className="grid gap-x-6 sm:grid-cols-[13rem_1fr]">
        <div className="py-3">
          <div
            className="rounded-lg border px-3 py-2 sm:sticky sm:top-4"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface-raised)',
              borderLeft: interval?.color
                ? `6px solid ${interval.color}`
                : undefined,
            }}
          >
            <h2 className="text-base leading-tight">{name}</h2>
            <p className="mt-0.5 text-xs" style={{ color: 'var(--text-muted)' }}>
              {interval ? `${interval.rank} · ` : ''}
              {span}
            </p>
          </div>
        </div>
        <div
          className="border-l py-3 pl-5"
          style={{ borderColor: 'var(--border)' }}
        >
          {events.length === 0 && (
            <p className="py-1 text-xs" style={{ color: 'var(--text-muted)' }}>
              No entries in this {interval?.rank.toLowerCase() ?? 'span'}.
            </p>
          )}
          {events.map((event) => (
            <details key={event.id} className="section-disclosure group mb-2">
              <summary className="flex cursor-pointer list-none flex-wrap items-baseline gap-x-2 rounded px-1.5 py-1">
                <span
                  aria-hidden="true"
                  className="inline-block h-2 w-2 shrink-0 self-center rounded-full"
                  style={{
                    background:
                      event.kind === 'extinction'
                        ? 'var(--history-bg)'
                        : 'var(--biology-bg)',
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
                  style={{
                    borderColor: 'var(--border)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {KIND_LABELS[event.kind]}
                </span>
              </summary>
              <div className="mt-2 flex flex-wrap gap-4 pb-2 pl-4">
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
                      {event.image.type === 'phylopic'
                        ? 'Silhouette: '
                        : 'Image: '}
                      {event.image.attribution ?? 'unknown author'} ·{' '}
                      <a
                        className="underline underline-offset-2"
                        href={event.image.page}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {event.image.type === 'phylopic'
                          ? 'PhyloPic'
                          : 'Commons'}
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
          ))}
        </div>
      </section>
    )
  }

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <p
          className="font-sans text-xs font-medium uppercase tracking-widest"
          style={{ color: 'var(--text-muted)' }}
        >
          Biology
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">
          Evolution
        </h1>
        <p
          className="mt-2 max-w-3xl text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          The history of life on Earth, banded by the{' '}
          <a
            className="underline underline-offset-2"
            href={chart?.url ?? 'https://stratigraphy.org/chart'}
            target="_blank"
            rel="noreferrer"
          >
            ICS International Chronostratigraphic Chart
          </a>{' '}
          (band colours are the chart's own). The axis is deliberately not
          linear — each band holds its entries, and every date is printed
          with the uncertainty the evidence supports. Open an entry for its
          story, illustration and sources.
        </p>
      </header>

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
          <fieldset className="mt-6 flex items-center gap-2 text-sm">
            <legend className="sr-only">Band granularity</legend>
            <span style={{ color: 'var(--text-muted)' }}>Bands</span>
            {GRANULARITIES.map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={granularity === value}
                onClick={() => setGranularity(value)}
                className="rounded border px-2.5 py-1"
                style={{
                  borderColor: 'var(--border)',
                  background:
                    granularity === value
                      ? 'var(--control-selected-bg)'
                      : 'transparent',
                  color:
                    granularity === value
                      ? 'var(--control-selected-text)'
                      : 'inherit',
                }}
              >
                {value}s
              </button>
            ))}
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              The Precambrian falls back to eons where the chart has no finer
              interval.
            </span>
          </fieldset>

          <div className="mt-4">
            {eventsByBand.has('pre-chart') &&
              renderBand(null, eventsByBand.get('pre-chart') ?? [])}
            {bands.map((interval) =>
              renderBand(interval, eventsByBand.get(interval.id) ?? []),
            )}
          </div>

          <p className="mt-8 text-xs" style={{ color: 'var(--text-muted)' }}>
            {eventsFile.imageNote} Chart: International Commission on
            Stratigraphy, CC BY 4.0.
          </p>
        </>
      )}
    </div>
  )
}
