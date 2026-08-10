import { useMemo, useState } from 'react'
import { Link } from 'react-router'

import { CONTINENTS } from '../config'
import {
  NOT_AVAILABLE,
  formatExact,
  formatGrowthRate,
  formatPopulation,
} from '../lib/format'
import type { PopulationRow } from '../types'

type SortKey = 'name' | 'population' | 'growthRate' | 'continent'

interface EntityTableProps {
  rows: PopulationRow[]
  year: number
  revision: number
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
 */
export function EntityTable({ rows, year, revision, note }: EntityTableProps) {
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('population')
  const [ascending, setAscending] = useState(false)

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const filtered = needle
      ? rows.filter(
          (row) =>
            row.name.toLowerCase().includes(needle) ||
            row.iso3.toLowerCase().includes(needle),
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
  }, [rows, query, sortKey, ascending])

  function toggleSort(key: SortKey) {
    if (key === sortKey) {
      setAscending((value) => !value)
      return
    }
    setSortKey(key)
    setAscending(key === 'name' || key === 'continent')
  }

  const header = (key: SortKey, label: string, numeric = false) => (
    <th
      scope="col"
      className={`px-3 py-2 font-medium ${numeric ? 'text-right' : 'text-left'}`}
      aria-sort={
        sortKey === key ? (ascending ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        type="button"
        onClick={() => toggleSort(key)}
        className="underline-offset-2 hover:underline"
      >
        {label}
        {sortKey === key && <span aria-hidden="true">{ascending ? ' ▲' : ' ▼'}</span>}
      </button>
    </th>
  )

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide">
          All entities
        </h2>
        <label className="text-sm">
          <span className="sr-only">Search entities by name or ISO3 code</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search name or ISO3…"
            className="rounded border px-2 py-1"
            style={{
              borderColor: 'var(--border)',
              background: 'var(--surface-raised)',
              color: 'var(--text)',
            }}
          />
        </label>
      </div>

      <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
        {visible.length} of {rows.length} entities. Population from UN World
        Population Prospects {revision}, medium variant, {year}.
        {note ? ` ${note}` : ''}
      </p>

      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">
            Population and growth rate by entity, {year}. Sortable.
          </caption>
          <thead>
            <tr
              className="border-b"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            >
              {header('name', 'Entity')}
              {header('continent', 'Continent')}
              {header('population', `Population (${year})`, true)}
              {header('growthRate', 'Growth rate', true)}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr
                key={row.iso3}
                className="border-b"
                style={{ borderColor: 'var(--border)' }}
              >
                <th scope="row" className="px-3 py-1.5 text-left font-normal">
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
                  title={row.available ? formatExact(row.population) : undefined}
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
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {row.growthRate === null || row.growthRate === undefined ? (
                    <span style={{ color: 'var(--text-muted)' }}>
                      {NOT_AVAILABLE}
                    </span>
                  ) : (
                    formatGrowthRate(row.growthRate)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
