import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router'

import { BiomeBar } from '../components/viz/BiomeBar'
import {
  Section,
  StatTile,
  Unavailable,
} from '../components/viz/primitives'
import { CONTINENTS, UNINHABITED_CONTINENTS, type ContinentKey } from '../config'
import {
  useBiomes,
  useEntities,
  useMapPalette,
  usePopulationSummary,
} from '../lib/data'
import {
  formatDecimal,
  formatExact,
  formatGrowthRate,
  formatPopulation,
} from '../lib/format'
import type { Entity, PopulationRow } from '../types'

const WPP = 'UN World Population Prospects'

type SortKey = 'name' | 'population' | 'growthRate' | 'density'

export function ContinentPage() {
  const { id } = useParams<{ id: string }>()
  const entitiesState = useEntities()
  const summaryState = usePopulationSummary()
  const biomeState = useBiomes()
  const paletteState = useMapPalette()

  const [sortKey, setSortKey] = useState<SortKey>('population')
  const [ascending, setAscending] = useState(false)

  const key = id as ContinentKey | undefined
  const name = key && key in CONTINENTS ? CONTINENTS[key] : null

  const accent =
    paletteState.status === 'ready' && key
      ? paletteState.data.continentAccent[key]
      : undefined

  const rows: PopulationRow[] =
    summaryState.status === 'ready' ? summaryState.data.entities : []
  const entities: Entity[] =
    entitiesState.status === 'ready' ? entitiesState.data : []

  const members = useMemo(
    () => rows.filter((row) => row.continent === key),
    [rows, key],
  )
  const entityByIso3 = useMemo(
    () => new Map(entities.map((e) => [e.iso3, e])),
    [entities],
  )

  const stats = useMemo(() => {
    const withPopulation = members.filter(
      (m): m is PopulationRow & { population: number } =>
        m.available && typeof m.population === 'number',
    )
    const total = withPopulation.reduce((sum, m) => sum + m.population, 0)
    const worldTotal = rows.reduce(
      (sum, m) => (m.available && m.population ? sum + m.population : sum),
      0,
    )
    const area = members.reduce((sum, m) => {
      const entity = entityByIso3.get(m.iso3)
      return sum + (entity?.area_km2 ?? 0)
    }, 0)

    const byPopulation = [...withPopulation].sort(
      (a, b) => b.population - a.population,
    )
    const withDensity = withPopulation
      .map((m) => ({ row: m, density: m.density ?? null }))
      .filter((d): d is { row: typeof d.row; density: number } => d.density !== null)
      .sort((a, b) => b.density - a.density)

    // Population-weighted, because averaging country medians would let a
    // microstate pull the figure as hard as a country of a billion people.
    const weighted = (field: 'medianAge' | 'growthRate') => {
      let numerator = 0
      let denominator = 0
      for (const m of withPopulation) {
        const value = m[field]
        if (typeof value === 'number') {
          numerator += value * m.population
          denominator += m.population
        }
      }
      return denominator > 0 ? numerator / denominator : null
    }

    return {
      total,
      shareOfWorld: worldTotal > 0 ? (total / worldTotal) * 100 : 0,
      area,
      density: area > 0 ? total / area : null,
      count: members.length,
      countWithData: withPopulation.length,
      largest: byPopulation[0],
      smallest: byPopulation[byPopulation.length - 1],
      mostDense: withDensity[0],
      leastDense: withDensity[withDensity.length - 1],
      medianAge: weighted('medianAge'),
      growthRate: weighted('growthRate'),
    }
  }, [members, rows, entityByIso3])

  const sorted = useMemo(() => {
    const list = [...members]
    list.sort((a, b) => {
      let comparison: number
      if (sortKey === 'name') {
        comparison = a.name.localeCompare(b.name)
      } else {
        // Nulls last in both directions -- "unknown" is not "smallest".
        const av = (a[sortKey] as number | null | undefined) ?? null
        const bv = (b[sortKey] as number | null | undefined) ?? null
        if (av === null && bv === null) comparison = a.name.localeCompare(b.name)
        else if (av === null) return 1
        else if (bv === null) return -1
        else comparison = av - bv
      }
      return ascending ? comparison : -comparison
    })
    return list
  }, [members, sortKey, ascending])

  if (!name || !key) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-2xl font-semibold">Unknown continent</h1>
        <p className="mt-2" style={{ color: 'var(--text-muted)' }}>
          “{id}” is not one of the seven continent keys.{' '}
          <Link to="/" className="underline underline-offset-2">
            Back to the map
          </Link>
          .
        </p>
      </div>
    )
  }

  const biome =
    biomeState.status === 'ready' ? biomeState.data.continents[key] : undefined
  const uninhabited = UNINHABITED_CONTINENTS.includes(key)

  const header = (column: SortKey, label: string, numeric = false) => (
    <th
      scope="col"
      className={`px-3 py-2 font-medium ${numeric ? 'text-right' : 'text-left'}`}
      aria-sort={
        sortKey === column ? (ascending ? 'ascending' : 'descending') : 'none'
      }
    >
      <button
        type="button"
        className="underline-offset-2 hover:underline"
        onClick={() => {
          if (sortKey === column) setAscending((v) => !v)
          else {
            setSortKey(column)
            setAscending(column === 'name')
          }
        }}
      >
        {label}
        {sortKey === column && (
          <span aria-hidden="true">{ascending ? ' ▲' : ' ▼'}</span>
        )}
      </button>
    </th>
  )

  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      {accent && (
        <div
          className="mb-4 h-1.5 w-24 rounded-full"
          aria-hidden="true"
          style={{ background: accent.light }}
        />
      )}
      <h1 className="text-3xl font-semibold tracking-tight">{name}</h1>
      {accent && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Accent derived from the aggregate hue of {accent.memberFlags} member
          flags.
        </p>
      )}

      {uninhabited && (
        <p
          className="mt-4 rounded-lg border px-4 py-3 text-sm"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--surface-raised)',
          }}
        >
          <strong>No permanent population.</strong> Antarctica and the
          sub-Antarctic territories have no permanent inhabitants, only rotating
          research staff. They are excluded from every per-capita, density and
          population ranking so they cannot distort them. Only land area and
          biome data are shown.
        </p>
      )}

      <div className="mt-8 space-y-5">
        {!uninhabited && (
          <Section id="population" title="Population" accent={accent?.light}>
            <div className="grid gap-4 sm:grid-cols-3">
              <StatTile
                label="Total population"
                value={formatPopulation(stats.total)}
                detail={formatExact(stats.total)}
                source={`${WPP} 2024`}
                vintage={summaryState.status === 'ready' ? summaryState.data.year : null}
              />
              <StatTile
                label="Share of world population"
                value={`${stats.shareOfWorld.toFixed(1)}%`}
                source={`${WPP} 2024`}
              />
              <StatTile
                label="Growth rate"
                value={formatGrowthRate(stats.growthRate)}
                detail="population-weighted mean of member countries"
                source={`${WPP} 2024`}
              />
              <StatTile
                label="Constituent entities"
                value={String(stats.count)}
                detail={`${stats.countWithData} with published population data`}
              />
              <StatTile
                label="Land area"
                value={`${Math.round(stats.area).toLocaleString()} km²`}
                source="mledoze/countries"
              />
              <StatTile
                label="Population density"
                value={
                  stats.density === null
                    ? 'not available'
                    : `${stats.density.toFixed(1)} per km²`
                }
                detail="total population ÷ total land area"
              />
              <StatTile
                label="Median age"
                value={formatDecimal(stats.medianAge, 'years')}
                detail="population-weighted mean"
                source={`${WPP} 2024`}
              />
              {stats.largest && (
                <StatTile
                  label="Largest by population"
                  value={stats.largest.name}
                  detail={formatPopulation(stats.largest.population)}
                />
              )}
              {stats.smallest && (
                <StatTile
                  label="Smallest by population"
                  value={stats.smallest.name}
                  detail={formatPopulation(stats.smallest.population)}
                />
              )}
              {stats.mostDense && (
                <StatTile
                  label="Most dense"
                  value={stats.mostDense.row.name}
                  detail={`${stats.mostDense.density.toFixed(0)} per km²`}
                />
              )}
              {stats.leastDense && (
                <StatTile
                  label="Least dense"
                  value={stats.leastDense.row.name}
                  detail={`${stats.leastDense.density.toFixed(1)} per km²`}
                />
              )}
            </div>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Continent totals are summed from member countries rather than
              quoted from UN regional aggregates, because this project uses the
              seven-continent model and the UN publishes five regions. See
              DATA_DECISIONS.md §2.
            </p>
          </Section>
        )}

        <Section id="land" title="Land and biomes" accent={accent?.light}>
          {biome ? (
            <BiomeBar
              biomes={biome.biomes}
              coveredShare={biome.coveredShare}
              landAreaKm2={biome.landAreaKm2}
            />
          ) : (
            <Unavailable
              what="Biome breakdown"
              source="RESOLVE Ecoregions 2017"
            />
          )}
        </Section>

        <Section id="members" title="Member entities" accent={accent?.light}>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <caption className="sr-only">
                Entities in {name}, sortable by population, growth rate and
                density.
              </caption>
              <thead>
                <tr
                  className="border-b"
                  style={{
                    borderColor: 'var(--border)',
                    color: 'var(--text-muted)',
                  }}
                >
                  {header('name', 'Entity')}
                  {header('population', 'Population', true)}
                  {header('growthRate', 'Growth rate', true)}
                  {header('density', 'Density', true)}
                </tr>
              </thead>
              <tbody>
                {sorted.map((row) => (
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
                    <td
                      className="px-3 py-1.5 text-right"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {row.available ? (
                        formatPopulation(row.population)
                      ) : (
                        <span style={{ color: 'var(--text-muted)' }}>
                          not available
                        </span>
                      )}
                    </td>
                    <td
                      className="px-3 py-1.5 text-right"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {row.growthRate === null || row.growthRate === undefined ? (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      ) : (
                        formatGrowthRate(row.growthRate)
                      )}
                    </td>
                    <td
                      className="px-3 py-1.5 text-right"
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {row.density === null || row.density === undefined ? (
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                      ) : (
                        `${row.density.toFixed(1)}`
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      </div>
    </div>
  )
}
