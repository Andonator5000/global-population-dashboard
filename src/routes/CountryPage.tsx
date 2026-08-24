import { Link, useParams } from 'react-router'

import { AgePyramid } from '../components/viz/AgePyramid'
import { BiomeBar } from '../components/viz/BiomeBar'
import { CompositionBar } from '../components/viz/CompositionBar'
import { PopulationTrend } from '../components/viz/PopulationTrend'
import {
  Section,
  SourceLine,
  StatTile,
  Unavailable,
  seriesColour,
} from '../components/viz/primitives'
import { DATA_BASE_URL } from '../config'
import {
  useBiomes,
  useCountryFactbook,
  useCountryIndicators,
  useCountryOwid,
  useCountryPyramid,
  useCountrySeries,
  useEntities,
  useHeritage,
  useLeaders,
  useMapPalette,
} from '../lib/data'
import {
  capitalizeFirst,
  formatDecimal,
  formatExact,
  formatGrowthRate,
  formatPopulation,
  normaliseFactbookCaps,
  titleCase,
} from '../lib/format'
import {
  itemDisplayName,
  productIcon,
  religionIcon,
  sectorIcon,
} from '../lib/icons'
import type {
  CountryIndicators,
  CountryOwid,
  FactbookField,
  IndicatorSeries,
  OwidIndicatorSeries,
} from '../types'
import {
  AirportsBody,
  CrimeExtraTiles,
  CuisineBody,
  CurrencyImageFigure,
  EducationExtraTiles,
  FloraFaunaBody,
  LiveExchangeRateTile,
  NotableInventionsBody,
  PressFreedomTile,
  PublicDebtTiles,
  SubdivisionsBody,
  WeatherClimateBody,
} from './CountryPageExtras'

const WPP = 'UN World Population Prospects'
const WB = 'World Bank World Development Indicators'
const FB = 'CIA World Factbook'

/** Compact currency, so a 30-trillion GDP does not run off the tile. */
const usd = new Intl.NumberFormat('en', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 2,
})

/**
 * Regimes of the World categories, as encoded in OWID's political-regime
 * series. Mirrors OWID_REGIME_LABELS in etl/config.py.
 */
const REGIME_LABELS: Record<number, string> = {
  0: 'Closed autocracy',
  1: 'Electoral autocracy',
  2: 'Electoral democracy',
  3: 'Liberal democracy',
}

function indicatorValue(
  indicators: CountryIndicators | null,
  code: string,
): IndicatorSeries | undefined {
  return indicators?.indicators[code]
}

function owidValue(
  owid: CountryOwid | null,
  code: string,
): OwidIndicatorSeries | undefined {
  return owid?.indicators[code]
}

/**
 * One World Bank figure with its OWN vintage.
 *
 * Each indicator carries its own observation year, and they differ widely
 * within a single country -- a 2025 GDP can sit beside a 2018 literacy rate.
 * Showing one "as of" date for the section would misrepresent most of it, so
 * the year rides with the number.
 */
function IndicatorTile({
  indicator,
  label,
  format,
  note,
}: {
  indicator: IndicatorSeries | undefined
  label: string
  format: (value: number) => string
  /**
   * Rendered as visible small text, never a tooltip alone -- "no value is
   * tooltip-only" is an accessibility criterion of this app.
   */
  note?: string
}) {
  if (!indicator || !indicator.available || !indicator.latest) {
    return (
      <Unavailable
        what={label}
        source={WB}
        reason={indicator?.unavailableReason ?? undefined}
      />
    )
  }
  return (
    <div>
      <StatTile
        label={label}
        value={format(indicator.latest.value)}
        source={WB}
        vintage={indicator.latest.year}
      />
      {note && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {note}
        </p>
      )}
    </div>
  )
}

/**
 * One Our World in Data figure. Same discipline as IndicatorTile, but the
 * source line names the underlying producer (V-Dem, Global Carbon Budget...)
 * via OWID -- OWID is the distribution channel, not the measurer.
 */
function OwidTile({
  series,
  label,
  format,
  note,
}: {
  series: OwidIndicatorSeries | undefined
  label: string
  format: (value: number) => string
  note?: string
}) {
  if (!series || !series.available || !series.latest) {
    return (
      <Unavailable
        what={label}
        source="Our World in Data"
        reason={series?.unavailableReason ?? undefined}
      />
    )
  }
  return (
    <div>
      <StatTile
        label={label}
        value={format(series.latest.value)}
        source={`${series.citation}, via Our World in Data`}
        vintage={series.latest.year}
      />
      {note && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          {note}
        </p>
      )}
    </div>
  )
}

function ProseField({
  field,
  label,
  source,
  transform,
}: {
  field: FactbookField | undefined
  label: string
  source: string
  /** Display-only text massage (e.g. Factbook ALL-CAPS surname fixing). */
  transform?: (text: string) => string
}) {
  if (!field?.available || !field.text) {
    return <Unavailable what={label} source={source} />
  }
  return (
    <div>
      <h3 className="text-sm font-medium">{label}</h3>
      <p className="mt-1 text-sm">
        {transform ? transform(field.text) : field.text}
      </p>
      <SourceLine
        source={source}
        vintage={field.vintageYear ?? null}
        qualifier={field.vintageQualifier}
        note={field.note}
      />
    </div>
  )
}

/**
 * A Factbook list field (industries, agricultural products) as a bulleted
 * list with decorative icons, replacing the comma-separated wall of text.
 * Falls back to the published prose when the ETL could not split items.
 */
function ItemList({
  field,
  label,
  source,
}: {
  field: FactbookField | undefined
  label: string
  source: string
}) {
  if (!field?.available || (!field.items?.length && !field.text)) {
    return <Unavailable what={label} source={source} />
  }
  return (
    <div>
      <h3 className="text-sm font-medium">{label}</h3>
      {/* Descriptive phrases the source mixed into its list ("highly
          diversified, world leading...") arrive separated by the ETL and
          render as prose, not as bullet items beside "petroleum". */}
      {field.summary && <p className="mt-1 text-sm">{field.summary}</p>}
      {field.items?.length ? (
        <ul className="mt-1 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {field.items.map((item) => (
            <li key={item} className="flex items-baseline gap-2">
              <span aria-hidden="true" className="w-5 shrink-0 text-center">
                {productIcon(item) ?? '•'}
              </span>
              <span>{capitalizeFirst(itemDisplayName(item))}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-sm">{field.text}</p>
      )}
      <SourceLine
        source={source}
        vintage={field.vintageYear ?? null}
        qualifier={field.vintageQualifier}
        note={field.note}
      />
    </div>
  )
}

/**
 * A leader's portrait beside the Factbook office-holder prose.
 *
 * The photo and its caption name come from Wikidata; the Factbook text
 * remains the authoritative prose. Rendered ONLY when the office has exactly
 * one holder (the ETL enforces this), and every image links its Wikimedia
 * Commons file page for author and licence attribution.
 */
function LeaderPortrait({
  record,
}: {
  record: import('../types').LeaderRecord | undefined
}) {
  if (!record?.image) return null
  return (
    <figure className="m-0 shrink-0">
      <img
        src={`${DATA_BASE_URL}/${record.image}`}
        alt={record.name ? `Portrait of ${record.name}` : 'Portrait'}
        className="h-24 w-20 rounded object-cover"
        style={{ boxShadow: '0 0 0 1px var(--border)' }}
        loading="lazy"
      />
      <figcaption
        className="mt-1 w-20 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        {record.name}
        {record.commonsPage && (
          <>
            {' · '}
            <a
              href={record.commonsPage}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              photo
            </a>
          </>
        )}
      </figcaption>
    </figure>
  )
}

/** The Factbook composition caveat, shared by two sections. */
function CompositionCaveat() {
  return (
    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
      Countries define these categories differently, some figures are decades
      old, and some states do not collect them at all. Each figure below
      carries the year of its own census or estimate — they are often years
      apart. Nothing here is interpolated, projected, or combined across
      sources.
    </p>
  )
}

export function CountryPage() {
  const { iso3: rawIso3 } = useParams<{ iso3: string }>()
  const iso3 = rawIso3?.toUpperCase()

  const entitiesState = useEntities()
  const paletteState = useMapPalette()
  const seriesState = useCountrySeries(iso3)
  const pyramidState = useCountryPyramid(iso3)
  const indicatorsState = useCountryIndicators(iso3)
  const factbookState = useCountryFactbook(iso3)
  const owidState = useCountryOwid(iso3)
  const biomeState = useBiomes()
  const heritageState = useHeritage()
  const leadersState = useLeaders()

  const entity =
    entitiesState.status === 'ready'
      ? entitiesState.data.find((row) => row.iso3 === iso3)
      : undefined

  const palette =
    paletteState.status === 'ready' && iso3
      ? paletteState.data.entities[iso3]
      : undefined

  const series = seriesState.status === 'ready' ? seriesState.data : null
  const pyramid = pyramidState.status === 'ready' ? pyramidState.data : null
  const indicators =
    indicatorsState.status === 'ready' ? indicatorsState.data : null
  const factbook = factbookState.status === 'ready' ? factbookState.data : null
  const owid = owidState.status === 'ready' ? owidState.data : null
  const biome =
    biomeState.status === 'ready' && iso3
      ? biomeState.data.entities[iso3]
      : undefined
  const heritage =
    heritageState.status === 'ready' && iso3
      ? (heritageState.data.entities[iso3] ?? { count: 0, sites: [] })
      : undefined
  const leaders =
    leadersState.status === 'ready' && iso3
      ? leadersState.data.entities[iso3]
      : undefined

  if (entitiesState.status === 'ready' && !entity) {
    return (
      <div className="mx-auto max-w-4xl px-6 py-12">
        <h1 className="text-2xl font-semibold">Unknown country</h1>
        <p className="mt-2" style={{ color: 'var(--text-muted)' }}>
          No entity with ISO 3166-1 alpha-3 code “{rawIso3}”.{' '}
          <Link to="/" className="underline underline-offset-2">
            Back to the map
          </Link>
          .
        </p>
      </div>
    )
  }

  const accent = palette?.accent?.raw ?? null
  const currentYear = series?.estimatesThrough ?? 2023
  const yearIndex = series ? series.years.indexOf(currentYear) : -1
  const at = (key: string): number | null =>
    series && yearIndex >= 0 ? (series.series[key]?.[yearIndex] ?? null) : null

  const regime = owidValue(owid, 'owid.row.regime')

  /**
   * The page is washed with a light shade of the flag's dominant hue -- the
   * same lightness/chroma band as the gated --page-tint token, so text
   * contrast holds for every hue. light-dark() follows the theme via the
   * root's color-scheme; entities without a flag colour get the neutral tint.
   */
  const pageTint =
    palette?.flagHue != null
      ? `light-dark(oklch(96.5% 0.03 ${palette.flagHue}), oklch(20% 0.02 ${palette.flagHue}))`
      : 'var(--page-tint)'

  return (
    <div className="min-h-full" style={{ background: pageTint }}>
    <div className="mx-auto max-w-4xl px-6 py-10">
      <div className="flex items-start gap-5">
        {/* The flag itself, from the committed SVG artifact. No fixed width:
            not every flag is 3:2 (Nepal is not even rectangular), so the
            height is pinned and the width follows the flag's own ratio. The
            ring keeps mostly-white flags from dissolving into the surface. */}
        {palette?.flagSvg && (
          <img
            src={`${DATA_BASE_URL}/${palette.flagSvg}`}
            alt={`Flag of ${entity?.name_common ?? iso3}`}
            className="h-14 w-auto shrink-0 rounded-sm"
            style={{ boxShadow: '0 0 0 1px var(--border)' }}
          />
        )}
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {entity?.name_common ?? rawIso3}
          </h1>
          {entity && (
            <p className="mt-1" style={{ color: 'var(--text-muted)' }}>
              {entity.name_official ?? entity.name_common} · {entity.iso3} ·{' '}
              <Link
                to={`/continent/${entity.continent}`}
                className="underline underline-offset-2"
              >
                {entity.continent_name}
              </Link>
              {entity.un_member ? ' · UN member state' : ''}
            </p>
          )}
        </div>
      </div>

      {entity?.status_label && (
        <p
          className="mt-4 rounded-lg border px-4 py-3 text-sm"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--surface-raised)',
          }}
        >
          <strong>{entity.status_label}.</strong> {entity.editorial_note}
        </p>
      )}

      <div className="mt-8 space-y-5">
        {/* ------------------------------------------------- Economic Data */}
        <Section
          id="economy"
          title="Economic Data"
          accent={accent}
          collapsible
          defaultOpen
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <IndicatorTile
              indicator={indicatorValue(indicators, 'NY.GDP.MKTP.CD')}
              label="GDP (current US$)"
              format={(v) => usd.format(v)}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'NY.GDP.PCAP.PP.CD')}
              label="GDP per capita (PPP)"
              format={(v) => usd.format(v)}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'SL.UEM.TOTL.ZS')}
              label="Unemployment"
              format={(v) => `${v.toFixed(1)}%`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'SI.POV.GINI')}
              label="Gini index"
              format={(v) => v.toFixed(1)}
              note="Measures income inequality: 0 means every household earns the same; 100 means one household earns everything. Most countries fall between 25 (very equal) and 55 (very unequal)."
            />
            {/* Presentation flipped from the other tiles on request
                (2026-08-23): "Currency" is the display line and the unit
                name(s) sit beneath it. */}
            <div>
              <div className="text-xl font-semibold tracking-tight">
                Currency
              </div>
              <div className="mt-0.5 text-sm">
                {entity?.currencies.length
                  ? entity.currencies
                      .map((c) =>
                        c.name
                          ? `${c.name} (${c.code}${c.symbol ? `, ${c.symbol}` : ''})`
                          : c.code,
                      )
                      .join(' · ')
                  : 'not available'}
              </div>
              <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
                mledoze/countries
              </div>
            </div>
            <IndicatorTile
              indicator={indicatorValue(indicators, 'PA.NUS.FCRF')}
              label="Exchange rate"
              format={(v) =>
                `${new Intl.NumberFormat('en', { maximumSignificantDigits: 4 }).format(v)} per US Dollar`
              }
              note="Official rate, annual period average — not a live market rate."
            />
            <LiveExchangeRateTile currencies={entity?.currencies ?? []} />
            {iso3 && <PublicDebtTiles iso3={iso3} />}
          </div>

          <CurrencyImageFigure currencies={entity?.currencies ?? []} />

          <SectorComposition indicators={indicators} />

          {factbook ? (
            <>
              <ItemList
                field={factbook.economy.industries}
                label="Major Industries"
                source={FB}
              />
              <ItemList
                field={factbook.economy.agriculturalProducts}
                label="Principal Agricultural Products"
                source={FB}
              />
              <ItemList
                field={factbook.economy.exportCommodities}
                label="Main Export Commodities"
                source={FB}
              />
              <CompositionBar
                title="Export Partners"
                field={factbook.economy.exportPartners}
                sourceName={FB}
              />
            </>
          ) : (
            <Unavailable
              what="Industries, agricultural products and trade partners"
              source={FB}
            />
          )}
        </Section>

        {/* --------------------------------------- Demographics and People */}
        <Section
          id="demographics"
          title="Demographics and People"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          {series ? (
            <>
              <div className="grid gap-4 sm:grid-cols-3">
                <StatTile
                  label={`Population, ${currentYear}`}
                  value={formatPopulation(at('population'))}
                  detail={formatExact(at('population'))}
                  source={`${WPP} ${series.revision}`}
                  vintage={currentYear}
                />
                <StatTile
                  label="Growth rate"
                  value={formatGrowthRate(at('growthRate'))}
                  source={`${WPP} ${series.revision}`}
                  vintage={currentYear}
                />
                <StatTile
                  label="Median age"
                  value={formatDecimal(at('medianAge'), 'years')}
                  source={`${WPP} ${series.revision}`}
                  vintage={currentYear}
                />
                <StatTile
                  label="Births per year"
                  value={formatPopulation(at('births'))}
                  detail={`${formatDecimal(at('birthRate'))} per 1,000 people`}
                  source={`${WPP} ${series.revision}`}
                  vintage={currentYear}
                />
                <StatTile
                  label="Deaths per year"
                  value={formatPopulation(at('deaths'))}
                  detail={`${formatDecimal(at('deathRate'))} per 1,000 people`}
                  source={`${WPP} ${series.revision}`}
                  vintage={currentYear}
                />
                <StatTile
                  label="Net migration per year"
                  value={formatPopulation(at('netMigration'))}
                  detail={`${formatDecimal(at('netMigrationRate'))} per 1,000 people`}
                  source={`${WPP} ${series.revision}`}
                  vintage={currentYear}
                />
                <StatTile
                  label="Density"
                  value={formatDecimal(at('density'), 'per km²')}
                  source={`${WPP} ${series.revision}`}
                  vintage={currentYear}
                />
                <StatTile
                  label="Fertility rate"
                  value={formatDecimal(at('fertilityRate'), 'births per woman')}
                  source={`${WPP} ${series.revision}`}
                  vintage={currentYear}
                />
                <StatTile
                  label="Life expectancy"
                  value={formatDecimal(at('lifeExpectancy'), 'years')}
                  source={`${WPP} ${series.revision}`}
                  vintage={currentYear}
                />
              </div>

              <PopulationTrend series={series} />

              <div className="grid gap-4 sm:grid-cols-2">
                <IndicatorTile
                  indicator={indicatorValue(indicators, 'SP.URB.TOTL.IN.ZS')}
                  label="Urban population"
                  format={(v) => `${v.toFixed(1)}%`}
                />
                <IndicatorTile
                  indicator={indicatorValue(indicators, 'EN.POP.DNST')}
                  label="Population density (World Bank)"
                  format={(v) => `${v.toFixed(1)} per km²`}
                />
              </div>

              {pyramid ? (
                <AgePyramid pyramid={pyramid} defaultYear={currentYear} />
              ) : (
                <Unavailable what="Age and sex structure" source={`${WPP}`} />
              )}
            </>
          ) : (
            <Unavailable
              what="Population series"
              source={WPP}
              reason="This entity has no separately published series; its residents are counted within another country's total."
            />
          )}

          <div>
            <h3 className="text-sm font-medium">Ethnic Composition</h3>
            <div className="mt-2 space-y-4">
              <CompositionCaveat />
              {factbook ? (
                <CompositionBar
                  title="Ethnic Groups"
                  field={factbook.people.ethnicGroups}
                  sourceName={FB}
                />
              ) : (
                <Unavailable
                  what="Ethnic composition"
                  source={FB}
                  reason="The Factbook has no entry for this entity."
                />
              )}
            </div>
          </div>
        </Section>

        {/* ----------------------------------------------- States/Provinces */}
        <Section
          id="subdivisions"
          title="States/Provinces"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          {iso3 && <SubdivisionsBody iso3={iso3} />}
        </Section>

        {/* ------------------------------------------------------ Education */}
        {/* Split out of Demographics and People 2026-08-23 (maintainer
            request) so education can grow its own datasets. */}
        <Section
          id="education"
          title="Education"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          <div>
            <div className="grid gap-4 sm:grid-cols-3">
              <IndicatorTile
                indicator={indicatorValue(indicators, 'SE.ADT.LITR.ZS')}
                label="Adult literacy, total"
                format={(v) => `${v.toFixed(1)}%`}
              />
              <IndicatorTile
                indicator={indicatorValue(indicators, 'SE.ADT.LITR.MA.ZS')}
                label="Adult literacy, male"
                format={(v) => `${v.toFixed(1)}%`}
              />
              <IndicatorTile
                indicator={indicatorValue(indicators, 'SE.ADT.LITR.FE.ZS')}
                label="Adult literacy, female"
                format={(v) => `${v.toFixed(1)}%`}
              />
              <IndicatorTile
                indicator={indicatorValue(indicators, 'SE.XPD.TOTL.GD.ZS')}
                label="Education spending"
                format={(v) => `${v.toFixed(1)}% of GDP`}
              />
              <IndicatorTile
                indicator={indicatorValue(indicators, 'SE.PRM.NENR')}
                label="Primary enrollment (net)"
                format={(v) => `${v.toFixed(1)}%`}
                note="Share of primary-age children enrolled at primary level."
              />
              <IndicatorTile
                indicator={indicatorValue(indicators, 'SE.PRM.ENRR')}
                label="Primary enrollment (gross)"
                format={(v) => `${v.toFixed(1)}%`}
                note="Can exceed 100%: total enrollment of any age, divided by the primary-age population, so repeaters and over- or under-age pupils push it past 100."
              />
              <IndicatorTile
                indicator={indicatorValue(indicators, 'SE.SEC.NENR')}
                label="Secondary enrollment (net)"
                format={(v) => `${v.toFixed(1)}%`}
              />
              <IndicatorTile
                indicator={indicatorValue(indicators, 'SE.TER.ENRR')}
                label="Tertiary enrollment (gross)"
                format={(v) => `${v.toFixed(1)}%`}
              />
            </div>
          </div>
          {iso3 && <EducationExtraTiles iso3={iso3} />}
        </Section>

        {/* ------------------------------------- Government and Stability */}
        <Section
          id="government"
          title="Government and Stability"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          {factbook ? (
            <div className="space-y-4">
              <ProseField
                field={factbook.government.governmentType}
                label="Government Type"
                source={FB}
                transform={titleCase}
              />
              <ProseField
                field={factbook.government.capital}
                label="Capital"
                source={FB}
              />
              <ProseField
                field={factbook.government.independence}
                label="Independence"
                source={FB}
              />
              <ProseField
                field={factbook.government.legislativeStructure}
                label="Legislature"
                source={FB}
                transform={capitalizeFirst}
              />
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <ProseField
                    field={factbook.government.chiefOfState}
                    label="Chief of State"
                    source={FB}
                    transform={normaliseFactbookCaps}
                  />
                </div>
                <LeaderPortrait record={leaders?.hos} />
              </div>
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <ProseField
                    field={factbook.government.headOfGovernment}
                    label="Head of Government"
                    source={FB}
                    transform={normaliseFactbookCaps}
                  />
                </div>
                <LeaderPortrait record={leaders?.hog} />
              </div>
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Office-holders are as recorded in the Factbook edition retrieved
                for this build — see the data freshness panel below for the
                retrieval date. They may have changed since.
              </p>
            </div>
          ) : (
            <Unavailable what="Government information" source={FB} />
          )}

          <div>
            <h3 className="text-sm font-medium">Governance Measures</h3>
            <div className="mt-2 grid gap-4 sm:grid-cols-2">
              <OwidTile
                series={owidValue(owid, 'owid.vdem.ruleoflaw')}
                label="Rule of law index"
                format={(v) => v.toFixed(2)}
                note="0–1; higher means more rule-based governance (V-Dem expert estimate)."
              />
              <OwidTile
                series={owidValue(owid, 'owid.vdem.corruption')}
                label="Political corruption index"
                format={(v) => v.toFixed(2)}
                note="0–1; HIGHER means MORE pervasive corruption — the scale runs the opposite way to the other indices here."
              />
              <OwidTile
                series={owidValue(owid, 'owid.hanson.statecap')}
                label="State capacity index"
                format={(v) => v.toFixed(2)}
                note="Higher scores mean more capacity to control territory, raise resources, and staff an impartial state; typical range roughly −3 to +3."
              />
            </div>
          </div>
        </Section>

        {/* ------------------------------------ Environment and Geography */}
        <Section
          id="environment"
          title="Environment and Geography"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile
              label="Land area"
              value={
                entity?.area_km2
                  ? `${new Intl.NumberFormat('en').format(entity.area_km2)} km²`
                  : 'not available'
              }
              detail={
                entity?.area_km2
                  ? `${new Intl.NumberFormat('en').format(Math.round(entity.area_km2 * 0.386102))} sq mi`
                  : undefined
              }
              source="mledoze/countries"
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'AG.LND.FRST.ZS')}
              label="Forest area"
              format={(v) => `${v.toFixed(1)}% of land`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'AG.LND.AGRI.ZS')}
              label="Agricultural land"
              format={(v) => `${v.toFixed(1)}% of land`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'EG.FEC.RNEW.ZS')}
              label="Renewable energy"
              format={(v) => `${v.toFixed(1)}% of final energy`}
            />
            <OwidTile
              series={owidValue(owid, 'owid.co2.percapita')}
              label="CO₂ emissions per capita"
              format={(v) => `${v.toFixed(1)} t/person`}
            />
          </div>
          <div>
            <h3 className="text-sm font-medium">Land Borders</h3>
            <p className="mt-1 text-sm">
              {entity?.borders.length ? (
                entity.borders.map((code, index) => (
                  <span key={code}>
                    {index > 0 && ', '}
                    <Link
                      to={`/country/${code}`}
                      className="underline underline-offset-2"
                    >
                      {code}
                    </Link>
                  </span>
                ))
              ) : (
                <span style={{ color: 'var(--text-muted)' }}>
                  No land borders.
                </span>
              )}
            </p>
          </div>
          {biome ? (
            <div>
              <h3 className="text-sm font-medium">Biome Breakdown</h3>
              <div className="mt-2">
                <BiomeBar
                  biomes={biome.biomes}
                  coveredShare={biome.coveredShare}
                  landAreaKm2={biome.landAreaKm2}
                  ecoregions={biome.topEcoregions}
                  {...(biome.areaDiffersFromPublishedPct !== undefined
                    ? {
                        areaDiffersFromPublishedPct:
                          biome.areaDiffersFromPublishedPct,
                        publishedAreaKm2: entity?.area_km2 ?? null,
                      }
                    : {})}
                />
              </div>
            </div>
          ) : (
            <Unavailable
              what="Biome breakdown"
              source="RESOLVE Ecoregions 2017"
              reason="This entity is not resolved in the ecoregion layer."
            />
          )}
        </Section>

        {/* ------------------------------------------------ Flora and Fauna */}
        <Section
          id="flora-fauna"
          title="Flora and Fauna"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          {iso3 && <FloraFaunaBody iso3={iso3} />}
        </Section>

        {/* --------------------------------------------- Weather and Climate */}
        <Section
          id="weather"
          title="Weather and Climate"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          {iso3 && (
            <WeatherClimateBody
              iso3={iso3}
              precipitation={
                <IndicatorTile
                  indicator={indicatorValue(indicators, 'AG.LND.PRCP.MM')}
                  label="Average precipitation"
                  format={(v) => `${new Intl.NumberFormat('en').format(Math.round(v))} mm/year`}
                  note="Long-run climatological average over the country's land area."
                />
              }
            />
          )}
        </Section>

        {/* -------------------------------- Technology and Infrastructure */}
        <Section
          id="technology"
          title="Technology and Infrastructure"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <IndicatorTile
              indicator={indicatorValue(indicators, 'IT.NET.USER.ZS')}
              label="Internet users"
              format={(v) => `${v.toFixed(1)}% of population`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'IT.CEL.SETS.P2')}
              label="Mobile subscriptions"
              format={(v) => `${v.toFixed(0)} per 100 people`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'EG.ELC.ACCS.ZS')}
              label="Access to electricity"
              format={(v) => `${v.toFixed(1)}% of population`}
            />
          </div>
        </Section>

        {/* --------------------------------------------------------- Airports */}
        <Section
          id="airports"
          title="Airports"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          {iso3 && <AirportsBody iso3={iso3} />}
        </Section>

        {/* ----------------------------------------------- Notable Inventions */}
        <Section
          id="inventions"
          title="Notable Inventions"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          {iso3 && <NotableInventionsBody iso3={iso3} />}
        </Section>

        {/* ------------------------------------------ Security and Defense */}
        <Section
          id="security"
          title="Security and Defense"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <IndicatorTile
              indicator={indicatorValue(indicators, 'MS.MIL.XPND.GD.ZS')}
              label="Military expenditure"
              format={(v) => `${v.toFixed(1)}% of GDP`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'MS.MIL.TOTL.P1')}
              label="Armed forces personnel"
              format={(v) => new Intl.NumberFormat('en').format(Math.round(v))}
            />
          </div>
        </Section>

        {/* -------------------------------------- Crime and Incarceration */}
        {/* New section 2026-08-23 (maintainer request); intentional
            homicides moved here from Security and Defense. */}
        <Section
          id="crime"
          title="Crime and Incarceration"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <IndicatorTile
              indicator={indicatorValue(indicators, 'VC.IHR.PSRC.P5')}
              label="Intentional homicides"
              format={(v) => `${v.toFixed(1)} per 100,000`}
            />
            <OwidTile
              series={owidValue(owid, 'owid.wpb.prisonrate')}
              label="Prison population rate"
              format={(v) => `${v.toFixed(0)} per 100,000`}
            />
            <OwidTile
              series={owidValue(owid, 'owid.wpb.occupancy')}
              label="Prison occupancy"
              format={(v) => `${v.toFixed(0)}% of official capacity`}
              note="Above 100% means the system holds more people than it was built for."
            />
            {iso3 && <CrimeExtraTiles iso3={iso3} />}
          </div>
        </Section>

        {/* ----------------------------- Healthcare and Public Health ----- */}
        <Section
          id="healthcare"
          title="Healthcare and Public Health"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          <div className="grid gap-4 sm:grid-cols-3">
            <IndicatorTile
              indicator={indicatorValue(indicators, 'SP.DYN.LE00.IN')}
              label="Life expectancy at birth"
              format={(v) => `${v.toFixed(1)} years`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'SH.XPD.CHEX.GD.ZS')}
              label="Health expenditure"
              format={(v) => `${v.toFixed(1)}% of GDP`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'SH.DYN.MORT')}
              label="Under-5 mortality"
              format={(v) => `${v.toFixed(1)} per 1,000 births`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'SH.STA.MMRT')}
              label="Maternal mortality"
              format={(v) => `${v.toFixed(0)} per 100,000 births`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'SH.MED.PHYS.ZS')}
              label="Physicians"
              format={(v) => `${v.toFixed(2)} per 1,000 people`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'SH.MED.BEDS.ZS')}
              label="Hospital beds"
              format={(v) => `${v.toFixed(1)} per 1,000 people`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'SH.IMM.MEAS')}
              label="Measles immunisation"
              format={(v) => `${v.toFixed(0)}% of children 12–23 months`}
            />
          </div>
        </Section>

        {/* ---------------------------------------- Culture and Heritage */}
        <Section
          id="culture"
          title="Culture and Heritage"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          <CompositionCaveat />
          {factbook ? (
            <>
              <CompositionBar
                title="Religions"
                field={factbook.people.religions}
                sourceName={FB}
                iconFor={religionIcon}
              />
              <CompositionBar
                title="Languages"
                field={factbook.people.languages}
                sourceName={FB}
              />
            </>
          ) : (
            <Unavailable
              what="Religious and language composition"
              source={FB}
              reason="The Factbook has no entry for this entity."
            />
          )}

          <div>
            <h3 className="text-sm font-medium">UNESCO World Heritage Sites</h3>
            {heritage && heritage.count > 0 ? (
              <>
                <ul className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                  {heritage.sites.map((site) => (
                    <li key={site.name} className="flex items-baseline gap-2">
                      <span
                        aria-hidden="true"
                        className="w-5 shrink-0 text-center"
                        title={site.category ?? undefined}
                      >
                        {site.category === 'Natural'
                          ? '🏞️'
                          : site.category === 'Mixed'
                            ? '⛰️'
                            : '🏛️'}
                      </span>
                      <span>
                        {site.url ? (
                          <a
                            href={site.url}
                            target="_blank"
                            rel="noreferrer"
                            className="underline underline-offset-2"
                          >
                            {site.name}
                          </a>
                        ) : (
                          site.name
                        )}
                        <span
                          className="text-xs"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {site.year ? ` · ${site.year}` : ''}
                          {site.transnational ? ' · shared' : ''}
                          {site.danger ? ' · ⚠ in danger' : ''}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p
                  className="mt-2 text-xs"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {heritage.count} inscribed{' '}
                  {heritage.count === 1 ? 'property' : 'properties'}. 🏛️
                  cultural · 🏞️ natural · ⛰️ mixed. Shared sites span several
                  countries and count once per member state. Source: UNESCO
                  World Heritage List; year is the year of inscription.
                </p>
              </>
            ) : heritage ? (
              <p
                className="mt-1 text-sm"
                style={{ color: 'var(--text-muted)' }}
              >
                No properties inscribed on the UNESCO World Heritage List.
              </p>
            ) : (
              <Unavailable
                what="World Heritage sites"
                source="UNESCO World Heritage List"
              />
            )}
          </div>
        </Section>

        {/* ------------------------------------------------ National Cuisine */}
        <Section
          id="cuisine"
          title="National Cuisine"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          {iso3 && <CuisineBody iso3={iso3} />}
        </Section>

        {/* -------------------------------------------------------- Freedom */}
        <Section
          id="freedom"
          title="Freedom"
          accent={accent}
          collapsible
          defaultOpen={false}
        >
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            The indices below are expert-coded assessments from the V-Dem
            (Varieties of Democracy) project, on a 0–1 scale where 1 is most
            democratic or most rights-respecting. They are informed estimates,
            not measurements, and small differences between countries are not
            meaningful.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <OwidTile
              series={owidValue(owid, 'owid.vdem.electdem')}
              label="Electoral democracy index"
              format={(v) => v.toFixed(2)}
              note="Free and fair elections, comprehensive voting rights, freedoms of association and expression."
            />
            <OwidTile
              series={owidValue(owid, 'owid.vdem.libdem')}
              label="Liberal democracy index"
              format={(v) => v.toFixed(2)}
              note="Electoral democracy plus limits on the executive, rule of law, and individual liberties."
            />
            <OwidTile
              series={owidValue(owid, 'owid.vdem.rights')}
              label="Human rights index"
              format={(v) => v.toFixed(2)}
              note="Protection from state violations of physical integrity and civil liberties."
            />
            {iso3 && <PressFreedomTile iso3={iso3} />}
            {regime?.available && regime.latest ? (
              <StatTile
                label="Political regime"
                value={
                  REGIME_LABELS[Math.round(regime.latest.value)] ??
                  `Category ${regime.latest.value}`
                }
                detail="Regimes of the World classification"
                source={`${regime.citation}, via Our World in Data`}
                vintage={regime.latest.year}
              />
            ) : (
              <Unavailable
                what="Political regime"
                source="Our World in Data"
                reason={regime?.unavailableReason ?? undefined}
              />
            )}
          </div>
        </Section>
      </div>
    </div>
    </div>
  )
}

/**
 * GDP by sector.
 *
 * A proportional bar rather than three separate tiles, because the point is
 * the split. Rendered only when all three shares are present -- a partial
 * split would imply the missing sector is zero.
 */
function SectorComposition({
  indicators,
}: {
  indicators: CountryIndicators | null
}) {
  const parts = [
    { code: 'NV.AGR.TOTL.ZS', label: 'Agriculture' },
    { code: 'NV.IND.TOTL.ZS', label: 'Industry' },
    { code: 'NV.SRV.TOTL.ZS', label: 'Services' },
  ].map((part) => ({
    ...part,
    series: indicatorValue(indicators, part.code),
  }))

  const complete = parts.every((p) => p.series?.available && p.series.latest)
  if (!complete) {
    return (
      <Unavailable
        what="GDP composition by sector"
        source={WB}
        reason="The World Bank does not publish a complete sector split for this entity."
      />
    )
  }

  const values = parts.map((p) => ({
    label: p.label,
    value: p.series!.latest!.value,
    year: p.series!.latest!.year,
  }))
  const total = values.reduce((sum, v) => sum + v.value, 0)
  const years = [...new Set(values.map((v) => v.year))].sort()

  return (
    <div>
      <h3 className="text-sm font-medium">GDP Composition by Sector</h3>
      <div className="mt-2 flex h-6 w-full overflow-hidden rounded">
        {values.map((entry, index) => (
          <div
            key={entry.label}
            style={{
              width: `${(entry.value / total) * 100}%`,
              background: seriesColour(index),
              marginRight: index < values.length - 1 ? 2 : 0,
            }}
            title={`${entry.label}: ${entry.value.toFixed(1)}% of GDP (${entry.year})`}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {values.map((entry, index) => (
          <li key={entry.label} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 rounded-sm"
              style={{ background: seriesColour(index) }}
              aria-hidden="true"
            />
            {sectorIcon(entry.label) && (
              <span aria-hidden="true">{sectorIcon(entry.label)}</span>
            )}
            {entry.label}
            <span
              style={{
                color: 'var(--text-muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {entry.value.toFixed(1)}% ({entry.year})
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>
        Source: {WB}
        {years.length > 1
          ? `. Shares come from different years (${years.join(', ')}) and total ${total.toFixed(1)}%.`
          : `, ${years[0]}. Shares total ${total.toFixed(1)}%.`}
      </p>
    </div>
  )
}
