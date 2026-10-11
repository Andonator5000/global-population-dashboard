import { useEffect, useMemo, useRef, useState } from 'react'

import { SourceList } from './CutawayPlate'
import { ImageCredit } from './CutawayPlate'
import {
  travelImageUrl,
  type TravelCraft,
  type TravelPerson,
} from '../../lib/spacetravel'

/**
 * The designers and builders strand (round 14).
 *
 * One card per person, linked both ways with the craft they designed. The
 * biographies are honest about their subjects: von Braun's SS membership
 * and the V-2's forced labour, Arthur Rudolph's role at Mittelwerk and his
 * 1984 departure, Qian Xuesen's deportation, the women whose work was
 * uncredited at the time. Where no free-licensed portrait of a person
 * exists anywhere, the card says so rather than borrowing someone else's
 * face or leaving a hole.
 */

export function PeopleStrand({
  people,
  craft,
  selected,
  onSelect,
  onCraft,
}: {
  people: TravelPerson[]
  craft: Map<string, TravelCraft>
  selected: string | null
  onSelect: (id: string | null) => void
  onCraft: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const panelRef = useRef<HTMLDivElement | null>(null)

  const ordered = useMemo(
    () => [...people].sort((a, b) => a.born - b.born || a.name.localeCompare(b.name)),
    [people],
  )
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return ordered
    return ordered.filter((person) =>
      [person.name, person.role, person.nationality, person.bio, ...person.knownFor]
        .join(' ')
        .toLowerCase()
        .includes(needle),
    )
  }, [ordered, query])

  const current = selected ? people.find((p) => p.id === selected) ?? null : null

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

  return (
    <div className="st-people">
      <div className="st-filters">
        <label className="st-search">
          <span className="sr-only">Search the people by name, role or work</span>
          <input
            type="search"
            value={query}
            placeholder="Search name, role or work…"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <p className="st-dim" aria-live="polite">
          {filtered.length} of {people.length} people
        </p>
      </div>

      {current && (
        <div
          className="st-panel"
          ref={panelRef}
          tabIndex={-1}
          role="region"
          aria-label={`${current.name} biography`}
        >
          <div className="st-panel-head">
            <div>
              <h3 className="font-display st-panel-title">{current.name}</h3>
              <p className="st-dim">
                {current.lifeDisplay} · {current.nationality}
              </p>
              <p className="st-person-role">{current.role}</p>
            </div>
            <button type="button" className="st-close" onClick={() => onSelect(null)}>
              Close
            </button>
          </div>
          <div className="st-person-body">
            <div className="st-person-portrait">
              {current.portrait ? (
                <>
                  <img
                    src={travelImageUrl(current.portrait)}
                    alt={current.portrait.title}
                    width={current.portrait.width}
                    height={current.portrait.height}
                    loading="lazy"
                  />
                  <ImageCredit image={current.portrait} />
                </>
              ) : (
                <p className="st-absent">{current.portraitNote}</p>
              )}
            </div>
            <div>
              <p className="st-person-bio">{current.bio}</p>
              <h4 className="st-subhead">Known for</h4>
              <ul className="st-knownfor">
                {current.knownFor.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              {current.craft.length > 0 && (
                <>
                  <h4 className="st-subhead">Craft</h4>
                  <p className="st-chips">
                    {current.craft.map((id) => {
                      const item = craft.get(id)
                      if (!item) return null
                      return (
                        <button
                          key={id}
                          type="button"
                          className="st-chip"
                          onClick={() => onCraft(id)}
                        >
                          {item.name}
                        </button>
                      )
                    })}
                  </p>
                </>
              )}
              <h4 className="st-subhead">Sources</h4>
              <SourceList sources={current.sources} />
              <p className="st-dim st-wiki">
                <a href={current.wikipedia} target="_blank" rel="noreferrer">
                  Wikipedia article
                </a>
              </p>
            </div>
          </div>
        </div>
      )}

      <ul className="st-grid st-grid-people">
        {filtered.map((person) => (
          <li key={person.id}>
            <button
              type="button"
              className={`st-card st-card-person${selected === person.id ? ' st-card-on' : ''}`}
              aria-expanded={selected === person.id}
              onClick={() => onSelect(selected === person.id ? null : person.id)}
            >
              <span className="st-person-thumb">
                {person.portrait ? (
                  <img
                    src={travelImageUrl(person.portrait)}
                    alt=""
                    aria-hidden="true"
                    loading="lazy"
                  />
                ) : (
                  <span className="st-person-noface" aria-hidden="true">
                    —
                  </span>
                )}
              </span>
              <span className="st-card-name">{person.name}</span>
              <span className="st-card-meta">{person.lifeDisplay}</span>
              <span className="st-card-summary">{person.role}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
