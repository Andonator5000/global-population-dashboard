/**
 * Number formatting.
 *
 * Deliberately conservative: a population is never rounded to fewer than three
 * significant figures in a tooltip, and a null is never rendered as 0 or as an
 * em dash that could be mistaken for a value. Absent data says so in words.
 */

const compact = new Intl.NumberFormat('en', {
  notation: 'compact',
  maximumFractionDigits: 2,
})
const full = new Intl.NumberFormat('en')
const oneDecimal = new Intl.NumberFormat('en', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
})
const twoDecimal = new Intl.NumberFormat('en', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export const NOT_AVAILABLE = 'not available'

export function formatPopulation(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NOT_AVAILABLE
  }
  return compact.format(value)
}

export function formatExact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NOT_AVAILABLE
  }
  return full.format(Math.round(value))
}

/** Growth rate, always signed so decline is unmistakable. */
export function formatGrowthRate(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NOT_AVAILABLE
  }
  const sign = value > 0 ? '+' : ''
  return `${sign}${twoDecimal.format(value)}% per year`
}

export function formatDecimal(
  value: number | null | undefined,
  unit?: string,
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return NOT_AVAILABLE
  }
  return unit ? `${oneDecimal.format(value)} ${unit}` : oneDecimal.format(value)
}

/**
 * Normalise the CIA Factbook's ALL-CAPS surname convention to ordinary case:
 * "President Emmanuel MACRON" -> "President Emmanuel Macron".
 *
 * Display-layer only -- the committed artifact keeps the Factbook's own text.
 * Roman numerals (ABDULLAH II, RAMA X) are preserved, and hyphenated or
 * apostrophised names (AL-SISI, D'ESTAING) title-case each segment. This is a
 * heuristic: a genuine acronym inside a name field would be lowercased too,
 * which is why it is applied only to fields known to use the convention.
 */
export function normaliseFactbookCaps(text: string): string {
  return text.replace(/[\p{Lu}][\p{Lu}'’-]+/gu, (word) =>
    word
      .split(/([-'’])/)
      .map((part) => {
        if (!/^\p{Lu}+$/u.test(part)) return part
        if (/^[IVXLCDM]+$/.test(part) && part.length <= 4) return part
        return part.charAt(0) + part.slice(1).toLowerCase()
      })
      .join(''),
  )
}

/** Direction word for a growth rate, used alongside (never instead of) sign. */
export function growthDirection(
  value: number | null | undefined,
): 'growing' | 'declining' | 'stable' | 'unknown' {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'unknown'
  }
  if (value > 0.05) return 'growing'
  if (value < -0.05) return 'declining'
  return 'stable'
}
