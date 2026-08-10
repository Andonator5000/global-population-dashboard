import { Link } from 'react-router'

import { CONTINENTS, type ContinentKey } from '../config'
import { useEntities } from '../lib/data'
import type { Entity } from '../types'

/**
 * Phase 1 placeholder.
 *
 * The real hero -- full-bleed equal-area map, live-interpolating counter, time
 * scrubber -- arrives in Phases 3 and 7. For now this renders straight from
 * entities.json, which proves the ETL -> artifact -> app path works end to end
 * and gives the routing something real to navigate.
 */
export function HomePage() {
  const state = useEntities()

  return (
    <div className="mx-auto max-w-7xl px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">
        Global Population Dashboard
      </h1>
      <p className="mt-2 max-w-2xl" style={{ color: 'var(--text-muted)' }}>
        Phase 1 scaffold. The equal-area world map, population figures, and
        live-interpolating counter are not built yet — this page currently shows
        only the entity registry produced by the ETL.
      </p>

      {state.status === 'loading' && (
        <p className="mt-8" style={{ color: 'var(--text-muted)' }}>
          Loading entity registry…
        </p>
      )}

      {state.status === 'error' && (
        <p className="mt-8" style={{ color: 'var(--text-muted)' }}>
          {state.error.message}
        </p>
      )}

      {state.status === 'ready' && (
        <ContinentIndex entities={state.data} />
      )}
    </div>
  )
}

function ContinentIndex({ entities }: { entities: Entity[] }) {
  const grouped = new Map<ContinentKey, number>()
  for (const entity of entities) {
    grouped.set(entity.continent, (grouped.get(entity.continent) ?? 0) + 1)
  }
  const contested = entities.filter((entity) => entity.is_contested)

  return (
    <>
      <section className="mt-10">
        <h2 className="text-sm font-medium uppercase tracking-wide">
          Continents
        </h2>
        <ul className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(Object.keys(CONTINENTS) as ContinentKey[]).map((key) => (
            <li key={key}>
              <Link
                to={`/continent/${key}`}
                className="block rounded-lg border px-4 py-3"
                style={{
                  borderColor: 'var(--border)',
                  background: 'var(--surface-raised)',
                }}
              >
                <span className="font-medium">{CONTINENTS[key]}</span>
                <span className="ml-2" style={{ color: 'var(--text-muted)' }}>
                  {grouped.get(key) ?? 0} entities
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-10">
        <h2 className="text-sm font-medium uppercase tracking-wide">
          Contested and special-status entities
        </h2>
        <p className="mt-1 text-sm" style={{ color: 'var(--text-muted)' }}>
          Each renders as its own entity with its recognition status attached.
          Reasoning is in DATA_DECISIONS.md.
        </p>
        <ul className="mt-4 space-y-2 text-sm">
          {contested.map((entity) => (
            <li key={entity.iso3}>
              <Link
                to={`/country/${entity.iso3}`}
                className="underline underline-offset-2"
              >
                {entity.name_common}
              </Link>
              <span style={{ color: 'var(--text-muted)' }}>
                {' '}— {entity.status_label}
              </span>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-10 text-sm" style={{ color: 'var(--text-muted)' }}>
        {entities.length} entities in the registry.
      </p>
    </>
  )
}
