import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'

import { historyCategoryIcon } from '../../lib/icons'
import { Icon } from '../Icon'
import type { HistoryEvent, HistoryFile } from '../../types'

/**
 * Vertical human-history timeline, oldest at the top (Phase 3; layout
 * reworked 2026-08-30 at the maintainer's request).
 *
 * DEEP TIME NEEDS A NON-LINEAR SCALE. Seven million years of hominin
 * evolution beside the seventy years since 1950 cannot share one linear
 * axis: everything after 1500 would be a sliver. The axis is therefore
 * PIECEWISE: a fixed list of eras, each given its own vertical length,
 * with years linear INSIDE an era. The change of scale is made visible
 * rather than hidden -- every era box states "1 px ≈ N years" and the
 * bands are tinted alternately.
 *
 * TWO COLUMNS. Era name, span and scale sit in a boxed label in the LEFT
 * column (sticky within its own band, so the reader always knows where
 * they are); events sit in the RIGHT column. Nothing in one column can
 * ever be covered by the other.
 *
 * NO OVERLAPS. Event labels wrap on narrow screens, so their heights are
 * MEASURED after render (ResizeObserver) and the layout pushes each row
 * below the previous one's real bottom edge; the pixel scale is honoured
 * wherever the events are sparse enough to allow it.
 *
 * Interaction: hovering an event label reveals its summary card on
 * pointer devices; on touch (and for keyboard users) the label is a real
 * <button aria-expanded> that toggles the card, and Escape closes it.
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
  { key: 'deep', label: 'Deep Past', from: -7_000_000, to: -300_000, height: 260 },
  { key: 'prehistory', label: 'Prehistory', from: -300_000, to: -10_000, height: 360 },
  { key: 'neolithic', label: 'Neolithic', from: -10_000, to: -3_000, height: 360 },
  { key: 'ancient', label: 'Ancient World', from: -3_000, to: 500, height: 900 },
  { key: 'medieval', label: 'Post-Classical', from: 500, to: 1500, height: 700 },
  { key: 'early-modern', label: 'Early Modern', from: 1500, to: 1800, height: 600 },
  { key: 'industrial', label: 'Industrial Age', from: 1800, to: 1914, height: 600 },
  { key: 'contemporary', label: 'Contemporary', from: 1914, to: 2030, height: 900 },
]

export const CATEGORY_LABELS: Record<string, string> = {
  'evolution-prehistory': 'Evolution & Prehistory',
  'invention-technology': 'Invention & Technology',
  'scientific-discovery': 'Scientific Discovery',
  'other-discovery': 'Other Major Discoveries',
  'war-conflict': 'Wars & Major Conflicts',
  religion: 'Advent of Major Religions',
  'rights-document': 'Political Documents & Rights',
}

/** Left column (era boxes) width, px. */
const LEFT_COL = 128
const LEFT_COL_SM = 176
/** Axis line offset inside the right column, px. */
const GUTTER = 14
/** Space between the bottom of one event row and the top of the next, px. */
const ROW_GAP = 6
/** Fallback row height until the browser has measured the real one, px. */
const ROW_ESTIMATE = 28

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
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [wide, setWide] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const baseId = useId()

  useEffect(() => {
    const query = window.matchMedia('(min-width: 640px)')
    const apply = () => setWide(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])
  const leftCol = wide ? LEFT_COL_SM : LEFT_COL

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

  // Measure every row's rendered label height (they wrap on phones) so the
  // placement below can guarantee no two rows overlap.
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      const next: Record<string, number> = {}
      for (const [id, node] of rowRefs.current) next[id] = node.offsetHeight
      setHeights((prev) => {
        const keys = Object.keys(next)
        if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k])) {
          return prev
        }
        return next
      })
    })
    for (const node of rowRefs.current.values()) observer.observe(node)
    return () => observer.disconnect()
  }, [events])

  // Lay events out top-to-bottom: each row sits at its scale position unless
  // the previous row's measured bottom edge is lower, in which case it is
  // pushed down. Rows never overlap; the scale bends only where it must.
  const placed = useMemo(() => {
    let bottom = -Infinity
    return events.map((e) => {
      let y = yFor(e.startYear) + 8
      if (y < bottom + ROW_GAP) y = bottom + ROW_GAP
      const h = heights[e.id] ?? ROW_ESTIMATE
      bottom = y + h
      return { event: e, y }
    })
  }, [events, heights])

  const lastRow = placed[placed.length - 1]
  const totalHeight = Math.max(
    ERAS.reduce((s, e) => s + e.height, 0),
    lastRow ? lastRow.y + (heights[lastRow.event.id] ?? ROW_ESTIMATE) + 24 : 0,
  )

  useEffect(() => {
    if (!openId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId])

  // Era bands: when events overflow an era's allotted height the band
  // stretches to the last event inside it, so the label box stays beside
  // its own events. The final band absorbs any remaining height.
  const bands = useMemo(() => {
    let offset = 0
    const out = ERAS.map((era, index) => {
      const top = offset
      offset += era.height
      const yearsPerPx = Math.round((era.to - era.from) / era.height)
      return { era, top, index, yearsPerPx, height: era.height }
    })
    for (let i = 0; i < out.length; i += 1) {
      const band = out[i]!
      const inBand = placed.filter(
        (p) => p.event.startYear >= band.era.from && (i === out.length - 1 || p.event.startYear < band.era.to),
      )
      const last = inBand[inBand.length - 1]
      const needed = last ? last.y + (heights[last.event.id] ?? ROW_ESTIMATE) + 12 - band.top : 0
      if (needed > band.height) {
        const grow = needed - band.height
        band.height = needed
        for (let j = i + 1; j < out.length; j += 1) out[j]!.top += grow
      }
    }
    const lastBand = out[out.length - 1]!
    lastBand.height = Math.max(lastBand.height, totalHeight - lastBand.top)
    return out
  }, [placed, heights, totalHeight])

  const registerRow = (id: string) => (node: HTMLElement | null) => {
    if (node) rowRefs.current.set(id, node)
    else rowRefs.current.delete(id)
  }

  return (
    <div ref={containerRef} className="relative" style={{ height: totalHeight }}>
      {/* Era bands, full width, with the boxed label in the left column. */}
      {bands.map(({ era, top, index, yearsPerPx, height }) => (
        <div
          key={era.key}
          data-era={era.key}
          className="absolute left-0 right-0 border-t"
          style={{
            top,
            height,
            borderColor: 'var(--border)',
            background: index % 2 === 0 ? 'transparent' : 'var(--page-tint)',
          }}
        >
          <div
            className="sticky top-2 mt-2 rounded-md px-2.5 py-2 text-xs shadow-sm"
            style={{
              width: leftCol - 12,
              background: 'var(--control-selected-bg)',
              color: 'var(--control-selected-text)',
            }}
          >
            <div className="font-sans text-sm font-semibold leading-tight">{era.label}</div>
            <div className="mt-1 leading-snug">
              {formatYear(era.from, 'exact')}
              <span aria-hidden="true"> → </span>
              <span className="sr-only"> to </span>
              {formatYear(era.to, 'exact')}
            </div>
            <div className="mt-1 opacity-80" style={{ fontVariantNumeric: 'tabular-nums' }}>
              1 px ≈ {yearsPerPx.toLocaleString()} {yearsPerPx === 1 ? 'year' : 'years'}
            </div>
          </div>
        </div>
      ))}

      {/* Axis line, right column. */}
      <div
        aria-hidden="true"
        className="absolute top-0 bottom-0 w-px"
        style={{ left: leftCol + GUTTER, background: 'var(--border)' }}
      />

      {placed.length === 0 && (
        <p
          className="absolute top-8 text-sm"
          style={{ left: leftCol + GUTTER + 16, color: 'var(--text-muted)' }}
        >
          No events match the current filters.
        </p>
      )}

      <ol className="m-0 list-none p-0">
        {placed.map(({ event, y }) => {
          const open = openId === event.id
          const cardId = `${baseId}-${event.id}`
          const icon = historyCategoryIcon(event.category)
          return (
            <li
              key={event.id}
              className="absolute right-0"
              style={{ top: y, left: leftCol, zIndex: open ? 20 : 1 }}
              onPointerEnter={(e) => {
                if (e.pointerType === 'mouse') setOpenId(event.id)
              }}
              onPointerLeave={(e) => {
                if (e.pointerType === 'mouse' && openId === event.id) setOpenId(null)
              }}
            >
              <span
                aria-hidden="true"
                className="absolute top-2 h-2.5 w-2.5 rounded-full"
                style={{ left: GUTTER - 5, background: 'var(--accent)' }}
              />
              <button
                ref={registerRow(event.id)}
                type="button"
                aria-expanded={open}
                aria-controls={cardId}
                onClick={() => setOpenId(open ? null : event.id)}
                className="flex w-full flex-wrap items-baseline gap-x-2 gap-y-0.5 rounded px-2 py-0.5 text-left text-sm"
                style={{ marginLeft: GUTTER + 12, width: `calc(100% - ${GUTTER + 12}px)` }}
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
                  {icon && (
                    <>
                      {' '}
                      <Icon code={icon} className="ml-0.5" size="1.1em" />
                    </>
                  )}
                </span>
              </button>
              <div
                id={cardId}
                role="region"
                aria-label={`${event.title}: summary`}
                hidden={!open}
                className="mt-1 max-w-xl rounded-lg border p-3 text-sm shadow-lg"
                style={
                  {
                    marginLeft: GUTTER + 12,
                    borderColor: 'var(--border)',
                    background: 'var(--surface-raised)',
                    color: 'var(--text)',
                  } as CSSProperties
                }
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
  )
}
