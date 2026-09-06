import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'

import { historyCategoryIcon } from '../../lib/icons'
import { Icon } from '../Icon'
import type { HistoryEvent, HistoryFile } from '../../types'

/**
 * Vertical human-history timeline, oldest at the top (Phase 3; two-column
 * layout 2026-08-30; full-width era banners round-2 §38).
 *
 * DEEP TIME NEEDS A NON-LINEAR SCALE. Seven million years of hominin
 * evolution beside the seventy years since 1950 cannot share one linear
 * axis: everything after 1500 would be a sliver. The axis is therefore
 * PIECEWISE: a fixed list of eras, each given its own vertical length,
 * with years linear INSIDE an era. The change of scale is made visible
 * rather than hidden -- every era banner states "1 px ≈ N years".
 *
 * FULL-WIDTH BANNERS (round-2 §38, replacing the left-column era boxes):
 * each era opens with a banner spanning the timeline -- name, dates, a
 * sentence on what defined the era, and the scale note. Banner heights
 * are MEASURED (they wrap on phones) and the year scale starts below
 * each banner, so nothing can overlap at any viewport width: the banner
 * itself is normal flow layout, and event rows are pushed below both the
 * banner and each other's measured bottom edges.
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
  /** Vertical length in px allotted to this era's events. */
  height: number
  /** One or two sentences on what defined the era (round-2 §38). */
  description: string
  /** oklch hue angle for the banner tint (round-2 feedback: every banner
      was the same grey; each era now has its own colour identity, applied
      as a light-dark() tint pair so both themes stay contrast-safe). */
  hue: number
}

export const ERAS: Era[] = [
  {
    key: 'deep', hue: 30, label: 'Deep Past', from: -7_000_000, to: -300_000, height: 260,
    description:
      'From the split with the chimpanzee lineage to the archaic humans: ' +
      'walking upright, the first stone tools, fire, and the long expansion ' +
      'of hominins out of Africa.',
  },
  {
    key: 'prehistory', hue: 55, label: 'Prehistory', from: -300_000, to: -10_000, height: 360,
    description:
      'Homo sapiens appears, thinks symbolically, and spreads across every ' +
      'continent -- art, burial, language and the last ice age, all before ' +
      'anyone farmed or wrote.',
  },
  {
    key: 'neolithic', hue: 130, label: 'Neolithic', from: -10_000, to: -3_000, height: 360,
    description:
      'The farming revolution: crops and herds replace foraging, villages ' +
      'become towns, and settled life invents pottery, weaving, the wheel ' +
      'and, at its very end, writing.',
  },
  {
    key: 'ancient', hue: 85, label: 'Ancient World', from: -3_000, to: 500, height: 900,
    description:
      'Writing begins recorded history. Egypt, Mesopotamia, Persia, Greece, ' +
      'Rome, Han China and Maurya India build the first states, codes of ' +
      'law, alphabets and world religions.',
  },
  {
    key: 'medieval', hue: 280, label: 'Post-Classical', from: 500, to: 1500, height: 700,
    description:
      'Between Rome’s fall and Columbus: the rise of Islam, Byzantium, ' +
      'Tang and Song China, the Mongol exchange, medieval Europe, and the ' +
      'great states of Africa and the Americas.',
  },
  {
    key: 'early-modern', hue: 200, label: 'Early Modern', from: 1500, to: 1800, height: 600,
    description:
      'Oceans connect the world -- colonisation, the printing press’s ' +
      'aftershocks, the Scientific Revolution and Enlightenment, gunpowder ' +
      'empires, and the first modern revolutions.',
  },
  {
    key: 'industrial', hue: 25, label: 'Industrial Age', from: 1800, to: 1914, height: 600,
    description:
      'Steam, steel, railways and telegraphs remake work and cities; ' +
      'nation-states and empires span the globe; science professionalises ' +
      'and medicine finally starts saving lives.',
  },
  {
    key: 'contemporary', hue: 250, label: 'Contemporary', from: 1914, to: 2030, height: 900,
    description:
      'The world wars and decolonisation, flight, antibiotics, computing ' +
      'and the internet: a century in which change itself accelerated.',
  },
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

/** Axis line offset, px. */
const GUTTER = 14
/** Space between the bottom of one event row and the top of the next, px. */
const ROW_GAP = 6
/** Fallback heights until the browser has measured the real ones, px. */
const ROW_ESTIMATE = 28
const BANNER_ESTIMATE = 84

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
  civilization,
  query,
}: {
  data: HistoryFile
  categories: Set<string>
  /** Civilization/region tag filter (round-2 §38); null = all. */
  civilization: string | null
  query: string
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const containerRef = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLElement>())
  const bannerRefs = useRef(new Map<string, HTMLElement>())
  const baseId = useId()

  const needle = query.trim().toLowerCase()
  const events = useMemo(
    () =>
      data.events.filter(
        (e) =>
          categories.has(e.category) &&
          (civilization === null || e.civilization === civilization) &&
          (!needle ||
            e.title.toLowerCase().includes(needle) ||
            e.summary.toLowerCase().includes(needle) ||
            (e.civilization ?? '').toLowerCase().includes(needle) ||
            e.regions.some((r) => r.toLowerCase().includes(needle))),
      ),
    [data.events, categories, civilization, needle],
  )

  // Measure every rendered row AND banner (both wrap on phones) so the
  // placement below can guarantee nothing overlaps at any width.
  useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      const next: Record<string, number> = {}
      for (const [id, node] of rowRefs.current) next[id] = node.offsetHeight
      for (const [key, node] of bannerRefs.current) {
        next[`banner:${key}`] = node.offsetHeight
      }
      setHeights((prev) => {
        const keys = Object.keys(next)
        if (keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k])) {
          return prev
        }
        return next
      })
    })
    for (const node of rowRefs.current.values()) observer.observe(node)
    for (const node of bannerRefs.current.values()) observer.observe(node)
    return () => observer.disconnect()
  }, [events])

  /**
   * Single top-to-bottom pass (round-2 §38): each era's banner occupies its
   * measured height, the era's year-scale starts below it, and every event
   * row sits at its scale position unless the previous row's measured
   * bottom would collide, in which case it is pushed down (stretching the
   * band). Bands are packed sequentially, so no coordinate is ever shared
   * between two elements.
   */
  const { bands, placed, totalHeight } = useMemo(() => {
    const bannerH = (key: string) => heights[`banner:${key}`] ?? BANNER_ESTIMATE
    const sorted = [...events].sort((a, b) => a.startYear - b.startYear)
    const bandsOut: {
      era: Era
      top: number
      height: number
      yearsPerPx: number
      index: number
    }[] = []
    const placedOut: { event: HistoryEvent; y: number }[] = []
    let cursor = 0
    let eventIndex = 0
    for (let i = 0; i < ERAS.length; i += 1) {
      const era = ERAS[i]!
      const isLast = i === ERAS.length - 1
      const top = cursor
      const contentTop = top + bannerH(era.key)
      let bottom = contentTop
      while (
        eventIndex < sorted.length &&
        (isLast || sorted[eventIndex]!.startYear < era.to)
      ) {
        const event = sorted[eventIndex]!
        const fraction =
          (Math.min(Math.max(event.startYear, era.from), era.to) - era.from) /
          (era.to - era.from)
        let y = contentTop + fraction * era.height + 4
        if (y < bottom + ROW_GAP) y = bottom + ROW_GAP
        placedOut.push({ event, y })
        bottom = y + (heights[event.id] ?? ROW_ESTIMATE)
        eventIndex += 1
      }
      const height = Math.max(
        bannerH(era.key) + era.height,
        bottom + 12 - top,
      )
      bandsOut.push({
        era,
        top,
        height,
        yearsPerPx: Math.round((era.to - era.from) / era.height),
        index: i,
      })
      cursor = top + height
    }
    return { bands: bandsOut, placed: placedOut, totalHeight: cursor }
  }, [events, heights])

  useEffect(() => {
    if (!openId) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenId(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openId])

  const registerRow = (id: string) => (node: HTMLElement | null) => {
    if (node) rowRefs.current.set(id, node)
    else rowRefs.current.delete(id)
  }
  const registerBanner = (key: string) => (node: HTMLElement | null) => {
    if (node) bannerRefs.current.set(key, node)
    else bannerRefs.current.delete(key)
  }

  return (
    <div ref={containerRef} className="relative" style={{ height: totalHeight }}>
      {/* Era bands with their full-width banners (round-2 §38). The banner
          content is ordinary flow layout inside a measured box, so text can
          wrap forever without overlapping anything. */}
      {bands.map(({ era, top, index, yearsPerPx, height }) => (
        <div
          key={era.key}
          data-era={era.key}
          className="absolute left-0 right-0"
          style={{
            top,
            height,
            background: index % 2 === 0 ? 'transparent' : 'var(--page-tint)',
          }}
        >
          <div
            ref={registerBanner(era.key)}
            className="border-t-2 px-3 py-2.5 sm:px-4"
            style={{
              borderColor: `light-dark(oklch(58% 0.085 ${era.hue}), oklch(60% 0.08 ${era.hue}))`,
              background: `light-dark(oklch(94.5% 0.032 ${era.hue}), oklch(25% 0.028 ${era.hue}))`,
            }}
          >
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5">
              <h3 className="font-display m-0 text-lg leading-tight">
                {era.label}
              </h3>
              <span
                className="text-xs"
                style={{
                  color: 'var(--text-muted)',
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatYear(era.from, 'exact')}
                <span aria-hidden="true"> → </span>
                <span className="sr-only"> to </span>
                {formatYear(era.to, 'exact')}
                {' · 1 px ≈ '}
                {yearsPerPx.toLocaleString()}{' '}
                {yearsPerPx === 1 ? 'year' : 'years'}
              </span>
            </div>
            <p
              className="mb-0 mt-1 max-w-4xl text-xs leading-snug"
              style={{ color: 'var(--text-muted)' }}
            >
              {era.description}
            </p>
          </div>
        </div>
      ))}

      {/* Axis line. */}
      <div
        aria-hidden="true"
        className="absolute top-0 bottom-0 w-px"
        style={{ left: GUTTER, background: 'var(--border)' }}
      />

      {placed.length === 0 && (
        <p
          className="absolute top-24 text-sm"
          style={{ left: GUTTER + 16, color: 'var(--text-muted)' }}
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
                  className="text-xs"
                  style={{ color: 'var(--text-muted)', fontVariantNumeric: 'tabular-nums' }}
                >
                  {/* A range like "400,000 years ago–40,000 years ago" is wider
                      than a phone's event column; it may break after the dash
                      (each side stays whole), which is why it is not shrink-0. */}
                  <span className="whitespace-nowrap">
                    {formatYear(event.startYear, event.datePrecision)}
                    {event.endYear !== null && event.endYear !== event.startYear ? '–' : ''}
                  </span>
                  {event.endYear !== null && event.endYear !== event.startYear && (
                    <>
                      <wbr />
                      <span className="whitespace-nowrap">
                        {formatYear(event.endYear, event.datePrecision)}
                      </span>
                    </>
                  )}
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
                className="ml-2 mt-1 max-w-xl rounded-lg border p-3 text-sm shadow-lg sm:ml-6"
                style={{
                  borderColor: 'var(--border)',
                  background: 'var(--surface-raised)',
                  color: 'var(--text)',
                }}
              >
                <div className="flex flex-col gap-3 sm:flex-row">
                  {event.image && (
                    <img
                      src={event.image.url}
                      alt=""
                      loading="lazy"
                      className="h-36 w-full shrink-0 rounded object-cover sm:h-24 sm:w-24"
                    />
                  )}
                  <div className="min-w-0 break-words">
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {CATEGORY_LABELS[event.category] ?? event.category}
                      {event.civilization ? ` · ${event.civilization}` : ''}
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
