import { useId, useState } from 'react'

import { Icon } from '../Icon'
import { capitalizeFirst, formatShare } from '../../lib/format'
import type { BreakdownOther } from '../../types'
import { OTHER_TOKEN, VintageBadge, seriesColour } from './primitives'

export interface CompositionItem {
  label: string
  percent: number | null
  isUpperBound: boolean
  official: boolean
  qualifier: string | null
  /** The source published this residual itself (land use "other"). */
  fromSource?: boolean
}

export interface CompositionField {
  available: boolean
  unavailableReason?: string
  text?: string
  vintageYear?: number | null
  vintageQualifier?: string | null
  chartable?: boolean
  items?: CompositionItem[]
  percentTotal?: number | null
  sumsToApprox100?: boolean | null
  sharesMayOverlap?: boolean
  sourceTextMalformed?: boolean
  malformedReason?: string | null
  note?: string | null
  /** Completion state from etl/breakdown.py (or src/lib/breakdown.ts). */
  other?: BreakdownOther | null
  overlapPercent?: number | null
  overlapNote?: string | null
  breakdownSuppressed?: boolean
  breakdownNote?: string | null
}

/** Categories past this fold into an explicit "other" rather than a 9th hue. */
const MAX_SLOTS = 8

/**
 * Proportional composition bar with a table twin.
 *
 * Form choice: a stacked proportional bar, not a pie. These breakdowns often
 * carry 8+ categories with several under 2%, which a pie renders as
 * indistinguishable slivers.
 *
 * The table is not optional. Three of the light-mode categorical slots sit
 * below 3:1 against the surface, and the dataviz relief rule requires visible
 * labels or a table view when that is true. It is also the only way a screen
 * reader reaches these values.
 *
 * Section 0 rules enforced here:
 *   - the vintage badge is prominent, never a footnote
 *   - percentages render exactly as published; nothing is rescaled to 100
 *   - a malformed or unquantified source renders as prose, never as a chart
 */
export function CompositionBar({
  title,
  field,
  sourceName,
  iconFor,
}: {
  title: string
  field: CompositionField
  sourceName: string
  /**
   * Decorative OpenMoji hexcode per category label (e.g. religion symbols).
   * When set, the legend renders as a vertical bulleted list instead of an
   * inline wrap, so each category reads as its own line with its symbol.
   */
  iconFor?: (label: string) => string | null
}) {
  const [showTable, setShowTable] = useState(false)
  const tableId = useId()

  if (!field.available) {
    return (
      <div>
        <h3 className="text-sm font-medium">{title}</h3>
        <div
          className="mt-2 rounded border border-dashed px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
        >
          Not collected or not published — {sourceName} publishes no{' '}
          {title.toLowerCase()} for this entity.
        </div>
      </div>
    )
  }

  const items = field.items ?? []
  const quantified = items.filter(
    (item): item is CompositionItem & { percent: number } =>
      item.percent !== null,
  )

  // Prose, malformed source, or a breakdown the completion rules suppressed
  // (shares more than a couple of points over 100): show the published
  // wording, never a chart.
  if (!field.chartable || field.breakdownSuppressed) {
    return (
      <div>
        <h3 className="text-sm font-medium">
          {title}
          <VintageBadge
            year={field.vintageYear ?? null}
            qualifier={field.vintageQualifier}
          />
        </h3>
        <p className="mt-2 text-sm">{field.text}</p>
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {field.breakdownSuppressed
            ? field.breakdownNote
            : field.sourceTextMalformed
              ? field.malformedReason
              : 'Published as a list without percentages, so no breakdown is shown. ' +
                'Deriving one would mean inventing numbers the source does not give.'}
          {' '}Source: {sourceName}.
        </p>
        {field.note && (
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {field.note}
          </p>
        )}
      </div>
    )
  }

  const sorted = [...quantified].sort((a, b) => b.percent - a.percent)
  const head = sorted.slice(0, MAX_SLOTS)
  const tail = sorted.slice(MAX_SLOTS)
  const tailTotal = tail.reduce((sum, item) => sum + item.percent, 0)
  // The explicit "Other" that makes the breakdown total exactly 100%. Always
  // last, always the neutral token, and its meaning is spelled out in the
  // legend/table -- the tooltip alone would fail the no-tooltip-only rule.
  const other = field.other
    ? {
        label: field.other.label,
        percent: field.other.percent,
        isUpperBound: false,
        official: false,
        qualifier: field.other.tooltip,
        colour: OTHER_TOKEN,
        isOther: true,
      }
    : null

  const segments = [
    ...head.map((item, index) => ({
      ...item,
      colour: seriesColour(index),
    })),
    ...(tail.length
      ? [
          {
            // NOT called "other": several sources publish their own "other"
            // category, and the United States' religions showed two "other"
            // rows side by side -- one from the source, one from this fold.
            label: `Smaller categories (${tail.length})`,
            percent: tailTotal,
            isUpperBound: false,
            official: false,
            qualifier: tail.map((t) => t.label).join(', '),
            colour: OTHER_TOKEN,
          },
        ]
      : []),
    ...(other ? [other] : []),
  ]
  const tableRows = other ? [...sorted, other] : sorted

  const total = segments.reduce((sum, s) => sum + s.percent, 0)
  const scale = total > 0 ? 100 / total : 0
  const unquantified = items.filter((item) => item.percent === null)

  return (
    <div>
      <h3 className="text-sm font-medium">
        {title}
        <VintageBadge
          year={field.vintageYear ?? null}
          qualifier={field.vintageQualifier}
        />
      </h3>

      {/* 2px surface gaps between segments rather than borders. */}
      <div
        className="mt-2 flex h-6 w-full overflow-hidden rounded"
        role="img"
        aria-label={`${title}: ${segments
          .map((s) => `${capitalizeFirst(s.label)} ${formatShare(s.percent)}%`)
          .join(', ')}`}
      >
        {segments.map((segment, index) => (
          <div
            key={`${segment.label}-${index}`}
            style={{
              width: `${segment.percent * scale}%`,
              background: segment.colour,
              marginRight: index < segments.length - 1 ? 2 : 0,
            }}
            title={`${capitalizeFirst(segment.label)}: ${formatShare(segment.percent)}%`}
          />
        ))}
      </div>

      {/* Icon-led legends list EVERY category individually -- the bar folds
          the tail into one "Smaller categories" segment to stay at 8 hues,
          but a reader wants each category named with its symbol. Non-icon
          legends keep the folded inline form. */}
      <ul
        className={
          iconFor
            ? 'mt-2 space-y-1 text-xs'
            : 'mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs'
        }
      >
        {(iconFor
          ? [
              ...sorted.map((item, index) => ({
                ...item,
                colour: index < MAX_SLOTS ? seriesColour(index) : OTHER_TOKEN,
              })),
              ...(other ? [other] : []),
            ]
          : segments
        ).map((segment, index) => (
          <li key={`${segment.label}-legend-${index}`} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: segment.colour }}
              aria-hidden="true"
            />
            {iconFor && iconFor(segment.label) && (
              <Icon code={iconFor(segment.label)!} />
            )}
            <span title={'isOther' in segment ? segment.qualifier ?? undefined : undefined}>
              {capitalizeFirst(segment.label)}
              {segment.official && ' (official)'}
            </span>
            <span
              style={{
                color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {segment.isUpperBound ? '<' : ''}
              {formatShare(segment.percent)}%
            </span>
          </li>
        ))}
      </ul>
      {other && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          “Other” ({formatShare(other.percent)}%) is the difference between the
          published categories and 100%: {other.qualifier}
        </p>
      )}

      <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        Source: {sourceName}
        {field.vintageYear ? `, ${field.vintageYear}` : ''}. Percentages are
        shown exactly as published and are not rescaled.
        {field.overlapNote && <> {field.overlapNote}</>}
        {!field.overlapNote && field.breakdownNote && <> {field.breakdownNote}</>}
      </p>

      {unquantified.length > 0 && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Listed without a published share:{' '}
          {unquantified.map((item) => capitalizeFirst(item.label)).join(', ')}.
        </p>
      )}

      {field.note && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {field.note}
        </p>
      )}

      <button
        type="button"
        className="mt-2 text-xs underline underline-offset-2"
        style={{ color: 'var(--text-muted)' }}
        aria-expanded={showTable}
        aria-controls={tableId}
        onClick={() => setShowTable((value) => !value)}
      >
        {showTable ? 'Hide table' : 'Show as table'}
      </button>

      {showTable && (
        <div className="overflow-x-auto">
        <table id={tableId} className="mt-2 w-full min-w-[18rem] text-xs">
          <caption className="sr-only">
            {title}, {field.vintageYear ?? 'year not stated'}
          </caption>
          <thead>
            <tr style={{ color: 'var(--text-muted)' }}>
              <th scope="col" className="py-1 text-left font-medium">
                Category
              </th>
              <th scope="col" className="py-1 text-right font-medium">
                Share
              </th>
            </tr>
          </thead>
          <tbody>
            {tableRows.map((item, index) => (
              <tr
                key={`${item.label}-row-${index}`}
                className="border-t"
                style={{ borderColor: 'var(--border)' }}
              >
                <th scope="row" className="py-1 text-left font-normal">
                  {capitalizeFirst(item.label)}
                  {item.official && ' (official)'}
                  {item.qualifier && (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {' '}— {item.qualifier}
                    </span>
                  )}
                </th>
                <td
                  className="py-1 text-right"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {item.isUpperBound ? '<' : ''}
                  {formatShare(item.percent)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
    </div>
  )
}
