import { useEffect, useId, useMemo, useRef, useState } from 'react'

import { CutawayPlate, ImageCredit, SourceList } from './CutawayPlate'
import { CraftOutline } from './ScaleDiagram'
import {
  CRAFT_TYPE_LABELS,
  formatFlightDate,
  formatSpec,
  orderedSpecs,
  SPEC_LABELS,
  travelImageUrl,
  type CraftType,
  type TravelCraft,
  type TravelCutaway,
  type TravelPerson,
} from '../../lib/spacetravel'

/**
 * The craft catalogue (round 14): every rocket, crewed spacecraft,
 * satellite, probe and station in the section, filterable by type, each
 * opening a detail panel with its specification table, its cutaway or
 * scale outline, and the people who designed it.
 *
 * The specification table follows the site-wide rule: a figure carries its
 * source, and a figure a source does not publish renders as "not
 * available" WITH the reason -- never as a zero and never as a blank cell.
 */

const TYPE_ORDER: CraftType[] = ['rocket', 'crewed', 'station', 'satellite', 'probe']

export function CraftCatalogue({
  craft,
  cutaways,
  people,
  selected,
  onSelect,
  onPerson,
}: {
  craft: TravelCraft[]
  cutaways: Map<string, TravelCutaway>
  people: Map<string, TravelPerson>
  selected: string | null
  onSelect: (id: string | null) => void
  onPerson: (id: string) => void
}) {
  const [type, setType] = useState<CraftType | 'all'>('all')
  const [query, setQuery] = useState('')
  const searchId = useId()
  const panelRef = useRef<HTMLDivElement | null>(null)

  const counts = useMemo(() => {
    const map = new Map<string, number>()
    for (const item of craft) map.set(item.type, (map.get(item.type) ?? 0) + 1)
    return map
  }, [craft])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return craft.filter((item) => {
      if (type !== 'all' && item.type !== type) return false
      if (!needle) return true
      return [item.name, item.country, item.organisation, item.summary]
        .join(' ')
        .toLowerCase()
        .includes(needle)
    })
  }, [craft, type, query])

  const current = selected ? craft.find((c) => c.id === selected) ?? null : null

  useEffect(() => {
    if (current && panelRef.current) {
      panelRef.current.focus({ preventScroll: true })
      panelRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    }
  }, [current])

  useEffect(() => {
    if (!current) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onSelect(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, onSelect])

  const clear = () => {
    setType('all')
    setQuery('')
  }

  return (
    <div className="st-catalogue">
      <div className="st-filters">
        <label className="st-search">
          <span className="sr-only" id={searchId}>
            Search the craft catalogue by name, country or organisation
          </span>
          <input
            type="search"
            value={query}
            aria-labelledby={searchId}
            placeholder="Search name, country or organisation…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <p className="st-dim" aria-live="polite">
          {filtered.length} of {craft.length} craft
        </p>
      </div>
      <div className="st-chipbar" role="group" aria-label="Filter by type">
        <button
          type="button"
          aria-pressed={type === 'all'}
          className={`st-filter${type === 'all' ? ' st-filter-on' : ''}`}
          onClick={() => setType('all')}
        >
          All ({craft.length})
        </button>
        {TYPE_ORDER.map((key) => (
          <button
            key={key}
            type="button"
            aria-pressed={type === key}
            className={`st-filter${type === key ? ' st-filter-on' : ''}`}
            onClick={() => setType(key)}
          >
            {CRAFT_TYPE_LABELS[key]} ({counts.get(key) ?? 0})
          </button>
        ))}
      </div>

      {current && (
        <div
          className="st-panel"
          ref={panelRef}
          tabIndex={-1}
          role="region"
          aria-label={`${current.name} detail`}
        >
          <CraftDetail
            craft={current}
            cutaway={cutaways.get(current.id) ?? null}
            people={people}
            onClose={() => onSelect(null)}
            onPerson={onPerson}
          />
        </div>
      )}

      {filtered.length === 0 ? (
        <p className="st-empty">
          No craft match{query.trim() ? ` “${query.trim()}”` : ''}
          {type !== 'all' ? ` in ${CRAFT_TYPE_LABELS[type]}` : ''}. Try another term, or{' '}
          <button type="button" className="st-link" onClick={clear}>
            clear the filters
          </button>{' '}
          to see all {craft.length}.
        </p>
      ) : (
        <ul className="st-grid">
          {filtered.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className={`st-card${selected === item.id ? ' st-card-on' : ''}`}
                aria-expanded={selected === item.id}
                onClick={() => onSelect(selected === item.id ? null : item.id)}
              >
                <span className="st-card-type">{CRAFT_TYPE_LABELS[item.type]}</span>
                <span className="st-card-name">{item.name}</span>
                <span className="st-card-meta">
                  {item.country} · {item.status}
                  {item.firstFlight ? ` · first flight ${item.firstFlight.slice(0, 4)}` : ''}
                </span>
                <span className="st-card-summary">{item.summary}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function CraftDetail({
  craft,
  cutaway,
  people,
  onClose,
  onPerson,
}: {
  craft: TravelCraft
  cutaway: TravelCutaway | null
  people: Map<string, TravelPerson>
  onClose: () => void
  onPerson: (id: string) => void
}) {
  const specs = orderedSpecs(craft.specs)
  return (
    <div>
      <div className="st-panel-head">
        <div>
          <p className="st-card-type">{CRAFT_TYPE_LABELS[craft.type]}</p>
          <h3 className="font-display st-panel-title">{craft.name}</h3>
          <p className="st-dim">
            {craft.organisation} · {craft.country}
          </p>
        </div>
        <button type="button" className="st-close" onClick={onClose}>
          Close
        </button>
      </div>
      <p className="st-panel-summary">{craft.summary}</p>

      <dl className="st-keyvals">
        <div>
          <dt>Status</dt>
          <dd>{craft.status}</dd>
        </div>
        <div>
          <dt>First flight</dt>
          <dd>{formatFlightDate(craft.firstFlight)}</dd>
        </div>
        <div>
          <dt>Last flight</dt>
          <dd>{craft.lastFlight ? formatFlightDate(craft.lastFlight) : 'still flying'}</dd>
        </div>
      </dl>

      <table className="st-specs">
        <caption className="sr-only">{craft.name} specifications, with the source of each figure</caption>
        <tbody>
          {specs.map(([key, spec]) => (
            <tr key={key}>
              <th scope="row">{SPEC_LABELS[key] ?? key}</th>
              <td>
                {spec.v === null || spec.v === undefined ? (
                  <span className="st-absent-inline">not available — {spec.why}</span>
                ) : (
                  <>
                    <span className="st-figure">{formatSpec(spec)}</span>
                    {spec.note ? <span className="st-dim"> ({spec.note})</span> : null}
                  </>
                )}
              </td>
              <td className="st-specsrc">
                {spec.v !== null && spec.v !== undefined && spec.src ? (
                  <a href={spec.url} target="_blank" rel="noreferrer">
                    {spec.src}
                  </a>
                ) : null}
                {spec.year ? <span className="st-dim"> {spec.year}</span> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <CraftOutline craft={craft} />

      {cutaway && <CutawayPlate cutaway={cutaway} />}

      {craft.people.length > 0 && (
        <div className="st-panel-people">
          <h4>Designed and built by</h4>
          <p className="st-chips">
            {craft.people.map((id) => {
              const person = people.get(id)
              if (!person) return null
              return (
                <button
                  key={id}
                  type="button"
                  className="st-chip st-chip-person"
                  onClick={() => onPerson(id)}
                >
                  {person.portrait ? (
                    <img src={travelImageUrl(person.portrait)} alt="" aria-hidden="true" />
                  ) : null}
                  {person.name}
                </button>
              )
            })}
          </p>
        </div>
      )}

      {craft.drawing && (
        <p className="st-dim st-drawing">
          Outline drawn from the published dimensions above; proportions checked against{' '}
          <a href={craft.drawing.url} target="_blank" rel="noreferrer">
            {craft.drawing.title}
          </a>
          .
        </p>
      )}

      <h4 className="st-subhead">Sources</h4>
      <SourceList sources={craft.sources} />
      <p className="st-dim st-wiki">
        <a href={craft.wikipedia} target="_blank" rel="noreferrer">
          Wikipedia article
        </a>
      </p>
    </div>
  )
}

export { ImageCredit }
