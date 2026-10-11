import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { CollapsibleSources } from '../components/CollapsibleSources'
import { Unavailable } from '../components/viz/primitives'
import { CraftCatalogue } from '../components/spacetravel/CraftCatalogue'
import { CutawayPlate } from '../components/spacetravel/CutawayPlate'
import { EraNav, EraTimeline } from '../components/spacetravel/EraTimeline'
import { PeopleStrand } from '../components/spacetravel/PeopleStrand'
import { ScaleDiagram } from '../components/spacetravel/ScaleDiagram'
import { useSpaceTravel, type TravelFile } from '../lib/spacetravel'

/**
 * /space/travel -- Space Travel (round 14, DATA_DECISIONS section 74).
 *
 * The history of leaving the Earth: the idea, the weapon it was built from,
 * the first satellites, the first people in orbit, the Moon, the stations
 * and shuttles, the robots that went everywhere else, and where the
 * business stands now. Everything on the page comes from the editorial
 * reference file through the `spacetravel` ETL stage: every figure carries
 * its source and the year it was taken from it, every image is downloaded
 * through a free-licence gate and served from this site, and the scale
 * diagrams are GENERATED from published dimensions rather than traced.
 */
function TravelBody({ file }: { file: TravelFile }) {
  const [craftId, setCraftId] = useState<string | null>(null)
  const [personId, setPersonId] = useState<string | null>(null)
  const [cutawayId, setCutawayId] = useState<string>(file.cutaways[0]?.id ?? '')
  const [activeEra, setActiveEra] = useState<string | null>(file.eras[0]?.id ?? null)
  const catalogueRef = useRef<HTMLElement | null>(null)
  const peopleRef = useRef<HTMLElement | null>(null)

  const craftById = useMemo(
    () => new Map(file.craft.map((c) => [c.id, c])),
    [file.craft],
  )
  const peopleById = useMemo(
    () => new Map(file.people.map((p) => [p.id, p])),
    [file.people],
  )
  const cutawayByCraft = useMemo(
    () => new Map(file.cutaways.map((c) => [c.craft, c])),
    [file.cutaways],
  )
  const refById = useMemo(
    () => new Map(file.scaleReferences.map((r) => [r.id, r])),
    [file.scaleReferences],
  )

  const openCraft = useCallback((id: string) => {
    setCraftId(id)
    catalogueRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])
  const openPerson = useCallback((id: string) => {
    setPersonId(id)
    peopleRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  // Which era is on screen, for the sticky navigation's current state.
  useEffect(() => {
    const sections = file.eras
      .map((era) => document.getElementById(`era-${era.id}`))
      .filter((node): node is HTMLElement => Boolean(node))
    if (sections.length === 0) return
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0]
        if (visible) setActiveEra(visible.target.id.replace('era-', ''))
      },
      { rootMargin: '-96px 0px -60% 0px', threshold: 0 },
    )
    for (const section of sections) observer.observe(section)
    return () => observer.disconnect()
  }, [file.eras])

  const cutaway = file.cutaways.find((c) => c.id === cutawayId) ?? file.cutaways[0]

  return (
    <>
      <EraNav
        eras={file.eras}
        counts={file.counts.eventsByEra}
        active={activeEra}
      />

      <section className="st-section" aria-labelledby="st-timeline-h">
        <h2 id="st-timeline-h" className="font-display st-section-title">
          The timeline
        </h2>
        <p className="st-section-intro">{file.eraNote}</p>
        <EraTimeline
          eras={file.eras}
          events={file.events}
          craft={craftById}
          people={peopleById}
          onCraft={openCraft}
          onPerson={openPerson}
        />
      </section>

      <section className="st-section" aria-labelledby="st-plates-h">
        <h2 id="st-plates-h" className="font-display st-section-title">
          Everything to scale
        </h2>
        <p className="st-section-intro">
          Four plates, each drawn at a single scale from the published
          dimensions in the catalogue below. Nothing here is traced or
          resized to look right: change a figure in the data and the outline
          changes with it. On a narrow screen the plates scroll sideways
          inside their frame rather than shrinking.
        </p>
        {file.plates.map((plate) => (
          <ScaleDiagram key={plate.id} plate={plate} craft={craftById} refs={refById} />
        ))}
      </section>

      <section className="st-section" aria-labelledby="st-cutaways-h">
        <h2 id="st-cutaways-h" className="font-display st-section-title">
          Inside the machines
        </h2>
        <p className="st-section-intro">
          {file.cutaways.length} cutaway drawings, almost all of them
          public-domain NASA or other US-government engineering art,
          downloaded and served from this site. Where a drawing has no labels
          of its own we add our own numbered points; where it is already
          labelled our points explain rather than repeat, and we say which is
          which.
        </p>
        <div className="st-chipbar" role="group" aria-label="Choose a cutaway">
          {file.cutaways.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={item.id === cutaway?.id}
              className={`st-filter${item.id === cutaway?.id ? ' st-filter-on' : ''}`}
              onClick={() => setCutawayId(item.id)}
            >
              {item.title}
            </button>
          ))}
        </div>
        {cutaway && <CutawayPlate cutaway={cutaway} />}
      </section>

      <section className="st-section" aria-labelledby="st-craft-h" ref={catalogueRef}>
        <h2 id="st-craft-h" className="font-display st-section-title">
          The craft
        </h2>
        <p className="st-section-intro">
          {file.counts.craft} vehicles and spacecraft with sourced
          specifications. A figure an agency or manufacturer does not publish
          is shown as “not available” with the reason — never as a zero.
        </p>
        <CraftCatalogue
          craft={file.craft}
          cutaways={cutawayByCraft}
          people={peopleById}
          selected={craftId}
          onSelect={setCraftId}
          onPerson={openPerson}
        />
      </section>

      <section className="st-section" aria-labelledby="st-people-h" ref={peopleRef}>
        <h2 id="st-people-h" className="font-display st-section-title">
          The designers and builders
        </h2>
        <p className="st-section-intro">
          {file.counts.people} of the people who drew, calculated, argued for
          and built these machines — including the ones whose records are not
          comfortable, which are given in full rather than left out.
        </p>
        <PeopleStrand
          people={file.people}
          craft={craftById}
          selected={personId}
          onSelect={setPersonId}
          onCraft={openCraft}
        />
      </section>

      <section className="st-section" aria-labelledby="st-method-h">
        <h2 id="st-method-h" className="font-display st-section-title">
          Method and sources
        </h2>
        <div className="st-method">
          <p>{file.sourcingPolicy}</p>
          <p>{file.imageNote}</p>
          <p>
            The scale diagrams are generated from the stage lengths and
            diameters recorded against each vehicle, not traced from
            photographs. Each craft cites the reference drawing its
            proportions were checked against, and a drawn size that is not a
            single published figure — Orion's crew module plus its European
            service module, for instance — says so on the plate rather than
            quietly combining two numbers.
          </p>
          <p className="st-dim">
            Editorial file version {file.version}. {file.counts.events} events,{' '}
            {file.counts.craft} craft, {file.counts.people} people,{' '}
            {file.counts.cutaways} cutaways, {file.counts.plates} scale plates
            and {file.counts.images} images.
          </p>
        </div>
        <CollapsibleSources
          count={file.eras.length}
          label="Era sources"
        >
          <ul className="st-sources">
            {file.eras.map((era) => (
              <li key={era.id}>
                <strong>{era.label}</strong> ({era.dateLabel}):{' '}
                {era.sources.map((source) => (
                  <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                    {source.title}
                  </a>
                ))}
              </li>
            ))}
          </ul>
        </CollapsibleSources>
      </section>
    </>
  )
}

export function SpaceTravelPage() {
  const state = useSpaceTravel()
  const file = state.status === 'ready' ? state.data : null
  return (
    <div className="st-page mx-auto max-w-6xl px-5 py-10 sm:px-6">
      <header>
        <p className="st-eyebrow font-sans">Space</p>
        <h1 className="text-2xl font-semibold tracking-tight">Space Travel</h1>
        <p className="st-lede">
          How people got off the Earth: a two-thousand-year-old story that
          became arithmetic in 1903, a weapon in 1942, a satellite in 1957 and
          a footprint in 1969 — and what is flying now. Every figure carries
          its source and vintage, every drawing is drawn from the data, and
          the parts of the record that are not creditable are here too.
        </p>
      </header>

      {state.status === 'error' && (
        <div className="mt-6">
          <Unavailable what="Space Travel" source="the editorial reference file" />
        </div>
      )}
      {state.status === 'loading' && (
        <p className="mt-6" style={{ color: 'var(--text-muted)' }}>
          Loading…
        </p>
      )}

      {file && <TravelBody file={file} />}
    </div>
  )
}

export default SpaceTravelPage
