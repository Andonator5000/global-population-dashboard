import type { ContinentKey } from '../config'
import { CONTINENTS } from '../config'

interface MapLegendProps {
  mode: 'country' | 'continent'
  activeContinent: ContinentKey | null
  onActiveContinentChange: (continent: ContinentKey | null) => void
  continentCounts: Map<ContinentKey, number>
}

const SWATCH = 'inline-block h-3 w-3 shrink-0 rounded-sm align-middle'

/**
 * Legend for the map's colour encoding.
 *
 * In country mode there is no data-driven colour yet (flag-derived fills land
 * in Phase 4), so the legend explains exactly three states and says so plainly
 * rather than implying an encoding that is not there.
 *
 * In continent mode the legend doubles as the continent selector. This is the
 * emphasis pattern: seven simultaneous categorical fills cannot clear the
 * all-pairs CVD floors, so identity is carried by label and position while a
 * single accent marks the active continent.
 */
export function MapLegend({
  mode,
  activeContinent,
  onActiveContinentChange,
  continentCounts,
}: MapLegendProps) {
  if (mode === 'country') {
    return (
      <div
        className="rounded-lg border px-4 py-3 text-xs"
        style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
      >
        <h3 className="mb-2 font-medium" style={{ color: 'var(--text)' }}>
          Legend
        </h3>
        <ul className="space-y-1.5">
          <li>
            <span
              className={SWATCH}
              style={{
                background: 'var(--map-land)',
                outline: '1px solid var(--border)',
              }}
            />{' '}
            Population data available
          </li>
          <li>
            <span
              className={SWATCH}
              style={{
                background: 'var(--map-no-data)',
                outline: '1px solid var(--border)',
              }}
            />{' '}
            No UN WPP series — rendered as unavailable, not zero
          </li>
          <li>
            <span
              className={SWATCH}
              style={{
                background: 'var(--map-accent-fill)',
                outline: '1px solid var(--border)',
              }}
            />{' '}
            Hovered or keyboard-focused
          </li>
          <li>
            <span
              className={SWATCH}
              style={{
                backgroundImage:
                  'repeating-linear-gradient(45deg, var(--map-land) 0 2px, var(--map-land-stroke) 2px 4px)',
                outline: '1px solid var(--border)',
              }}
            />{' '}
            Contested or special status (hatched)
          </li>
          <li>
            <span
              className="inline-block h-3 w-3 shrink-0 rounded-full align-middle"
              style={{
                background: 'var(--map-land)',
                outline: '1px solid var(--border)',
              }}
            />{' '}
            Too small to draw at this scale — marker, not to scale
          </li>
        </ul>
        <p className="mt-3">
          Fill does not yet encode a value. Flag-derived country colours arrive
          in a later phase.
        </p>
      </div>
    )
  }

  return (
    <div
      className="rounded-lg border px-4 py-3 text-xs"
      style={{ borderColor: 'var(--border)' }}
    >
      <h3 className="mb-2 font-medium">Continents</h3>
      <ul className="space-y-0.5">
        {(Object.keys(CONTINENTS) as ContinentKey[]).map((key) => {
          const active = activeContinent === key
          return (
            <li key={key}>
              <button
                type="button"
                className="flex w-full items-center justify-between rounded px-1.5 py-1 text-left"
                style={{
                  background: active ? 'var(--map-accent-fill)' : 'transparent',
                  color: active ? 'var(--text)' : 'inherit',
                }}
                aria-pressed={active}
                onClick={() => onActiveContinentChange(active ? null : key)}
                onPointerEnter={() => onActiveContinentChange(key)}
              >
                <span>{CONTINENTS[key]}</span>
                <span style={{ color: 'var(--text-muted)' }}>
                  {continentCounts.get(key) ?? 0}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
      <p className="mt-3" style={{ color: 'var(--text-muted)' }}>
        Continents are identified by label and position. One accent marks the
        active continent — seven simultaneous fill colours cannot be told apart
        reliably by colour-blind readers.
      </p>
    </div>
  )
}
