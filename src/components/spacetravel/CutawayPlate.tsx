import { useId, useState } from 'react'

import {
  travelImageUrl,
  type TravelCutaway,
  type TravelImage,
  type TravelSource,
} from '../../lib/spacetravel'

/**
 * A labelled cutaway plate (round 14, DATA_DECISIONS section 74).
 *
 * The drawing is a public-domain NASA/US-government cutaway, or a free
 * Commons drawing, downloaded by the `spacetravel` stage and served from
 * /data -- never hotlinked. OUR callouts are an overlay of numbered points
 * whose positions are stored in the reference file as fractions of the
 * image, with the legend beneath. Where the source drawing already carries
 * its own labels we say so and our points explain rather than repeat;
 * where it carries its own numbering we render the legend keyed to those
 * marks instead of printing a second set of numbers over the first.
 */

export function ImageCredit({ image }: { image: TravelImage }) {
  return (
    <p className="st-credit">
      {image.title} — {image.credit} · {image.licence} ·{' '}
      <a href={image.page} target="_blank" rel="noreferrer">
        source
      </a>
    </p>
  )
}

export function SourceList({ sources }: { sources: TravelSource[] }) {
  return (
    <ul className="st-sources">
      {sources.map((source) => (
        <li key={source.url}>
          <a href={source.url} target="_blank" rel="noreferrer">
            {source.title}
          </a>
          {source.year ? <span className="st-dim"> · {source.year}</span> : null}
        </li>
      ))}
    </ul>
  )
}

export function CutawayPlate({ cutaway }: { cutaway: TravelCutaway }) {
  const [active, setActive] = useState<string | null>(null)
  const legendId = useId()
  const image = cutaway.image
  const overlaid = cutaway.overlay
    ? cutaway.callouts.filter(
        (c) => typeof c.x === 'number' && typeof c.y === 'number',
      )
    : []

  return (
    <figure className="st-cutaway">
      <div className="st-cutaway-stage">
        <img
          src={travelImageUrl(image)}
          alt={`${cutaway.title}: ${image.title}`}
          width={image.width}
          height={image.height}
          loading="lazy"
          decoding="async"
        />
        {overlaid.map((callout) => {
          const mark = String(callout.n ?? callout.key)
          const on = active === mark
          return (
            <button
              key={mark}
              type="button"
              className={`st-pin${on ? ' st-pin-on' : ''}`}
              style={{ left: `${(callout.x ?? 0) * 100}%`, top: `${(callout.y ?? 0) * 100}%` }}
              aria-describedby={legendId}
              aria-pressed={on}
              onClick={() => setActive(on ? null : mark)}
            >
              {mark}
            </button>
          )
        })}
      </div>
      <figcaption>
        <p className="st-cutaway-note">{cutaway.note}</p>
        {cutaway.callouts.length > 0 && (
          <ol className="st-legend" id={legendId}>
            {cutaway.callouts.map((callout) => {
              const mark = String(callout.n ?? callout.key)
              return (
                <li
                  key={mark}
                  className={active === mark ? 'st-legend-on' : undefined}
                  onMouseEnter={() => cutaway.overlay && setActive(mark)}
                  onMouseLeave={() => cutaway.overlay && setActive(null)}
                >
                  <span className="st-legend-mark" aria-hidden="true">
                    {mark}
                  </span>
                  <span>
                    <strong>{callout.label}.</strong> {callout.note}
                  </span>
                </li>
              )
            })}
          </ol>
        )}
        <ImageCredit image={image} />
      </figcaption>
    </figure>
  )
}
