import { useId, useState } from 'react'

import { OTHER_TOKEN, seriesColour } from './primitives'
import type { BiomeShare } from '../../types'

const MAX_SLOTS = 8

/**
 * Biome breakdown as a proportional bar.
 *
 * Shares are percentages of the entity's OWN land area, so the bar
 * deliberately does not fill its track when ecoregion coverage is incomplete.
 * That empty tail is information: it is inland water, ice, or island area the
 * ecoregion layer does not resolve. Stretching the bar to full width would
 * erase a real gap.
 */
export function BiomeBar({
  biomes,
  coveredShare,
  landAreaKm2,
  ecoregions,
  areaDiffersFromPublishedPct,
  publishedAreaKm2,
}: {
  biomes: BiomeShare[]
  coveredShare: number
  landAreaKm2: number
  ecoregions?: { name: string; share: number }[]
  /** Set when the drawn polygon disagrees with the published land area. */
  areaDiffersFromPublishedPct?: number | undefined
  publishedAreaKm2?: number | null | undefined
}) {
  const [showTable, setShowTable] = useState(false)
  const tableId = useId()

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

  const sorted = [...biomes].sort((a, b) => b.share - a.share)
  const head = sorted.slice(0, MAX_SLOTS)
  const tail = sorted.slice(MAX_SLOTS)
  const tailShare = tail.reduce((sum, b) => sum + b.share, 0)

  const segments = [
    ...head.map((b, index) => ({ ...b, colour: seriesColour(index) })),
    ...(tail.length
      ? [
          {
            biome: `other (${tail.length} biomes)`,
            share: tailShare,
            areaKm2: tail.reduce((s, b) => s + b.areaKm2, 0),
            colour: OTHER_TOKEN,
          },
        ]
      : []),
  ]

  const gap = Math.max(0, 100 - coveredShare)

  return (
    <div>
      <div
        className="flex h-6 w-full overflow-hidden rounded"
        role="img"
        aria-label={`Biome shares: ${segments
          .map((s) => `${s.biome} ${s.share.toFixed(1)}%`)
          .join(', ')}${gap > 1 ? `. ${gap.toFixed(1)}% not covered by any ecoregion.` : ''}`}
        style={{ background: 'var(--map-no-data)' }}
      >
        {segments.map((segment, index) => (
          <div
            key={`${segment.biome}-${index}`}
            style={{
              width: `${segment.share}%`,
              background: segment.colour,
              marginRight: 2,
            }}
            title={`${segment.biome}: ${segment.share.toFixed(2)}% (${Math.round(segment.areaKm2).toLocaleString()} km²)`}
          />
        ))}
      </div>

      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {segments.map((segment, index) => (
          <li key={`${segment.biome}-legend-${index}`} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: segment.colour }}
              aria-hidden="true"
            />
            <span>{segment.biome}</span>
            <span
              style={{
                color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {segment.share.toFixed(1)}%
            </span>
          </li>
        ))}
        {gap > 1 && (
          <li className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ background: 'var(--map-no-data)' }}
              aria-hidden="true"
            />
            <span>no ecoregion assigned</span>
            <span
              style={{
                color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {gap.toFixed(1)}%
            </span>
          </li>
        )}
      </ul>

      <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        Shares are percentages of {Math.round(landAreaKm2).toLocaleString()} km²
        of land, measured in an equal-area projection (EPSG:6933).
        {gap > 1 && (
          <>
            {' '}
            {gap.toFixed(1)}% carries no terrestrial ecoregion — inland water,
            ice, or island area the source does not resolve. It is shown as a
            gap rather than redistributed.
          </>
        )}{' '}
        Source: RESOLVE Ecoregions 2017.
      </p>

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

      <button
        type="button"
        className="mt-2 text-xs underline underline-offset-2"
        style={{ color: 'var(--text-muted)' }}
        aria-expanded={showTable}
        aria-controls={tableId}
        onClick={() => setShowTable((v) => !v)}
      >
        {showTable ? 'Hide table' : 'Show as table'}
      </button>

      {showTable && (
        <div className="overflow-x-auto">
        <table id={tableId} className="mt-2 w-full min-w-[20rem] text-xs">
          <caption className="sr-only">Biome shares of land area</caption>
          <thead>
            <tr style={{ color: 'var(--text-muted)' }}>
              <th scope="col" className="py-1 text-left font-medium">Biome</th>
              <th scope="col" className="py-1 text-right font-medium">Share</th>
              <th scope="col" className="py-1 text-right font-medium">Area</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((biome) => (
              <tr
                key={biome.biome}
                className="border-t"
                style={{ borderColor: 'var(--border)' }}
              >
                <th scope="row" className="py-1 text-left font-normal">
                  {biome.biome}
                </th>
                <td className="py-1 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {biome.share.toFixed(2)}%
                </td>
                <td className="py-1 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {Math.round(biome.areaKm2).toLocaleString()} km²
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
