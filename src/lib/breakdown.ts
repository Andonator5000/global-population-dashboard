/**
 * Percentage-breakdown completion for pairs the app assembles at render time
 * from World Bank series (urban/rural, GDP sectors). Mirrors the rules in
 * etl/breakdown.py -- keep the two in step:
 *
 *   total < 100          explicit "Other" for the exact difference
 *   100 < total <= 102   shown as published, with an overlap note
 *   total > 102          breakdown suppressed
 *   gap > 40             shipped without an Other (usually missing data)
 */

import type { CompositionField, CompositionItem } from '../components/viz/CompositionBar'

export const OVERLAP_NOTE_PCT = 2
export const LARGE_GAP_PCT = 40
const ROUNDING_PCT = 0.05

export const OTHER_TOOLTIPS = {
  urbanRural: 'Rounding between the two World Bank series.',
  gdpSectors:
    "Net taxes and subsidies on products, and statistical discrepancy -- the World Bank's sector shares exclude them.",
} as const

export function completeBreakdown(
  kind: keyof typeof OTHER_TOOLTIPS,
  items: CompositionItem[],
  options: { vintageYear?: number | null; note?: string | null } = {},
): CompositionField {
  const quantified = items.filter(
    (i): i is CompositionItem & { percent: number } => i.percent !== null,
  )
  const total = Math.round(quantified.reduce((s, i) => s + i.percent, 0) * 100) / 100
  const gap = Math.round((100 - total) * 100) / 100
  const field: CompositionField = {
    available: true,
    text: quantified.map((i) => `${i.label} ${i.percent}%`).join('; '),
    vintageYear: options.vintageYear ?? null,
    chartable: quantified.length >= 2,
    items,
    percentTotal: total,
    sumsToApprox100: total >= 97 && total <= 103,
    sharesMayOverlap: false,
    note: options.note ?? null,
    other: null,
    overlapPercent: null,
    overlapNote: null,
    breakdownSuppressed: false,
    breakdownNote: null,
  }
  if (gap > ROUNDING_PCT) {
    if (gap > LARGE_GAP_PCT) {
      field.breakdownNote = `The published shares total ${total}%; the source does not account for the remaining ${gap}%, which is too large to label as "other" with confidence.`
    } else {
      field.other = { label: 'Other', percent: gap, tooltip: OTHER_TOOLTIPS[kind] }
    }
  } else if (gap < -ROUNDING_PCT) {
    const overshoot = -gap
    field.overlapPercent = overshoot
    if (overshoot <= OVERLAP_NOTE_PCT) {
      field.overlapNote = `Shares total ${total}%: the source's categories overlap or are rounded, so they are shown exactly as published rather than rescaled.`
    } else {
      field.breakdownSuppressed = true
      field.breakdownNote = `The published shares total ${total}%, ${overshoot} points over 100 -- more than category overlap or rounding can explain -- so no breakdown chart is shown.`
    }
  }
  return field
}
