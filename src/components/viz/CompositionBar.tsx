import type { BreakdownOther } from '../../types'
import { Breakdown, type BreakdownRow } from './Breakdown'

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

/**
 * A Factbook-shaped composition field rendered through the site's one
 * breakdown pattern (ranked horizontal bars -- see Breakdown.tsx). This is
 * an adapter: it decides between "not published", "prose only" and the
 * chart, and maps items to rows. The stacked bar it used to draw is gone
 * (2026-08-29, Phase 2.1).
 */
export function CompositionBar({
  title,
  field,
  sourceName,
  iconFor,
  maxRows,
}: {
  title: string
  field: CompositionField
  sourceName: string
  /** Decorative OpenMoji hexcode per category label (e.g. religion symbols). */
  iconFor?: (label: string) => string | null
  /** Fold rows past this count behind a "show more" control. */
  maxRows?: number
}) {
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
  // (shares more than a couple of points over 100): the published wording,
  // never a chart.
  if (!field.chartable || field.breakdownSuppressed) {
    return (
      <Breakdown
        title={title}
        rows={[]}
        sourceName={sourceName}
        vintageYear={field.vintageYear ?? null}
        vintageQualifier={field.vintageQualifier}
        note={field.note}
        suppressedText={field.text}
        suppressedReason={
          field.breakdownSuppressed
            ? field.breakdownNote
            : field.sourceTextMalformed
              ? field.malformedReason
              : 'Published as a list without percentages, so no breakdown is shown. ' +
                'Deriving one would mean inventing numbers the source does not give.'
        }
      />
    )
  }

  const rows: BreakdownRow[] = quantified.map((item) => ({
    label: item.label,
    percent: item.percent,
    isUpperBound: item.isUpperBound,
    official: item.official,
    detail: item.qualifier,
    icon: iconFor ? iconFor(item.label) : null,
  }))

  return (
    <Breakdown
      title={title}
      rows={rows}
      other={field.other}
      sourceName={sourceName}
      vintageYear={field.vintageYear ?? null}
      vintageQualifier={field.vintageQualifier}
      note={field.note}
      footnote={field.overlapNote ?? field.breakdownNote}
      unquantified={items.filter((i) => i.percent === null).map((i) => i.label)}
      maxRows={maxRows}
      iconColumn={Boolean(iconFor)}
    />
  )
}
