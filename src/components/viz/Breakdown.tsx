import { useId, useState, type ReactNode } from 'react'

import { Icon } from '../Icon'
import { capitalizeFirst, formatShare } from '../../lib/format'
import type { BreakdownOther } from '../../types'
import { OTHER_TOKEN, VintageBadge } from './primitives'

/**
 * THE percentage-breakdown pattern for the whole site (2026-08-29, Phase 2.1):
 * ranked horizontal bars, one row per category, label on the left, share
 * as text on the right, bar length proportional to the share.
 *
 * It replaces the stacked/segmented bar that Biomes, compositions, trade
 * partners, land use, urban/rural and GDP sectors all used. A segmented bar
 * makes the reader hover to learn what a 3% sliver is, cannot label eight
 * segments, and carries meaning by colour alone. Rows fix all three:
 *
 *   - every label is readable without hovering, at any width
 *   - every percentage is printed as text, right-aligned, tabular figures
 *   - colour carries no meaning: every bar is the same accent; the explicit
 *     "Other" row is the neutral token and says so in words
 *   - the layout is one column, so it works on a phone as-is
 *
 * The rows ARE the table (a real <table> for screen readers and copy-paste),
 * so no "show as table" toggle is needed.
 *
 * Section-0 rules still enforced here: the vintage badge is prominent;
 * percentages render exactly as published (bar widths scale to the largest
 * share, values never rescale); an unquantified or suppressed source
 * renders its prose, never a chart.
 */

export interface BreakdownRow {
  label: string
  percent: number
  /** "less than 1%" -- rendered with a < sign. */
  isUpperBound?: boolean
  official?: boolean
  /** Muted detail under the label (census note, sub-split, km² ...). */
  detail?: string | null
  /** OpenMoji hexcode, decorative. */
  icon?: string | null
}

export function Breakdown({
  title,
  rows,
  other,
  sourceName,
  vintageYear,
  vintageQualifier,
  note,
  footnote,
  unquantified,
  suppressedText,
  suppressedReason,
  headingLevel = 3,
  maxRows,
  children,
}: {
  title: string
  rows: BreakdownRow[]
  /** The explicit remainder that completes the breakdown to 100%. */
  other?: BreakdownOther | null | undefined
  sourceName: string
  vintageYear?: number | null | undefined
  vintageQualifier?: string | null | undefined
  /** Source note (e.g. "top five export partners ..."). */
  note?: string | null | undefined
  /** Overlap / reconciliation sentence from the completion rules. */
  footnote?: string | null | undefined
  /** Categories the source lists without a share. */
  unquantified?: string[] | undefined
  /** When set, the breakdown is suppressed and this prose renders instead. */
  suppressedText?: string | null | undefined
  suppressedReason?: string | null | undefined
  headingLevel?: 3 | 4
  /** Fold rows past this count behind a "show all" control (default: all). */
  maxRows?: number | undefined
  /** Extra content under the rows (boundary notes, ecoregion lines ...). */
  children?: ReactNode
}) {
  const [showAll, setShowAll] = useState(false)
  const listId = useId()
  const Heading = headingLevel === 4 ? 'h4' : 'h3'

  const heading = (
    <Heading className="text-sm font-medium">
      {title}
      {vintageYear !== undefined && (
        <VintageBadge year={vintageYear ?? null} qualifier={vintageQualifier} />
      )}
    </Heading>
  )

  if (suppressedText) {
    return (
      <div>
        {heading}
        <p className="mt-2 text-sm">{suppressedText}</p>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {suppressedReason} Source: {sourceName}.
        </p>
        {note && (
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {note}
          </p>
        )}
      </div>
    )
  }

  const sorted = [...rows].sort((a, b) => b.percent - a.percent)
  const allRows: (BreakdownRow & { isOther?: boolean })[] = other
    ? [
        ...sorted,
        {
          label: other.label,
          percent: other.percent,
          detail: other.tooltip,
          isOther: true,
        },
      ]
    : sorted
  const folded = maxRows !== undefined && !showAll && allRows.length > maxRows + 1
  const visible = folded ? allRows.slice(0, maxRows) : allRows
  const hidden = folded ? allRows.length - visible.length : 0
  // Bars scale to the LARGEST share, so a 2% row is still a visible sliver
  // and a 98% row fills the track; the printed value is the truth.
  const max = Math.max(...allRows.map((r) => r.percent), 1)

  return (
    <div>
      {heading}
      <table
        id={listId}
        className="mt-2 w-full border-collapse text-sm"
        style={{ tableLayout: 'fixed' }}
      >
        <caption className="sr-only">
          {title}, share of total, {vintageYear ?? 'year not stated'}
        </caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Share</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row, index) => (
            <tr key={`${row.label}-${index}`}>
              <th
                scope="row"
                className="py-1 pr-3 text-left align-top font-normal"
                style={{ width: '42%' }}
              >
                <span className="flex items-start gap-1.5">
                  {row.icon && <Icon code={row.icon} className="mt-0.5" />}
                  <span>
                    <span
                      title={row.isOther ? (row.detail ?? undefined) : undefined}
                    >
                      {capitalizeFirst(row.label)}
                      {row.official && (
                        <span style={{ color: 'var(--text-muted)' }}>
                          {' '}
                          (official)
                        </span>
                      )}
                    </span>
                    {row.detail && (
                      <span
                        className="block text-xs"
                        style={{ color: 'var(--text-muted)' }}
                      >
                        {row.detail}
                      </span>
                    )}
                  </span>
                </span>
              </th>
              <td className="py-1 align-top">
                <span className="flex items-center gap-2">
                  <span
                    className="h-3 flex-1 overflow-hidden rounded-sm"
                    style={{ background: 'var(--bar-track)' }}
                    aria-hidden="true"
                  >
                    <span
                      className="block h-full rounded-sm"
                      style={{
                        width: `${Math.max((row.percent / max) * 100, 0.75)}%`,
                        background: row.isOther ? OTHER_TOKEN : 'var(--bar-fill)',
                      }}
                    />
                  </span>
                  <span
                    className="w-14 shrink-0 text-right"
                    style={{ fontVariantNumeric: 'tabular-nums' }}
                  >
                    {row.isUpperBound ? '<' : ''}
                    {formatShare(row.percent)}%
                  </span>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {hidden > 0 && (
        <button
          type="button"
          className="mt-1 text-xs underline underline-offset-2"
          style={{ color: 'var(--text-muted)' }}
          aria-controls={listId}
          aria-expanded={false}
          onClick={() => setShowAll(true)}
        >
          Show {hidden} more
        </button>
      )}

      {other && (
        <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
          “{other.label}” ({formatShare(other.percent)}%) is the difference
          between the published categories and 100%: {other.tooltip}
        </p>
      )}

      <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        Source: {sourceName}
        {vintageYear ? `, ${vintageYear}` : ''}. Percentages are shown exactly
        as published and are not rescaled.
        {footnote && <> {footnote}</>}
      </p>

      {unquantified && unquantified.length > 0 && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Listed without a published share:{' '}
          {unquantified.map((item) => capitalizeFirst(item)).join(', ')}.
        </p>
      )}

      {note && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {note}
        </p>
      )}

      {children}
    </div>
  )
}
