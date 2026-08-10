import { Link, useParams } from 'react-router'

import { CONTINENTS, type ContinentKey } from '../config'
import { useEntities, useMapPalette } from '../lib/data'

/** Phase 1 stub. Full continent detail lands in Phase 6. */
export function ContinentPage() {
  const { id } = useParams<{ id: string }>()
  const state = useEntities()
  const paletteState = useMapPalette()
  const key = id as ContinentKey | undefined
  const name = key && key in CONTINENTS ? CONTINENTS[key] : null

  // Continent accent is the circular mean of member flag hues. A plain
  // arithmetic mean would drop a continent straddling 350 and 10 degrees at
  // 180 (cyan), which is nobody's flag.
  const accent =
    paletteState.status === 'ready' && key
      ? paletteState.data.continentAccent[key]
      : undefined

  if (!name) {
    return (
      <div className="mx-auto max-w-7xl px-6 py-12">
        <h1 className="text-2xl font-semibold">Unknown continent</h1>
        <p className="mt-2" style={{ color: 'var(--text-muted)' }}>
          “{id}” is not one of the seven continent keys.{' '}
          <Link to="/" className="underline underline-offset-2">
            Back to the index
          </Link>
          .
        </p>
      </div>
    )
  }

  const members =
    state.status === 'ready'
      ? state.data
          .filter((entity) => entity.continent === key)
          .sort((a, b) => a.name_common.localeCompare(b.name_common))
      : []

  return (
    <div className="mx-auto max-w-7xl px-6 py-12">
      {accent && (
        <div
          className="mb-4 h-1.5 w-24 rounded-full"
          aria-hidden="true"
          style={{ background: accent.light }}
          title={`Accent derived from the aggregate hue of ${accent.memberFlags} member flags`}
        />
      )}
      <h1 className="text-2xl font-semibold tracking-tight">{name}</h1>
      {accent && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Accent derived from the aggregate hue of {accent.memberFlags} member
          flags.
        </p>
      )}
      <p className="mt-2 max-w-2xl" style={{ color: 'var(--text-muted)' }}>
        Population totals, growth trend, density, median age, urbanisation, and
        the biome breakdown are not built yet (Phase 6). This lists the member
        entities from the registry.
      </p>

      {state.status === 'ready' && (
        <ul className="mt-8 grid gap-x-8 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
          {members.map((entity) => (
            <li key={entity.iso3}>
              <Link
                to={`/country/${entity.iso3}`}
                className="underline underline-offset-2"
              >
                {entity.name_common}
              </Link>
              {entity.status_label && (
                <span style={{ color: 'var(--text-muted)' }}>
                  {' '}— {entity.status_label}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
