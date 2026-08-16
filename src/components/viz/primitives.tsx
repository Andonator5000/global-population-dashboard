import type { ReactNode } from 'react'

/**
 * Shared building blocks for every figure on a country page.
 *
 * The brief makes two things non-negotiable, so they are expressed as
 * components rather than conventions someone has to remember:
 *
 *   <SourceLine>   every figure names its source and the vintage of the
 *                  observation, not the date we fetched it
 *   <Unavailable>  missing data says which source does not publish it, in
 *                  words -- never a zero, never a blank chart
 */

/** Fixed categorical slots. Assigned by index, never cycled past 8. */
export const SERIES_TOKENS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
  'var(--series-6)',
  'var(--series-7)',
  'var(--series-8)',
] as const

export const OTHER_TOKEN = 'var(--series-other)'

/** Colour for slot `index`; anything past the 8th folds into "other". */
export function seriesColour(index: number): string {
  return SERIES_TOKENS[index] ?? OTHER_TOKEN
}

export function SourceLine({
  source,
  vintage,
  qualifier,
  note,
}: {
  source: string
  vintage?: number | string | null | undefined
  qualifier?: string | null | undefined
  note?: string | null | undefined
}) {
  return (
    <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
      Source: {source}
      {vintage
        ? ` · ${vintage}${qualifier ? ` ${qualifier}.` : ''}`
        : ' · observation year not stated by the publisher'}
      {note && <span className="mt-1 block">{note}</span>}
    </p>
  )
}

export function Unavailable({
  what,
  source,
  reason,
}: {
  what: string
  source: string
  reason?: string | null | undefined
}) {
  return (
    <div
      className="rounded border border-dashed px-3 py-2 text-sm"
      style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
    >
      <strong style={{ fontWeight: 500 }}>{what}</strong> — not available from{' '}
      {source}.{reason ? ` ${reason}` : ''}
    </div>
  )
}

/**
 * A prominent vintage badge.
 *
 * Composition figures get this rather than a quiet footnote: a country's
 * ethnicity, religion and language figures routinely come from censuses a
 * decade apart (52 countries span 5+ years, 26 span 10+), so the year is part
 * of the number's meaning, not metadata about it.
 */
export function VintageBadge({
  year,
  qualifier,
}: {
  year: number | null
  qualifier?: string | null | undefined
}) {
  const stale = year !== null && new Date().getFullYear() - year >= 15
  return (
    <span
      className="ml-2 rounded px-1.5 py-0.5 text-xs font-normal"
      style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--border)',
        color: stale ? 'var(--text)' : 'var(--text-muted)',
      }}
      title={
        stale
          ? 'This figure is at least 15 years old.'
          : 'Year of the census or estimate.'
      }
    >
      {year === null
        ? 'year not stated'
        : `${year}${qualifier ? ` ${qualifier}.` : ''}`}
      {stale && ' · dated'}
    </span>
  )
}

export function Section({
  id,
  title,
  accent,
  collapsible = false,
  defaultOpen = true,
  children,
}: {
  id: string
  title: string
  accent?: string | null | undefined
  /**
   * Renders as a native <details>/<summary> disclosure. Native, not a
   * button-plus-state, because <details> gives keyboard toggling, screen
   * reader expanded/collapsed announcement, and find-in-page auto-expansion
   * for free — and there is nothing to get out of sync on re-render.
   */
  collapsible?: boolean
  defaultOpen?: boolean
  children: ReactNode
}) {
  const frame = {
    borderColor: 'var(--border)',
    borderLeftColor: accent ?? 'var(--border)',
    // Raised card on the tinted page background, so sections read as
    // surfaces rather than outlines floating on the wash.
    background: 'var(--surface-raised)',
  }

  if (!collapsible) {
    return (
      <section
        id={id}
        className="rounded-lg border border-l-4 px-5 py-4"
        style={frame}
        aria-labelledby={`${id}-heading`}
      >
        <h2 id={`${id}-heading`} className="text-lg font-medium tracking-tight">
          {title}
        </h2>
        <div className="mt-3 space-y-5">{children}</div>
      </section>
    )
  }

  return (
    <details
      id={id}
      className="section-disclosure rounded-lg border border-l-4 px-5 py-4"
      style={frame}
      open={defaultOpen}
    >
      {/* The heading lives INSIDE the summary so the accessible tree keeps
          its h2 landmarks while the whole header row stays the toggle. */}
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
        <h2 id={`${id}-heading`} className="text-lg font-medium tracking-tight">
          {title}
        </h2>
        <svg
          className="section-chevron h-4 w-4 shrink-0"
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </summary>
      <div className="mt-3 space-y-5">{children}</div>
    </details>
  )
}

export function StatTile({
  label,
  value,
  detail,
  source,
  vintage,
}: {
  label: string
  value: string
  detail?: string | null | undefined
  source?: string | undefined
  vintage?: number | string | null | undefined
}) {
  return (
    <div>
      {/* Proportional figures on a display number; tabular-nums is for
          columns that must align, not for a headline. */}
      <div className="text-xl font-semibold tracking-tight">{value}</div>
      <div className="text-sm">{label}</div>
      {detail && (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {detail}
        </div>
      )}
      {source && (
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {source}
          {vintage ? ` · ${vintage}` : ''}
        </div>
      )}
    </div>
  )
}
