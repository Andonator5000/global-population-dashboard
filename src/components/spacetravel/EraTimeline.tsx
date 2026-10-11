import { useId, useState } from 'react'

import { CollapsibleSources } from '../CollapsibleSources'
import { ImageCredit, SourceList } from './CutawayPlate'
import {
  travelImageUrl,
  type TravelCraft,
  type TravelEra,
  type TravelEvent,
  type TravelPerson,
} from '../../lib/spacetravel'

/**
 * The Space Travel timeline (round 14), following the /history pattern
 * settled in DATA_DECISIONS section 38 and 42.4: full-width MEASURED era
 * banners, each tinted by its own oklch hue as a light-dark() pair so text
 * contrast never depends on the hue, with the events of that era beneath.
 *
 * Unlike /history this axis is not a pixel scale: these eras are threads
 * that overlap on purpose (robotic exploration runs through the station era
 * and into the present), so a shared year axis would lie. The banner states
 * each thread's span instead, and the events inside it run in date order.
 */

export function EraTimeline({
  eras,
  events,
  craft,
  people,
  onCraft,
  onPerson,
}: {
  eras: TravelEra[]
  events: TravelEvent[]
  craft: Map<string, TravelCraft>
  people: Map<string, TravelPerson>
  onCraft: (id: string) => void
  onPerson: (id: string) => void
}) {
  return (
    <div className="st-timeline">
      {eras.map((era) => (
        <section key={era.id} id={`era-${era.id}`} className="st-era" aria-labelledby={`era-h-${era.id}`}>
          <div
            className="st-era-banner"
            style={{
              borderColor: `light-dark(oklch(58% 0.085 ${era.hue}), oklch(60% 0.08 ${era.hue}))`,
              background: `light-dark(oklch(94.5% 0.032 ${era.hue}), oklch(25% 0.028 ${era.hue}))`,
            }}
          >
            <div className="st-era-head">
              <h2 id={`era-h-${era.id}`} className="font-display">
                {era.label}
              </h2>
              <span className="st-era-dates">{era.dateLabel}</span>
            </div>
            <p className="st-era-summary">{era.summary}</p>
          </div>
          <EraEvents
            era={era}
            events={events.filter((event) => event.era === era.id)}
            craft={craft}
            people={people}
            onCraft={onCraft}
            onPerson={onPerson}
          />
        </section>
      ))}
    </div>
  )
}

/** The first few events of an era, with the rest one tap away. 110 cards
    at once is a hundred thousand pixels of phone scrolling; the sticky era
    navigation is the index, and each era opens from its own banner. */
const FIRST_SHOWN = 4

function EraEvents({
  era,
  events,
  craft,
  people,
  onCraft,
  onPerson,
}: {
  era: TravelEra
  events: TravelEvent[]
  craft: Map<string, TravelCraft>
  people: Map<string, TravelPerson>
  onCraft: (id: string) => void
  onPerson: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const shown = open ? events : events.slice(0, FIRST_SHOWN)
  const hidden = events.length - shown.length
  return (
    <>
      <ol className="st-events">
        {shown.map((event) => (
          <EventCard
            key={event.id}
            event={event}
            craft={craft}
            people={people}
            onCraft={onCraft}
            onPerson={onPerson}
          />
        ))}
      </ol>
      {(hidden > 0 || open) && (
        <button
          type="button"
          className="st-more"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open
            ? `Show fewer from ${era.label}`
            : `Show the other ${hidden} event${hidden === 1 ? '' : 's'} in ${era.label}`}
        </button>
      )}
    </>
  )
}

function EventCard({
  event,
  craft,
  people,
  onCraft,
  onPerson,
}: {
  event: TravelEvent
  craft: Map<string, TravelCraft>
  people: Map<string, TravelPerson>
  onCraft: (id: string) => void
  onPerson: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return (
    <li className="st-event" id={`event-${event.id}`}>
      <div className="st-event-media">
        {event.image ? (
          <>
            <img
              src={travelImageUrl(event.image)}
              alt={event.image.title}
              width={event.image.width}
              height={event.image.height}
              loading="lazy"
              decoding="async"
            />
            <ImageCredit image={event.image} />
          </>
        ) : (
          <p className="st-absent">{event.imageNote ?? 'No image available.'}</p>
        )}
      </div>
      <div className="st-event-body">
        <p className="st-event-date">{event.dateDisplay}</p>
        <h3 className="st-event-title">{event.title}</h3>
        <p className="st-event-text">{event.text}</p>
        {event.vintage && <p className="st-vintage">Vintage: {event.vintage}</p>}
        {(event.craft.length > 0 || event.people.length > 0) && (
          <p className="st-chips">
            {event.craft.map((id) => {
              const item = craft.get(id)
              if (!item) return null
              return (
                <button key={id} type="button" className="st-chip" onClick={() => onCraft(id)}>
                  {item.name}
                </button>
              )
            })}
            {event.people.map((id) => {
              const person = people.get(id)
              if (!person) return null
              return (
                <button
                  key={id}
                  type="button"
                  className="st-chip st-chip-person"
                  onClick={() => onPerson(id)}
                >
                  {person.name}
                </button>
              )
            })}
          </p>
        )}
        <button
          type="button"
          className="st-disclose"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Hide sources' : `Sources (${event.sources.length})`}
        </button>
        {open && (
          <div id={bodyId}>
            <SourceList sources={event.sources} />
            <p className="st-dim st-wiki">
              <a href={event.wikipedia} target="_blank" rel="noreferrer">
                Wikipedia article
              </a>
            </p>
          </div>
        )}
      </div>
    </li>
  )
}

/** The sticky era navigation that rides above the timeline. */
export function EraNav({
  eras,
  counts,
  active,
}: {
  eras: TravelEra[]
  counts: Record<string, number>
  active: string | null
}) {
  return (
    <nav className="st-eranav" aria-label="Eras">
      <ul>
        {eras.map((era) => (
          <li key={era.id}>
            <a
              href={`#era-${era.id}`}
              aria-current={active === era.id ? 'true' : undefined}
              className={active === era.id ? 'st-eranav-on' : undefined}
            >
              <span
                className="st-eranav-dot"
                aria-hidden="true"
                style={{ background: `light-dark(oklch(58% 0.14 ${era.hue}), oklch(68% 0.12 ${era.hue}))` }}
              />
              {era.label}
              <span className="st-dim"> {counts[era.id] ?? 0}</span>
            </a>
          </li>
        ))}
      </ul>
    </nav>
  )
}

export { CollapsibleSources }
