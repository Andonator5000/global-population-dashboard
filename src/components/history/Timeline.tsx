import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { HistoryEvent, HistoryFile } from '../../types'

/**
 * Vertical human-history timeline, oldest at the top (Phase 3).
 *
 * DEEP TIME NEEDS A NON-LINEAR SCALE. Seven million years of hominin
 * evolution beside the seventy years since 1950 cannot share one linear
 * axis: everything after 1500 would be a sliver. The axis is therefore
 * PIECEWISE: a fixed list of eras, each given its own vertical length
 * roughly proportional to how many events history books devote to it,
 * with years linear INSIDE an era. The change of scale is made visible
 * rather than hidden -- every era band states "1 px ≈ N years" and the
 * bands are tinted alternately, so a reader cannot mistake the axis for a
 * uniform one.
 *
 * Interaction: hovering an event label reveals its summary card on
 * pointer devices; on touch (and for keyboard users) the label is a
 * real <button aria-expanded> that toggles the card, and Escape closes it.
 * Category filters and a search box narrow the list; a sticky era rail
 * on the left shows where the reader is and jumps on click.
 */

export interface Era {
  key: string
  label: string
  /** Inclusive start year (astronomical; negative = BCE). */
  from: number
  /** Exclusive end year. */
  to: number
  /** Vertical length in px allotted to this era. */
  height: number
}

export const ERAS: Era[] = [
  { key: 'deep', label: 'Deep past', from: -7_000_000, to: -300_000, height: 260 },
  { key: 'prehistory', label: 'Prehistory', from: -300_000, to: -10_000, height: 360 },
  { key: 'neolithic', label: 'Neolithic', from: -10_000, to: -3_000, height: 360 },
  { key: 'ancient', label: 'Ancient world', from: -3_000, to: 500, height: 900 },
  { key: 'medieval', label: 'Post-classical', from: 500, to: 1500, height: 700 },
  { key: 'early-modern', label: 'Early modern', from: 1500, to: 1800, height: 600 },
  { key: 'industrial', label: 'Industrial age', from: 1800, to: 1914, height: 600 },
  { key: 'contemporary', label: 'Contemporary', from: 1914, to: 2030, height: 900 },
]

export const CATEGORY_LABELS: Record<string, string> = {
  'evolution-prehistory': 'Evolution & prehistory',
  'invention-technology': 'Invention & technology',
  'scientific-discovery': 'Scientific discovery',
  'other-discovery': 'Other major discoveries',
  'war-conflict': 'Wars & major conflicts',
  religion: 'Advent of major religions',
  'rights-document': 'Political documents & rights',
}

const CATEGORY_ICON: Record<string, string> = {
  'evolution-prehistory': '1F9EC',
  'invention-technology': '1F6E0',
  'scientific-discovery': '1F52C',
  'other-discovery': '1F9ED',
  'war-conflict': '2694',
  religion: '1F54A',
  'rights-document': '1F4DC',
}

const RAIL = 84 // px, the sticky era rail width
const GUTTER = 28 // px, axis line offset inside the plot

function yFor(year: number): number {
  let offset = 0
  for (const era of ERAS) {
    if (year < era.to || era === ERAS[ERAS.length - 1]) {
      const clamped = Math.min(Math.max(year, era.from), era.to)
      return offset + ((clamped - era.from) / (era.to - era.from)) * era.height
    }
    offset += era.height
  }
  return offset
}

export function formatYear(year: number, precision: HistoryEvent['datePrecision']): string {
  const abs = Math.abs(year)
  if (abs >= 1_000_000) return `${(abs / 1_000_000).toFixed(1).replace(/\.0$/, '')} million years ago`
  if (year <= -10_000) return `${Math.round(abs / 1000).toLocaleString()},000 years ago`
  const era = year < 0 ? ' BCE' : year < 1000 ? ' CE' : ''
  const prefix = precision === 'approximate' ? 'c. ' : ''
  if (precision === 'millennium') return `${prefix}${abs.toLocaleString()}${era}`
  if (precision === 'century') return `${prefix}${abs}${era}`
  if (precision === 'decade') return `${prefix}${abs}${era}`
  return `${abs}${era}`
}

function precisionNote(precision: HistoryEvent['datePrecision']): string | null {
  switch (precision) {
    case 'exact':
      return null
    case 'decade':
      return 'to within a decade'
    case 'century':
      return 'to within a century'
    case 'millennium':
      return 'to within a millennium'
    default:
      return 'approximate'
  }
}

export function Timeline({
  data,
  categories,
  query,
}: {
  data: HistoryFile
  categories: Set<string>
  query: string
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [activeEra, setActiveEra] = useState<string>(ERAS[0]!.key)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const baseId = useId()

  const needle = query.trim().toLowerCase()
  const events = useMemo(
    () =>
      data.events.filter(
        (e) =>
          categories.has(e.category) &&
          (!needle ||
            e.title.toLowerCase().includes(needle) ||
            e.summary.toLowerCase().includes(needle) ||
            e.regions.some((r) => r.toLowerCase().includes(needle))),
      ),
    [data.events, categories, needle],
  )

  // Lay events out top-to-bottom, pushing any that would overlap the one
  // above down by a minimum row height so labels never collide.
  const placed = useMemo(() => {
    const MIN_GAP = 30
    let last = -Infinity
    return events.map((e) => {
      let y = yFor(e.startYear)
      if (y < last + MIN_GAP) y = last + MIN_GAP
      last = y
      return { event: e, y }
    })
  }, [events])

  const totalHeight = Math.max(
    ERAS.reduce((s, e) => s + e.height, 0),
    (placed[placed.length - 1]?.y ?? 0) + 120,
  )

  // Track which era band is in view for the rail.
  useEffect(() => {
    const root = containerRef.current
    if (!root) return
    const bands = Array.from(root.querySelectorAll<HTMLElement>('[data-era]'))
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((en) => en.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        const first = visible[0]?.target as HTMLElement | undefined
        if (first?.dataset.era) setActiveEra(first.dataset.era)
      },
      { rootMargin: '-40% 0px -55% 0px', threshold: 0 },
    )
    bands.forEach((b) => observer.observe(b))
    return () => observer.disconnect()
  }, [totalHeight])

  useEffect(() => {
    if (!openId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId])

  const jumpTo = (era: Era) => {
    const target = containerRef.current?.querySelector<HTMLElement>(`[data-era="${era.key}"]`)
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  let offset = 0
  const bands = ERAS.map((era, index) => {
    const top = offset
    offset += era.height
    const pxPerYear = era.height / (era.to - era.from)
    const yearsPerPx = Math.round(1 / pxPerYear)
    return { era, top, index, yearsPerPx }
  })

  return (
    <div className="relative flex gap-4">
      {/* Era rail: sticky, always visible, keyboard-reachable. */}
      <nav
        aria-label="Eras"
        className="sticky top-4 hidden self-start sm:block"
        style={{ width: RAIL }}
      >
        <ol className="space-y-1 text-xs">
          {ERAS.map((era) => (
            <li key={era.key}>
              <button
                type="button"
                onClick={() => jumpTo(era)}
                aria-current={activeEra === era.key ? 'location' : undefined}
                className="w-full rounded px-2 py-1 text-left"
                style={{
                  background: activeEra === era.key ? 'var(--control-selected-bg)' : 'transparent',
                  color: activeEra === era.key ? 'var(--control-selected-text)' : 'var(--text-muted)',
                  fontWeight: activeEra === era.key ? 600 : 400,
                }}
              >
                {era.label}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      <div ref={containerRef} className="relative min-w-0 flex-1" style={{ height: totalHeight }}>
        {/* Era bands: alternate tint + a scale note, so the change of scale
            is visible rather than implied. */}
        {bands.map(({ era, top, index, yearsPerPx }) => (
          <div
            key={era.key}
            data-era={era.key}
            className="absolute left-0 right-0 border-t"
            style={{
              top,
              height: era.height,
              borderColor: 'var(--border)',
              background: index % 2 === 0 ? 'transparent' : 'var(--page-tint)',
            }}
          >
            <div
              className="sticky top-0 flex flex-wrap items-baseline gap-x-3 px-2 pt-1 text-xs"
              style={{ color: 'var(--text-muted)' }}
            >
              <span className="font-medium" style={{ color: 'var(--text)' }}>
                {era.label}
              </span>
              <span>
                {formatYear(era.from, 'exact')} → {formatYear(era.to, 'exact')}
              </span>
              <span style={{ fontVariantNumeric: 'tabular-nums' }}>
                scale: 1 px ≈ {yearsPerPx.toLocaleString()} {yearsPerPx === 1 ? 'year' : 'years'}
              </span>
            </div>
          </div>
        ))}

        {/* Axis line */}
        <div
          aria-hidden="true"
          className="absolute top-0 bottom-0 w-px"
          style={{ left: GUTTER, background: 'var(--border)' }}
        />

        {placed.length === 0 && (
          <p className="absolute left-10 top-8 text-sm" style={{ color: 'var(--text-muted)' }}>
            No events match the current filters.
          </p>
        )}

        <ol className="m-0 list-none p-0">
          {placed.map(({ event, y }) => {
            const open = openId === event.id
            const cardId = `${baseId}-${event.id}`
            return (
              <li
                key={event.id}
                className="absolute left-0 right-0"
                style={{ top: y, zIndex: open ? 20 : 1 }}
                onPointerEnter={(e) => {
                  if (e.pointerType === 'mouse') setOpenId(event.id)
                }}
                onPointerLeave={(e) => {
                  if (e.pointerType === 'mouse' && openId === event.id) setOpenId(null)
                }}
              >
                <span
                  aria-hidden="true"
                  className="absolute top-1.5 h-2.5 w-2.5 rounded-full"
                  style={{ left: GUTTER - 5, background: 'var(--accent)' }}
                />
                <button
                  type="button"
                  aria-expanded={open}
                  aria-controls={cardId}
                  onClick={() => setOpenId(open ? null : event.id)}
                  className="flex items-baseline gap-2 rounded px-2 py-0.5 text-left text-sm"
                  style={{ marginLeft: GUTTER + 12 }}
                >
                  <span
                    className="shrink-0 text-xs"
                    style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}
                  >
                    {formatYear(event.startYear, event.datePrecision)}
                    {event.endYear !== null && event.endYear !== event.startYear
                      ? `–${formatYear(event.endYear, event.datePrecision)}`
                      : ''}
                  </span>
                  <span className="font-medium underline-offset-2 hover:underline">
                    {event.title}
                  </span>
                  <span
                    className="om-icon shrink-0"
                    aria-hidden="true"
                    style={{
                      '--icon': `url("${import.meta.env.BASE_URL}icons/openmoji/${CATEGORY_ICON[event.category] ?? '1F4DC'}.svg")`,
                      color: 'var(--text-muted)',
                    } as React.CSSProperties}
                  />
                </button>
                <div
                  id={cardId}
                  role="region"
                  aria-label={`${event.title}: summary`}
                  hidden={!open}
                  className="mt-1 max-w-xl rounded-lg border p-3 text-sm shadow-lg"
                  style={{
                    marginLeft: GUTTER + 12,
                    borderColor: 'var(--border)',
                    background: 'var(--surface-raised)',
                    color: 'var(--text)',
                  }}
                >
                  <div className="flex gap-3">
                    {event.image && (
                      <img
                        src={event.image.url}
                        alt=""
                        loading="lazy"
                        className="h-24 w-24 shrink-0 rounded object-cover"
                      />
                    )}
                    <div className="min-w-0">
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                        {CATEGORY_LABELS[event.category] ?? event.category}
                        {' · '}
                        {event.regions.join(', ')}
                        {precisionNote(event.datePrecision)
                          ? ` · date ${precisionNote(event.datePrecision)}`
                          : ''}
                      </p>
                      <p className="mt-1">{event.summary}</p>
                    </div>
                  </div>
                  <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
                    {event.image && (
                      <>
                        Image:{' '}
                        <a
                          href={event.image.commonsPage}
                          target="_blank"
                          rel="noreferrer"
                          className="underline underline-offset-2"
                        >
                          Wikimedia Commons
                        </a>
                        {event.image.license ? ` · ${event.image.license}` : ''}
                        {event.image.attribution ? ` · ${event.image.attribution}` : ''}
                        {' · '}
                      </>
                    )}
                    Sources:{' '}
                    {event.sources.map((s, i) => (
                      <span key={s}>
                        {i > 0 && ', '}
                        <a href={s} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                          {new URL(s).hostname.replace(/^www\./, '')}
                        </a>
                      </span>
                    ))}
                  </p>
                  <button
                    type="button"
                    className="mt-2 rounded border px-2 py-0.5 text-xs"
                    style={{ borderColor: 'var(--border)' }}
                    onClick={() => setOpenId(null)}
                  >
                    Close (Esc)
                  </button>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
