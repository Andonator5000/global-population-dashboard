import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { CONTINENTS } from '../config'
import {
  NOT_AVAILABLE,
  formatExact,
  formatGrowthRate,
  formatPopulation,
} from '../lib/format'
import type { GdpSummary, PopulationRow } from '../types'

type SortKey = 'name' | 'gdp' | 'population' | 'growthRate' | 'continent'

/** Compact USD for the GDP column; each value carries its own year. */
const usdCompact = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
})

interface EntityTableProps {
  rows: PopulationRow[]
  year: number
  revision: number
  gdp: GdpSummary | null
  /** Shown under the heading; used to explain a scrubbed historical year. */
  note?: string | undefined
}

/**
 * The map's table-view twin.
 *
 * Required, not optional: a tooltip must never be the only way to read a
 * value. Everything the map surfaces on hover is here, sortable, searchable,
 * and reachable with a screen reader -- and it is the practical way to find a
 * microstate that is three pixels wide on the map.
 *
 * Collapsed by default (the map is the page's primary surface), behind a real
 * button with aria-expanded. Rows zebra-stripe with the page tint so long
 * scans keep their place.
 */
export function EntityTable({ rows, year, revision, gdp, note }: EntityTableProps) {
  const [expanded, setExpanded] = useState(false)
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('population')
  const [ascending, setAscending] = useState(false)

  const gdpOf = (iso3: string) => gdp?.entities[iso3] ?? null

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? rows.filter(
          (row) =>
            row.name.toLowerCase().includes(needle) ||
            row.iso3.toLowerCase().includes(needle) ||
            CONTINENTS[row.continent].toLowerCase().includes(needle),
        )
      : rows.slice()

    filtered.sort((a, b) => {
      let comparison: number
      switch (sortKey) {
        case 'name':
          comparison = a.name.localeCompare(b.name)
          break
        case 'continent':
          comparison =
            CONTINENTS[a.continent].localeCompare(CONTINENTS[b.continent]) ||
            a.name.localeCompare(b.name)
          break
        case 'gdp': {
          const av = gdpOf(a.iso3)?.value ?? null
          const bv = gdpOf(b.iso3)?.value ?? null
          if (av === null && bv === null) comparison = a.name.localeCompare(b.name)
          else if (av === null) return 1
          else if (bv === null) return -1
          else comparison = av - bv
          break
        }
        case 'growthRate': {
          // Nulls sort last in both directions -- "unknown" is not "lowest".
          const av = a.growthRate ?? null
          const bv = b.growthRate ?? null
          if (av === null && bv === null) comparison = a.name.localeCompare(b.name)
          else if (av === null) return 1
          else if (bv === null) return -1
          else comparison = av - bv
          break
        }
        default: {
          const av = a.available ? (a.population ?? null) : null
          const bv = b.available ? (b.population ?? null) : null
          if (av === null && bv === null) comparison = a.name.localeCompare(b.name)
          else if (av === null) return 1
          else if (bv === null) return -1
          else comparison = av - bv
        }
      }
      return ascending ? comparison : -comparison
    })
    return filtered
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query, sortKey, ascending, gdp])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAscending((value) => !value)
      return
    }
    setSortKey(key)
    setAscending(key === 'name' || key === 'continent')
  }

  // Sticky, clearly distinguished header (2026-08-29, Phase 2.3): raised
  // surface, bottom rule, muted uppercase labels; the active sort column is
  // in full text colour with its direction glyph. Sort buttons are real
  // buttons, so keyboard users tab to them and press Enter/Space.
  const header = (key: SortKey, label: string, numeric = false) => (
    <th
      scope="col"
      className={`sticky top-0 z-10 px-3 py-2 text-xs font-medium uppercase tracking-wide ${numeric ? 'text-right' : 'text-left'}`}
      style={{
        background: 'var(--surface-raised)',
        color: sortKey === key ? 'var(--text)' : 'var(--text-muted)',
        boxShadow: 'inset 0 -2px 0 var(--border)',
      }}
      aria-sort={
        sortKey === key ? (ascending ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className="rounded underline-offset-2 hover:underline"
      >
        {label}
        <span aria-hidden="true" className="inline-block w-3 text-left">
          {sortKey === key ? (ascending ? ' ▲' : ' ▼') : ''}
        </span>
      </button>
    </th>
  )

  return (
    <section
      className="mt-8 rounded-xl border px-5 py-4"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
      id="all-entities"
      aria-labelledby="all-entities-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2
            id="all-entities-heading"
            className="font-sans text-sm font-medium uppercase tracking-wide"
          >
            All Entities
          </h2>
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls="all-entities-body"
            onClick={() => setExpanded((value) => !value)}
            className="rounded border px-2.5 py-1 text-sm"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface-raised)',
              color: 'var(--text)',
            }}
          >
            {expanded ? 'Collapse table ▲' : 'Expand table ▼'}
          </button>
        </div>
        {expanded && (
          <label className="text-sm">
            <span className="sr-only">
              Search entities by country name, continent, or ISO3 code
            </span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by Country or Continent…"
              className="rounded border px-2 py-1"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface-raised)',
                color: 'var(--text)',
              }}
            />
          </label>
        )}
      </div>

      {!expanded && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {rows.length} entities with GDP, population, and growth rate —
          expand to view, search, and sort.
        </p>
      )}

      {expanded && (
        <div id="all-entities-body">
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            {visible.length} of {rows.length} entities. Population from UN
            World Population Prospects {revision}, medium variant, {year}. GDP
            from the World Bank; each figure carries its own year.
            {note ? ` ${note}` : ''}
          </p>

          <div
            className="mt-3 max-h-[70vh] overflow-auto rounded-lg border"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface)',
            }}
          >
            {/* Dense rows (UI UX Pro Max "data-dense dashboard": 36px rows,
                13px type), hover highlight in the raised token, no zebra. */}
            <table className="entity-table w-full border-collapse text-[13px]">
              <caption className="sr-only">
                GDP, population and growth rate by entity, {year}. Sortable.
              </caption>
              <thead>
                <tr>
                  {header('name', 'Entity')}
                  {header('continent', 'Continent')}
                  {header('gdp', 'GDP (US$)', true)}
                  {header('population', `Population (${year})`, true)}
                  {header('growthRate', 'Growth rate', true)}
                </tr>
              </thead>
              {/* Maintainer ruling (2026-08-29, Phase 2.3, replacing the
                  dark-blue/light-blue zebra of 2026-08-24): neutral rows on
                  the theme surface with a subtle divider, no zebra. Colour is
                  used only where it carries meaning -- the growth-rate sign,
                  which is also printed as +/-. Every cell uses the gated
                  theme tokens, so AA holds in both themes. */}
              <tbody>
                {visible.map((row) => {
                  const rowGdp = gdpOf(row.iso3)
                  return (
                    <tr
                      key={row.iso3}
                      className="border-t"
                      style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
                    >
                      <th scope="row" className="px-3 py-1.5 text-left font-medium">
                        <Link
                          to={`/country/${row.iso3}`}
                          className="underline underline-offset-2"
                        >
                          {row.name}
                        </Link>
                      </th>
                      <td className="px-3 py-1.5">
                        <Link
                          to={`/continent/${row.continent}`}
                          className="underline underline-offset-2"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {CONTINENTS[row.continent]}
                        </Link>
                      </td>
                      <td
                        className="px-3 py-1.5 text-right"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                        title={
                          rowGdp
                            ? `${usdCompact.format(rowGdp.value)} (${rowGdp.year})`
                            : undefined
                        }
                      >
                        {rowGdp ? (
                          <>
                            {usdCompact.format(rowGdp.value)}{' '}
                            <span
                              className="text-xs"
                              style={{ color: 'var(--text-muted)' }}
                            >
                              ({rowGdp.year})
                            </span>
                          </>
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>
                            {NOT_AVAILABLE}
                          </span>
                        )}
                      </td>
                      <td
                        className="px-3 py-1.5 text-right"
                        style={{ fontVariantNumeric: 'tabular-nums' }}
                        title={
                          row.available ? formatExact(row.population) : undefined
                        }
                      >
                        {row.available ? (
                          formatPopulation(row.population)
                        ) : (
                          <span style={{ color: 'var(--text-muted)' }}>
                            {NOT_AVAILABLE}
                          </span>
                        )}
                      </td>
                      <td
                        className="px-3 py-1.5 text-right"
                        style={{
                          fontVariantNumeric: 'tabular-nums',
                          color:
                            row.growthRate === null || row.growthRate === undefined
                              ? 'var(--text-muted)'
                              : row.growthRate > 0
                                ? 'var(--positive)'
                                : row.growthRate < 0
                                  ? 'var(--negative)'
                                  : 'var(--text)',
                        }}
                      >
                        {row.growthRate === null || row.growthRate === undefined
                          ? NOT_AVAILABLE
                          : formatGrowthRate(row.growthRate)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}
