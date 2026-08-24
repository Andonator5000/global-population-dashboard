import { useEffect, useState } from 'react'

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
    return (
      <Unavailable
        what="Currency image"
        source="Wikimedia Commons"
        reason="Commons holds no free-licensed image for this currency — many modern banknotes are copyrighted and cannot be hosted there."
      />
    )
  }
  const record = match.record
  return (
    <figure className="m-0">
      <img
        src={record.imageUrl}
        alt={`${record.name} (${match.code})`}
        loading="lazy"
        className="max-h-48 w-auto max-w-full rounded"
        style={{ boxShadow: '0 0 0 1px var(--border)' }}
      />
      <figcaption
        className="mt-1 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        {record.name} ({match.code}) — representative specimen, not
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
        what="Universities and libraries"
        source="Hipolabs / Wikidata / CWUR"
      />
    )
  }
  const entry = state.data.entities[iso3]
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-3">
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
        {entry?.publicLibraries !== undefined ? (
          <div>
            <StatTile
              label="Public libraries"
              value={number.format(entry.publicLibraries)}
              detail="recorded in Wikidata"
              source="Wikidata"
            />
            <MutedNote>
              Wikidata’s coverage varies enormously by country; treat as a
              floor. IFLA’s Library Map of the World holds official counts
              but publishes no machine-readable feed.
            </MutedNote>
          </div>
        ) : (
          <Unavailable
            what="Public library count"
            source="Wikidata"
            reason="No items typed as public libraries are recorded for this country."
          />
        )}
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
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
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
 * A Commons image inside a FIXED-SIZE frame with the attribution its
 * licence requires. Every visual section of the 2026-08-24 batch uses the
 * same frame with object-cover, so images of wildly different native sizes
 * render at identical dimensions (an explicit maintainer requirement for
 * the cuisine grid, applied uniformly).
 */
function CommonsFigure({
  image,
  alt,
  caption,
  tall = false,
}: {
  image: CommonsImage | undefined
  alt: string
  caption: React.ReactNode
  tall?: boolean
}) {
  return (
    <figure
      className="m-0 flex flex-col overflow-hidden rounded-lg border"
      style={{ borderColor: 'var(--border)' }}
    >
      {image ? (
        <a href={image.commonsPage} target="_blank" rel="noreferrer">
          <img
            src={image.imageUrl}
            alt={alt}
            loading="lazy"
            className={`${tall ? 'h-48' : 'h-36'} w-full object-cover`}
          />
        </a>
      ) : (
        <div
          className={`${tall ? 'h-48' : 'h-36'} flex w-full items-center justify-center text-xs`}
          style={{ background: 'var(--page-tint)', color: 'var(--text-muted)' }}
        >
          no free image
        </div>
      )}
      <figcaption className="px-2.5 py-2 text-xs">
        {caption}
        {image && (
          <span className="block" style={{ color: 'var(--text-muted)' }}>
            <a
              href={image.commonsPage}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              Commons
            </a>
            {image.license ? ` · ${image.license}` : ''}
            {image.author ? ` · ${image.author}` : ''}
          </span>
        )}
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
                <strong style={{ fontWeight: 600 }}>{invention.name}</strong>
                <span className="block" style={{ color: 'var(--text-muted)' }}>
                  {invention.inventors?.length
                    ? invention.inventors.join(', ')
                    : 'inventor not recorded'}
                  {invention.year ? ` · c. ${invention.year}` : ''}
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

function symbolCaption(symbol: FloraFaunaSymbol, fallbackType: string) {
  return (
    <>
      <strong style={{ fontWeight: 600 }}>{symbol.name}</strong>
      <span className="block" style={{ color: 'var(--text-muted)' }}>
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
          />
        )}
        {data.tree && (
          <CommonsFigure
            image={data.tree.image}
            alt={data.tree.name}
            tall
            caption={symbolCaption(data.tree, 'national tree')}
          />
        )}
        {data.animals?.map((animal) => (
          <CommonsFigure
            key={`${animal.type}-${animal.name}`}
            image={animal.image}
            alt={animal.name}
            tall
            caption={symbolCaption(animal, 'national animal')}
          />
        ))}
      </div>
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
            caption={<strong style={{ fontWeight: 600 }}>{dish.name}</strong>}
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
            <div className="mt-2 grid gap-4 sm:grid-cols-3">
              <StatTile
                label={describeWeatherCode(weatherState.data.weatherCode)}
                value={`${weatherState.data.temperatureC.toFixed(1)} °C`}
                detail={`${((weatherState.data.temperatureC * 9) / 5 + 32).toFixed(0)} °F`}
              />
              <StatTile
                label="Humidity"
                value={`${weatherState.data.relativeHumidityPct.toFixed(0)}%`}
              />
              <StatTile
                label="Wind"
                value={`${weatherState.data.windSpeedKmh.toFixed(0)} km/h`}
              />
            </div>
            <MutedNote>
              Live reading fetched by your browser from Open-Meteo (data CC
              BY 4.0), observation time {weatherState.data.timeIso} at the
              capital’s coordinates. Not a committed artifact.
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
