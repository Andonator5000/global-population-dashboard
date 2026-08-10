import { useId, useState } from 'react'

import { OTHER_TOKEN, VintageBadge, seriesColour } from './primitives'

export interface CompositionItem {
  label: string
  percent: number | null
  isUpperBound: boolean
  official: boolean
  qualifier: string | null
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
}: {
  title: string
  field: CompositionField
  sourceName: string
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

  // Prose or malformed source: show the published wording, never a chart.
  if (!field.chartable) {
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
          {field.sourceTextMalformed
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

  const segments = [
    ...head.map((item, index) => ({
      ...item,
      colour: seriesColour(index),
    })),
    ...(tail.length
      ? [
          {
            label: `other (${tail.length} smaller categories)`,
            percent: tailTotal,
            isUpperBound: false,
            official: false,
            qualifier: tail.map((t) => t.label).join(', '),
            colour: OTHER_TOKEN,
          },
        ]
      : []),
  ]

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
          .map((s) => `${s.label} ${s.percent}%`)
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
            title={`${segment.label}: ${segment.percent}%`}
          />
        ))}
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {segments.map((segment, index) => (
          <li key={`${segment.label}-legend-${index}`} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: segment.colour }}
              aria-hidden="true"
            />
            <span>
              {segment.label}
              {segment.official && ' (official)'}
            </span>
            <span
              style={{
                color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {segment.isUpperBound ? '<' : ''}
              {segment.percent}%
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        Source: {sourceName}
        {field.vintageYear ? `, ${field.vintageYear}` : ''}. Percentages are
        shown exactly as published and are not rescaled.
        {field.percentTotal !== null &&
          field.percentTotal !== undefined &&
          field.sumsToApprox100 === false && (
            <>
              {' '}
              They total {field.percentTotal}%
              {field.sharesMayOverlap
                ? ' because respondents may be counted in more than one category.'
                : ', which the source does not reconcile to 100%.'}
            </>
          )}
      </p>

      {unquantified.length > 0 && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Listed without a published share:{' '}
          {unquantified.map((item) => item.label).join(', ')}.
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
        <table id={tableId} className="mt-2 w-full text-xs">
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
            {sorted.map((item, index) => (
              <tr
                key={`${item.label}-row-${index}`}
                className="border-t"
                style={{ borderColor: 'var(--border)' }}
              >
                <th scope="row" className="py-1 text-left font-normal">
                  {item.label}
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
                  {item.percent}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
