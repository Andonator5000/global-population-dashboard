import { useEffect, useRef, useState } from 'react'

import { StatTile, Unavailable } from '../components/viz/primitives'
import {
  useAirports,
  useCapitals,
  useClimate,
  useCuisine,
  useCurrencyImages,
  useDeathPenalty,
  useDebt,
  useEducationExtras,
  useFloraFauna,
  useInventions,
  usePressFreedom,
  useSubdivisions,
  useUnodcPrisons,
} from '../lib/data'
import {
  FX_ATTRIBUTION,
  describeWeatherCode,
  fractionalYearNow,
  interpolateAnnual,
  useLiveRates,
  useLiveWeather,
  weatherVisual,
} from '../lib/live'
import type { CommonsImage, Entity, FloraFaunaSymbol } from '../types'

/**
 * Country-page tiles and section bodies added in the 2026-08-23 batch.
 *
 * Split out of CountryPage.tsx purely for file size; the rendering doctrine
 * is unchanged -- every figure carries its source and vintage, and absence
 * renders as an explicit Unavailable, never a blank.
 */

const number = new Intl.NumberFormat('en')
const usdCompact = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
})

function MutedNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
      {children}
    </p>
  )
}

// ---------------------------------------------------------------- Economy --

export function LiveExchangeRateTile({
  currencies,
}: {
  currencies: Entity['currencies']
}) {
  const ratesState = useLiveRates()
  const codes = currencies.map((c) => c.code).filter(Boolean)

  if (codes.length === 0) {
    return (
      <Unavailable
        what="Live exchange rate"
        source="Exchange Rate API"
        reason="No ISO 4217 currency is recorded for this entity."
      />
    )
  }
  if (ratesState.status === 'loading') {
    return (
      <div>
        <StatTile label="Live exchange rate" value="loading…" />
        <MutedNote>Fetching today’s rates…</MutedNote>
      </div>
    )
  }
  if (ratesState.status === 'error') {
    return (
      <Unavailable
        what="Live exchange rate"
        source="Exchange Rate API"
        reason="The live rate service could not be reached from your browser; the official annual rate beside this tile still applies."
      />
    )
  }

  const { rates, updatedUtc } = ratesState.data
  const available = codes.filter((code) => rates[code] !== undefined)
  if (available.length === 0) {
    return (
      <Unavailable
        what="Live exchange rate"
        source="Exchange Rate API"
        reason={`The service carries no rate for ${codes.join(', ')}.`}
      />
    )
  }
  return (
    <div>
      <StatTile
        label="Live exchange rate"
        value={available
          .map(
            (code) =>
              `${new Intl.NumberFormat('en', {
                maximumSignificantDigits: 4,
              }).format(rates[code]!)} ${code} per US Dollar`,
          )
          .join(' · ')}
      />
      <MutedNote>
        Updated {updatedUtc}.{' '}
        <a
          href={FX_ATTRIBUTION.href}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          {FX_ATTRIBUTION.label}
        </a>
        . Fetched live by your browser — the one figure on this page that is
        not a committed artifact.
      </MutedNote>
    </div>
  )
}

/**
 * Public debt, moving.
 *
 * The IMF publishes ANNUAL debt (% of GDP) and nominal GDP, including
 * projections. The page interpolates both to the current instant and ticks
 * once a second -- the same modelled-estimate discipline as the population
 * counter, and labelled with the same honesty: this is a model of annual
 * figures, both ends of which may be projections.
 */
export function PublicDebtTiles({ iso3 }: { iso3: string }) {
  const debtState = useDebt()
  const [nowYear, setNowYear] = useState(() => fractionalYearNow())

  useEffect(() => {
    const timer = setInterval(() => setNowYear(fractionalYearNow()), 1000)
    return () => clearInterval(timer)
  }, [])

  if (debtState.status !== 'ready') {
    return debtState.status === 'loading' ? null : (
      <Unavailable what="Public debt" source="IMF World Economic Outlook" />
    )
  }
  const record = debtState.data.entities[iso3]
  const pct = record?.debtPctGdp
  if (!pct) {
    return (
      <Unavailable
        what="Public debt"
        source="IMF World Economic Outlook"
        reason="The WEO database publishes no general government gross debt series for this entity."
      />
    )
  }
  const pctNow = interpolateAnnual(pct.years, pct.values, nowYear)
  const gdp = record.gdpUsdBillions
  const gdpNow = gdp
    ? interpolateAnnual(gdp.years, gdp.values, nowYear)
    : null
  const debtUsd =
    pctNow !== null && gdpNow !== null ? (pctNow / 100) * gdpNow * 1e9 : null
  const isProjected = nowYear >= debtState.data.projectionsFrom

  // Presentation per maintainer spec (2026-08-24): the dollar amount is the
  // headline line, the %-of-GDP reading sits on its own line beneath it.
  return (
    <div>
      <div className="text-xl font-semibold tracking-tight">
        Public Debt:{' '}
        {debtUsd !== null ? `≈ ${usdCompact.format(debtUsd)}` : 'not available'}
      </div>
      <div className="mt-0.5 text-sm">
        Public Debt as a % of GDP:{' '}
        {pctNow !== null ? `${pctNow.toFixed(1)}%` : 'not available'}
      </div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        IMF World Economic Outlook
      </div>
      <MutedNote>
        Modelled estimate, interpolated between IMF annual figures
        {isProjected ? ' (currently in the projection range)' : ''}; the
        US-dollar figure is derived from the same source’s nominal GDP. Not a
        measured live number — no such number exists.
      </MutedNote>
    </div>
  )
}

export function CurrencyImageFigure({
  currencies,
}: {
  currencies: Entity['currencies']
}) {
  const imagesState = useCurrencyImages()
  if (imagesState.status !== 'ready') return null
  const match = currencies
    .map((c) => ({ code: c.code, record: imagesState.data.currencies[c.code] }))
    .find((c) => c.record)
  if (!match?.record) {
    // Designed fallback (2026-08-29): a note-shaped card carrying the
    // currency's name, ISO code and symbol. Never a mismatched photo.
    const primary = currencies[0]
    if (!primary) return null
    return (
      <figure className="m-0">
        <div
          className="flex aspect-[2.2/1] w-full max-w-sm flex-col justify-between rounded-md border-2 border-dashed p-4"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--surface-raised)',
          }}
          role="img"
          aria-label={`${primary.name ?? primary.code} (${primary.code}) — no compliant free banknote image`}
        >
          <div className="flex items-start justify-between">
            <span
              className="text-xs uppercase tracking-widest"
              style={{ color: 'var(--text-muted)' }}
            >
              {primary.code}
            </span>
            <span
              className="text-3xl font-semibold leading-none"
              style={{ fontVariantNumeric: 'tabular-nums' }}
              aria-hidden="true"
            >
              {primary.symbol ?? primary.code}
            </span>
          </div>
          <div>
            <div className="text-lg font-semibold leading-tight tracking-tight">
              {primary.name ?? primary.code}
            </div>
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              no compliant free banknote image
            </div>
          </div>
        </div>
        <figcaption className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Wikimedia Commons holds no free image of a single {primary.name ?? primary.code}{' '}
          banknote that meets the site&apos;s criteria (flat, head-on, obverse) — many
          modern notes are copyrighted and cannot be hosted there.
        </figcaption>
      </figure>
    )
  }
  const record = match.record
  return (
    <figure className="m-0">
      <img
        src={record.imageUrl}
        alt={`${record.name} (${match.code}) banknote, obverse`}
        loading="lazy"
        className="max-h-48 w-auto max-w-full rounded"
        style={{ boxShadow: '0 0 0 1px var(--border)' }}
      />
      <figcaption
        className="mt-1 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        {record.name} ({match.code}) — a single banknote, obverse; the
        denomination is whichever compliant free image Commons holds, not
        necessarily the smallest or current note.{' '}
        <a
          href={record.commonsPage}
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          Wikimedia Commons
        </a>
        {record.license ? ` · ${record.license}` : ''}
        {record.author ? ` · ${record.author}` : ''}
      </figcaption>
    </figure>
  )
}

// ---------------------------------------------------------------- Freedom --

export function PressFreedomTile({ iso3 }: { iso3: string }) {
  const state = usePressFreedom()
  if (state.status !== 'ready') {
    return state.status === 'loading' ? null : (
      <Unavailable what="Press freedom" source="RSF" />
    )
  }
  const entry = state.data.entities[iso3]
  if (!entry) {
    return (
      <Unavailable
        what="Press freedom index"
        source={`RSF World Press Freedom Index ${state.data.year}`}
        reason="RSF does not rank this entity."
      />
    )
  }
  return (
    <div>
      <StatTile
        label="Press freedom index"
        value={`${entry.score.toFixed(1)} / 100`}
        detail={`Rank ${entry.rank} of ${state.data.rankedCountries}`}
        source="Reporters Without Borders (RSF)"
        vintage={state.data.year}
      />
      <MutedNote>Higher scores mean more press freedom.</MutedNote>
    </div>
  )
}

// ------------------------------------------------- Crime and Incarceration --

export function CrimeExtraTiles({ iso3 }: { iso3: string }) {
  const unodcState = useUnodcPrisons()
  const penaltyState = useDeathPenalty()

  const unodc =
    unodcState.status === 'ready' ? unodcState.data.entities[iso3] : undefined
  const penalty =
    penaltyState.status === 'ready'
      ? penaltyState.data.entities[iso3]
      : undefined

  return (
    <>
      {unodcState.status === 'ready' &&
        (unodc?.prisoners ? (
          <StatTile
            label="Persons held in prison"
            value={number.format(unodc.prisoners.value)}
            source="UNODC"
            vintage={unodc.prisoners.year}
          />
        ) : (
          <Unavailable
            what="Persons held in prison"
            source="UNODC"
            reason="This country has not reported prisoner totals to the UN Crime Trends Survey."
          />
        ))}
      {unodcState.status === 'ready' &&
        (unodc?.facilities ? (
          <StatTile
            label="Penal facilities"
            value={number.format(unodc.facilities.value)}
            detail="prisons and other penal institutions"
            source="UNODC"
            vintage={unodc.facilities.year}
          />
        ) : (
          <Unavailable
            what="Number of prisons"
            source="UNODC"
            reason="Fewer than half of countries report facility counts; this one does not."
          />
        ))}
      {penaltyState.status === 'ready' &&
        (penalty ? (
          <div>
            <StatTile
              label="Death penalty"
              value={penalty.statusLabel}
              detail={[
                penalty.lastExecutionYear
                  ? `Last execution: ${penalty.lastExecutionYear}`
                  : null,
                penalty.abolishedYear
                  ? `Abolished: ${penalty.abolishedYear}`
                  : null,
                penalty.recentExecutions &&
                penaltyState.data.executionsYear
                  ? `Executions in ${penaltyState.data.executionsYear}: ${penalty.recentExecutions}`
                  : null,
              ]
                .filter(Boolean)
                .join(' · ')}
              source="Wikipedia (Amnesty International figures), CC BY-SA 4.0"
            />
            {penalty.recentExecutions && (
              <MutedNote>
                Execution figures are Amnesty International floor estimates
                and are shown verbatim — “1,000s” is a floor, not a count.
              </MutedNote>
            )}
          </div>
        ) : (
          <Unavailable
            what="Death penalty status"
            source="Wikipedia (Capital punishment by country)"
          />
        ))}
    </>
  )
}

// ---------------------------------------------------------------- Education --

export function EducationExtraTiles({ iso3 }: { iso3: string }) {
  const state = useEducationExtras()
  if (state.status !== 'ready') {
    return state.status === 'loading' ? null : (
      <Unavailable
        what="Universities"
        source="Hipolabs / CWUR"
      />
    )
  }
  const entry = state.data.entities[iso3]
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {entry?.universities !== undefined ? (
          <div>
            <StatTile
              label="Colleges and universities"
              value={number.format(entry.universities)}
              source="Hipolabs university-domains list"
            />
            <MutedNote>
              Counts institutions with a registered web domain, so this is a
              floor, not a census.
            </MutedNote>
          </div>
        ) : (
          <Unavailable
            what="University count"
            source="Hipolabs university-domains list"
          />
        )}
        {/* Public library counts were removed 2026-08-29: the only keyless
            source (a Wikidata item count) measured cataloguing, not
            libraries -- Russia showed 9. No reliable source, no figure. */}
      </div>

      <div>
        <h3 className="text-sm font-medium">
          Top universities (CWUR {state.data.cwurYear})
        </h3>
        {entry?.topUniversities?.length ? (
          <>
            <ol className="mt-1 grid list-decimal gap-x-6 gap-y-1 pl-6 text-sm sm:grid-cols-2">
              {entry.topUniversities.map((u) => (
                <li key={u.name}>
                  {u.name}{' '}
                  <span
                    className="text-xs"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    (world rank {number.format(u.worldRank)})
                  </span>
                </li>
              ))}
            </ol>
            <MutedNote>
              National top {entry.topUniversities.length} by the Center for
              World University Rankings (CWUR), which ranks ~2,000
              institutions worldwide — a country with fewer ranked
              institutions lists what is ranked.
            </MutedNote>
          </>
        ) : (
          <div className="mt-1">
            <Unavailable
              what="Top universities"
              source={`CWUR World University Rankings ${state.data.cwurYear}`}
              reason="No institution from this country appears in the ~2,000 ranked worldwide."
            />
          </div>
        )}
      </div>
    </div>
  )
}

// --------------------------------------------------------- States/Provinces --

export function SubdivisionsBody({ iso3 }: { iso3: string }) {
  const state = useSubdivisions(iso3)
  if (state.status === 'loading') return null
  const data = state.status === 'ready' ? state.data : null
  if (!data || data.divisions.length === 0) {
    return (
      <Unavailable
        what="First-level subdivisions"
        source="Wikidata"
        reason="Wikidata records no first-level administrative divisions for this entity."
      />
    )
  }
  return (
    <div>
      {data.divisionType && (
        <p className="text-sm">
          Locally known as:{' '}
          <strong style={{ fontWeight: 600 }}>
            {data.divisionType.charAt(0).toUpperCase() +
              data.divisionType.slice(1)}
          </strong>
        </p>
      )}
      <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
        {data.divisions.length} first-level divisions as recorded in Wikidata.
        Each population is the latest Wikidata figure and its reference year
        varies by division; a missing figure means Wikidata holds none.
      </p>
      <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {data.divisions.map((division) => (
          <li
            key={division.qid}
            className="flex items-baseline justify-between gap-3"
          >
            <span>{division.name}</span>
            <span
              style={{
                color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {division.population !== null
                ? number.format(division.population)
                : '—'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ------------------------------------------------------------ Batch 6 (2026-08-24) --

/**
 * An image inside a FIXED-SIZE frame with the attribution its licence
 * requires. Every visual section uses the same frame with object-cover, so
 * images of wildly different native sizes render at identical dimensions.
 *
 * Clicking the photo opens an in-page LIGHTBOX (native <dialog>, Esc and
 * backdrop-click close it) rather than leaving for the hosting site
 * (2026-08-24, maintainer request); the attribution line still links the
 * source page, because CC attribution must keep pointing home.
 *
 * `focus="top"` biases the crop upward -- centre-cropping wildlife photos
 * was decapitating the animals.
 */
function CommonsFigure({
  image,
  alt,
  caption,
  tall = false,
  focus = 'center',
  placeholder,
}: {
  image: CommonsImage | undefined
  alt: string
  caption: React.ReactNode
  tall?: boolean
  focus?: 'top' | 'center'
  /** Designed fallback for the frame when no verified image exists. */
  placeholder?: React.ReactNode
}) {
  const dialogRef = useRef<HTMLDialogElement | null>(null)
  const attribution = image && (
    <span className="block text-xs" style={{ color: 'var(--text-muted)' }}>
      <a
        href={image.commonsPage}
        target="_blank"
        rel="noreferrer"
        className="underline underline-offset-2"
      >
        {image.source ?? 'Commons'}
      </a>
      {image.license ? ` · ${image.license}` : ''}
      {image.author ? ` · ${image.author}` : ''}
    </span>
  )
  return (
    <figure
      className="m-0 flex flex-col overflow-hidden rounded-lg border"
      style={{ borderColor: 'var(--border)' }}
    >
      {image ? (
        <>
          <button
            type="button"
            className="block w-full cursor-zoom-in p-0"
            aria-label={`Enlarge image of ${alt}`}
            onClick={() => dialogRef.current?.showModal()}
          >
            <img
              src={image.imageUrl}
              alt={alt}
              loading="lazy"
              className={`${tall ? 'h-48' : 'h-36'} w-full object-cover`}
              style={{
                objectPosition: focus === 'top' ? '50% 18%' : '50% 50%',
              }}
            />
          </button>
          <dialog
            ref={dialogRef}
            className="lightbox"
            aria-label={alt}
            onClick={(event) => {
              // A click on the backdrop (the dialog element itself, not its
              // children) closes it.
              if (event.target === dialogRef.current)
                dialogRef.current?.close()
            }}
          >
            <img
              src={image.largeUrl ?? image.imageUrl}
              alt={alt}
              className="max-h-[80vh] w-auto max-w-full rounded"
            />
            <div
              className="mt-2 rounded px-3 py-2 text-sm"
              style={{ background: 'var(--surface-raised)', color: 'var(--text)' }}
            >
              {caption}
              {attribution}
              <button
                type="button"
                className="mt-1.5 rounded border px-2 py-0.5 text-xs"
                style={{ borderColor: 'var(--border)' }}
                onClick={() => dialogRef.current?.close()}
              >
                Close (Esc)
              </button>
            </div>
          </dialog>
        </>
      ) : (
        <div
          className={`${tall ? 'h-48' : 'h-36'} flex w-full items-center justify-center text-xs`}
          style={{ background: 'var(--page-tint)', color: 'var(--text-muted)' }}
        >
          {placeholder ?? 'no free image'}
        </div>
      )}
      <figcaption className="px-2.5 py-2">
        {caption}
        {attribution}
      </figcaption>
    </figure>
  )
}

// ---------------------------------------------------------------- Inventions --

export function NotableInventionsBody({ iso3 }: { iso3: string }) {
  const state = useInventions(iso3)
  if (state.status === 'loading') return null
  const data = state.status === 'ready' ? state.data : null
  if (!data || data.inventions.length === 0) {
    return (
      <Unavailable
        what="Notable inventions"
        source="Wikidata"
        reason="Wikidata records no notable inventions with this country as their origin — a coverage gap, not a judgment on the country's inventiveness."
      />
    )
  }
  return (
    <div>
      <MutedNote>{data.note}</MutedNote>
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.inventions.map((invention) => (
          <CommonsFigure
            key={invention.name}
            image={invention.image}
            alt={invention.name}
            caption={
              <>
                <span className="block text-base font-semibold">
                  {invention.name}
                </span>
                <span
                  className="block text-sm"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {invention.inventors?.length
                    ? invention.inventors.join(', ')
                    : 'inventor not recorded'}
                  {invention.year
                    ? ` · c. ${invention.year}`
                    : invention.era
                      ? ` · ${invention.era}`
                      : ''}
                </span>
              </>
            }
          />
        ))}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ Airports --

export function AirportsBody({ iso3 }: { iso3: string }) {
  const state = useAirports(iso3)
  if (state.status === 'loading') return null
  const data = state.status === 'ready' ? state.data : null
  if (!data || data.airports.length === 0) {
    return (
      <Unavailable
        what="Airports"
        source="OurAirports"
        reason="No large or scheduled-service airports are recorded for this entity."
      />
    )
  }
  return (
    <div>
      <MutedNote>{data.note}</MutedNote>
      <ol className="mt-2 grid list-decimal gap-x-8 gap-y-1.5 pl-6 text-sm sm:grid-cols-2">
        {data.airports.map((airport) => (
          <li key={`${airport.name}-${airport.iata ?? ''}`}>
            {airport.name}
            {airport.iata ? ` (${airport.iata})` : ''}
            <span className="block text-xs" style={{ color: 'var(--text-muted)' }}>
              {airport.municipality ?? '—'}
              {airport.passengers
                ? ` · ${number.format(airport.passengers)} passengers/yr`
                : ''}
            </span>
          </li>
        ))}
      </ol>
      <MutedNote>
        Source: OurAirports (public domain); passenger figures from Wikidata
        where recorded.
      </MutedNote>
    </div>
  )
}

// ------------------------------------------------------------- Flora & Fauna --

/**
 * Typographic card for a species with no verified photo (2026-08-29):
 * the common name set large, the scientific name in italics beneath.
 */
function SpeciesCard({ symbol }: { symbol: FloraFaunaSymbol }) {
  return (
    <div className="px-4 text-center">
      <div
        className="text-lg font-semibold leading-tight tracking-tight"
        style={{ color: 'var(--text)' }}
      >
        {symbol.name}
      </div>
      {symbol.scientificName && (
        <div className="mt-1 text-sm italic">{symbol.scientificName}</div>
      )}
      <div className="mt-2 text-[0.65rem] uppercase tracking-wide">
        no verified free image
      </div>
    </div>
  )
}

function symbolCaption(symbol: FloraFaunaSymbol, fallbackType: string) {
  return (
    <>
      <span className="block text-base font-semibold">{symbol.name}</span>
      <span className="block text-sm" style={{ color: 'var(--text-muted)' }}>
        {symbol.type ?? fallbackType}
        {symbol.scientificName ? ` · ${symbol.scientificName}` : ''}
      </span>
    </>
  )
}

export function FloraFaunaBody({ iso3 }: { iso3: string }) {
  const state = useFloraFauna(iso3)
  if (state.status === 'loading') return null
  const data = state.status === 'ready' ? state.data : null
  if (!data || (!data.animals?.length && !data.tree && !data.flower)) {
    return (
      <Unavailable
        what="National flora and fauna"
        source="Wikipedia national-symbol lists"
        reason="The lists record no national animal, tree, or flower for this entity."
      />
    )
  }
  return (
    <div>
      <MutedNote>{data.note}</MutedNote>
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {data.flower && (
          <CommonsFigure
            image={data.flower.image}
            alt={data.flower.name}
            tall
            caption={symbolCaption(data.flower, 'national flower')}
            placeholder={<SpeciesCard symbol={data.flower} />}
          />
        )}
        {data.tree && (
          <CommonsFigure
            image={data.tree.image}
            alt={data.tree.name}
            tall
            caption={symbolCaption(data.tree, 'national tree')}
            placeholder={<SpeciesCard symbol={data.tree} />}
          />
        )}
        {data.animals?.map((animal) => (
          <CommonsFigure
            key={`${animal.type}-${animal.name}`}
            image={animal.image}
            alt={animal.name}
            tall
            focus="top"
            caption={symbolCaption(animal, 'national animal')}
            placeholder={<SpeciesCard symbol={animal} />}
          />
        ))}
      </div>
      {data.emblems && data.emblems.length > 0 && (
        <div className="mt-5">
          <h3 className="text-sm font-medium">Heraldic and mythical emblems</h3>
          <MutedNote>
            National symbols that are legendary or heraldic figures rather
            than living species. Listed apart from the flora and fauna above
            on purpose.
          </MutedNote>
          <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.emblems.map((emblem) => (
              <CommonsFigure
                key={emblem.name}
                image={emblem.image}
                alt={emblem.name}
                caption={symbolCaption(
                  { ...emblem, type: emblem.type ?? emblem.kind },
                  emblem.kind,
                )}
                placeholder={<SpeciesCard symbol={emblem} />}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------- National Cuisine --

export function CuisineBody({ iso3 }: { iso3: string }) {
  const state = useCuisine(iso3)
  if (state.status === 'loading') return null
  const data = state.status === 'ready' ? state.data : null
  if (!data || data.dishes.length === 0) {
    return (
      <Unavailable
        what="National cuisine"
        source="Wikidata"
        reason="Wikidata records no dishes with this country as their origin — a coverage gap, not a verdict on the cooking."
      />
    )
  }
  return (
    <div>
      <MutedNote>{data.note}</MutedNote>
      <div className="mt-2 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {data.dishes.map((dish) => (
          <CommonsFigure
            key={dish.name}
            image={dish.image}
            alt={dish.name}
            caption={
              <>
                <span className="block text-base font-semibold">
                  {dish.name}
                </span>
                {dish.description && (
                  <span
                    className="block text-sm"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {dish.description}
                  </span>
                )}
              </>
            }
          />
        ))}
      </div>
    </div>
  )
}

// -------------------------------------------------------- Weather & Climate --

export function WeatherClimateBody({
  iso3,
  precipitation,
}: {
  iso3: string
  precipitation: React.ReactNode
}) {
  const capitalsState = useCapitals()
  const climateState = useClimate()
  const capital =
    capitalsState.status === 'ready'
      ? (capitalsState.data.entities[iso3] ?? null)
      : null
  const weatherState = useLiveWeather(
    capital ? capital.lat : null,
    capital ? capital.lon : null,
  )
  const climate =
    climateState.status === 'ready'
      ? climateState.data.entities[iso3]
      : undefined

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-medium">
          Current weather{capital ? ` in ${capital.name}` : ''}
        </h3>
        {!capital && capitalsState.status === 'ready' ? (
          <div className="mt-1">
            <Unavailable
              what="Live weather"
              source="GeoNames / Open-Meteo"
              reason="No capital-city coordinates are recorded for this entity."
            />
          </div>
        ) : weatherState.status === 'ready' ? (
          <>
            {/* Weather-app-style condition card (2026-08-24, maintainer
                request): colourful, theme-invariant gradient keyed to the
                condition, white text, big reading, explicit update time. */}
            {(() => {
              const visual = weatherVisual(weatherState.data.weatherCode)
              const fahrenheit = (
                (weatherState.data.temperatureC * 9) / 5 +
                32
              ).toFixed(0)
              return (
                <div
                  className="mt-2 max-w-md rounded-xl px-5 py-4"
                  style={{
                    background: visual.gradient,
                    color: '#ffffff',
                  }}
                >
                  <div className="flex items-center gap-4">
                    <span className="text-5xl" aria-hidden="true">
                      {visual.emoji}
                    </span>
                    <div>
                      <div className="text-4xl font-semibold tracking-tight">
                        {weatherState.data.temperatureC.toFixed(1)} °C
                        <span className="ml-2 text-xl font-normal opacity-90">
                          {fahrenheit} °F
                        </span>
                      </div>
                      <div className="text-base font-medium">
                        {describeWeatherCode(weatherState.data.weatherCode)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                    <span>
                      💧 Humidity{' '}
                      {weatherState.data.relativeHumidityPct.toFixed(0)}%
                    </span>
                    <span>
                      🌬️ Wind {weatherState.data.windSpeedKmh.toFixed(0)} km/h
                    </span>
                  </div>
                  <div className="mt-2 text-xs opacity-90">
                    Updated {weatherState.data.timeIso.replace('T', ' ')}{' '}
                    (local time{capital ? ` in ${capital.name}` : ''})
                  </div>
                </div>
              )
            })()}
            <MutedNote>
              Live reading fetched by your browser from Open-Meteo (data CC
              BY 4.0) at the capital’s coordinates. Not a committed artifact.
            </MutedNote>
          </>
        ) : weatherState.status === 'error' ? (
          <div className="mt-1">
            <Unavailable
              what="Live weather"
              source="Open-Meteo"
              reason="The live weather service could not be reached from your browser."
            />
          </div>
        ) : (
          <MutedNote>Fetching live weather…</MutedNote>
        )}
      </div>

      <div>
        <h3 className="text-sm font-medium">Climate</h3>
        <div className="mt-2 grid gap-4 sm:grid-cols-3">
          {climate ? (
            <StatTile
              label="Mean surface temperature"
              value={`${climate.latestTempC.value.toFixed(1)} °C`}
              detail="country mean, annual"
              source={
                climateState.status === 'ready'
                  ? climateState.data.citation
                  : 'Copernicus ERA5'
              }
              vintage={climate.latestTempC.year}
            />
          ) : (
            <Unavailable
              what="Mean surface temperature"
              source="Copernicus ERA5, via Our World in Data"
            />
          )}
          {climate?.warming ? (
            <div>
              <StatTile
                label="Warming over ~50 years"
                value={`${climate.warming.value > 0 ? '+' : ''}${climate.warming.value.toFixed(2)} °C`}
                detail={`${climate.warming.recent} mean vs ${climate.warming.baseline} mean`}
                source="Copernicus ERA5, via Our World in Data"
              />
              <MutedNote>
                Decade means, not single years — single years are weather.
              </MutedNote>
            </div>
          ) : (
            <Unavailable
              what="50-year warming"
              source="Copernicus ERA5, via Our World in Data"
              reason="The series does not cover enough of both comparison decades for this entity."
            />
          )}
          {precipitation}
        </div>
      </div>
    </div>
  )
}
