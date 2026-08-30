import { biomeIcon } from '../../lib/icons'
import type { BiomeShare, BreakdownOther } from '../../types'
import { Breakdown } from './Breakdown'

/**
 * Biome breakdown through the site's one breakdown pattern (ranked
 * horizontal bars, see Breakdown.tsx). Shares are percentages of the
 * entity's OWN land area and the explicit "Other" row carries the
 * uncovered remainder, so the rows total 100%.
 *
 * Adapter only: the stacked bar this component used to draw is gone
 * (2026-08-29, Phase 2.1).
 */
export function BiomeBar({
  biomes,
  coveredShare,
  landAreaKm2,
  ecoregions,
  areaDiffersFromPublishedPct,
  publishedAreaKm2,
  other,
  overlapNote,
  title = 'Biome Breakdown',
}: {
  biomes: BiomeShare[]
  coveredShare: number
  landAreaKm2: number
  ecoregions?: { name: string; share: number }[]
  /** Set when the drawn polygon disagrees with the published land area. */
  areaDiffersFromPublishedPct?: number | undefined
  publishedAreaKm2?: number | null | undefined
  /** The explicit remainder that completes the breakdown to 100%. */
  other?: BreakdownOther | null | undefined
  overlapNote?: string | null | undefined
  title?: string
}) {
  void coveredShare // the Other row now carries the remainder
  if (biomes.length === 0) {
    return (
      <div
        className="rounded border border-dashed px-3 py-2 text-sm"
        style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
      >
        No biome data — RESOLVE Ecoregions 2017 does not resolve this entity.
      </div>
    )
  }

  return (
    <Breakdown
      title={title}
      rows={biomes.map((b) => ({
        label: b.biome,
        percent: Math.round(b.share * 10) / 10,
        detail: `${Math.round(b.areaKm2).toLocaleString()} km²`,
        icon: biomeIcon(b.biome),
      }))}
      other={other}
      sourceName="RESOLVE Ecoregions 2017"
      footnote={
        `Shares are percentages of ${Math.round(landAreaKm2).toLocaleString()} km² of land, ` +
        `measured in an equal-area projection (EPSG:6933).` +
        (overlapNote ? ` ${overlapNote}` : '')
      }
      maxRows={8}
    >
      {areaDiffersFromPublishedPct !== undefined && (
        <p
          className="mt-2 rounded border border-dashed px-3 py-2 text-xs"
          style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
        >
          <strong style={{ fontWeight: 500 }}>Boundary note.</strong> The
          polygon used here measures{' '}
          {Math.round(landAreaKm2).toLocaleString()} km²
          {publishedAreaKm2
            ? `, against a published land area of ${Math.round(publishedAreaKm2).toLocaleString()} km²`
            : ''}{' '}
          ({areaDiffersFromPublishedPct > 0 ? '+' : ''}
          {areaDiffersFromPublishedPct.toFixed(0)}%). Natural Earth draws the
          de facto administered boundary here, at both the map and biome
          resolutions, so the two agree with each other but differ from the
          internationally recognised extent. These shares describe the land
          inside the drawn polygon.
        </p>
      )}
      {ecoregions && ecoregions.length > 0 && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Largest ecoregions:{' '}
          {ecoregions
            .slice(0, 5)
            .map((e) => `${e.name} (${e.share.toFixed(1)}%)`)
            .join(', ')}
          .
        </p>
      )}
    </Breakdown>
  )
}
