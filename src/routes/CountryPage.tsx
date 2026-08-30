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
} from '../components/viz/primitives'
import { Icon } from '../components/Icon'
import { DATA_BASE_URL } from '../config'
import { completeBreakdown } from '../lib/breakdown'
import {
  useBiomes,
  useCountryFactbook,
  useCountryIndicators,
  useCountryOwid,
  useCountryPyramid,
  useCountrySeries,
  useEntities,
  useFlagMeta,
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
  formatShare,
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
  CountrySeries,
  FactbookField,
  FlagMetaFile,
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
          {field.items.map((item) => {
            const icon = productIcon(item)
            return (
              <li key={item} className="flex items-center gap-2">
                {/* One icon set (OpenMoji outline); a category icon for an
                    item with no exact match, a plain labelled chip for the
                    genuinely unmappable -- never a gear. */}
                {icon?.code ? (
                  <Icon code={icon.code} className="w-5 shrink-0" />
                ) : (
                  <span aria-hidden="true" className="w-5 shrink-0" />
                )}
                <span>{capitalizeFirst(itemDisplayName(item))}</span>
              </li>
            )
          })}
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
  const flagMetaState = useFlagMeta()
  const flagMeta =
    flagMetaState.status === 'ready' && iso3
      ? flagMetaState.data?.entities[iso3]
      : undefined

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
      <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:gap-8">
        {/* The flag is the HERO of the page (2026-08-29, Phase 2.2): large,
            from the committed SVG artifact. No fixed width: not every flag
            is 3:2 (Nepal is not even rectangular), so the height is pinned
            and the width follows the flag's own ratio. The ring keeps
            mostly-white flags from dissolving into the surface. */}
        {palette?.flagSvg && (
          <img
            src={`${DATA_BASE_URL}/${palette.flagSvg}`}
            alt={`Flag of ${entity?.name_common ?? iso3}`}
            className="h-36 w-auto max-w-full shrink-0 rounded-md sm:h-44"
            style={{ boxShadow: '0 0 0 1px var(--border), 0 8px 24px -12px oklch(0% 0 0 / 0.45)' }}
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

      {flagMeta && (flagMeta.adopted || flagMeta.designer || flagMeta.symbolism) && (
        <FlagFacts meta={flagMeta} name={entity?.name_common ?? iso3 ?? ''} />
      )}

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

              <UrbanRural indicators={indicators} series={series} />
              <div className="grid gap-4 sm:grid-cols-2">
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
          {factbook?.geography?.landUse ? (
            <CompositionBar
              title="Land Use"
              field={factbook.geography.landUse}
              sourceName={FB}
            />
          ) : (
            <Unavailable what="Land use breakdown" source={FB} />
          )}
          <div>
            <h3 className="text-sm font-medium">Land Borders</h3>
            {/* Full names, not ISO3 codes (2026-08-29). The code stays in
                the tooltip and the accessible name; each is a link to the
                neighbour's page. */}
            <p className="mt-1 text-sm">
              {entity?.borders.length ? (
                entity.borders
                  .map((code) => ({
                    code,
                    name:
                      entitiesState.status === 'ready'
                        ? (entitiesState.data.find((row) => row.iso3 === code)
                            ?.name_common ?? code)
                        : code,
                  }))
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((border, index) => (
                    <span key={border.code}>
                      {index > 0 && ', '}
                      <Link
                        to={`/country/${border.code}`}
                        className="underline underline-offset-2"
                        title={border.code}
                        aria-label={`${border.name} (${border.code})`}
                      >
                        {border.name}
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
                  other={biome.other}
                  overlapNote={biome.overlapNote}
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
                  label="Average precipitation per year"
                  // Multi-unit on request (2026-08-24): large readings in
                  // cm/in with m/ft alongside; arid-country readings stay
                  // in mm/in, where centimetres would round to noise.
                  format={(v) =>
                    v >= 100
                      ? `${(v / 10).toFixed(0)} cm · ${(v / 25.4).toFixed(1)} in (${(v / 1000).toFixed(2)} m · ${(v / 304.8).toFixed(2)} ft)`
                      : `${Math.round(v)} mm · ${(v / 25.4).toFixed(2)} in`
                  }
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
    value: Math.round(p.series!.latest!.value * 100) / 100,
    year: p.series!.latest!.year,
  }))
  const years = [...new Set(values.map((v) => v.year))].sort()

  // Sector shares exclude net taxes on products, so they rarely reach 100;
  // the completion rules add the explicit "Other" (2026-08-29).
  const field = completeBreakdown(
    'gdpSectors',
    values.map((v) => ({
      label: v.label,
      percent: v.value,
      isUpperBound: false,
      official: false,
      qualifier: years.length > 1 ? `${v.year}` : null,
    })),
    {
      vintageYear: Math.max(...years),
      note:
        years.length > 1
          ? `Shares come from different years (${years.join(', ')}).`
          : null,
    },
  )
  return (
    <CompositionBar
      title="GDP Composition by Sector"
      field={field}
      sourceName={WB}
      iconFor={sectorIcon}
    />
  )
}

/** Wikidata time with its precision, rendered honestly. */
function formatAdopted(adopted: NonNullable<FlagMetaFile['entities'][string]['adopted']>) {
  if (adopted.precision === 'day') {
    const [y, m, d] = adopted.value.split('-').map(Number)
    return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, d ?? 1)).toLocaleDateString('en', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })
  }
  if (adopted.precision === 'month') {
    const [y, m] = adopted.value.split('-').map(Number)
    return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, 1)).toLocaleDateString('en', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    })
  }
  if (adopted.precision === 'approximate') return `c. ${adopted.value}`
  return adopted.value
}

/**
 * Flag facts under the hero (Phase 2.2): adoption date, designer, and the
 * lead of the Wikipedia flag article, verbatim and attributed -- CC BY-SA
 * makes the link and licence line a condition of reuse, not a courtesy.
 * Every line is omitted cleanly when its field is unrecorded.
 */
function FlagFacts({
  meta,
  name,
}: {
  meta: FlagMetaFile['entities'][string]
  name: string
}) {
  return (
    <div
      className="mt-5 rounded-lg border px-4 py-3 text-sm"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-raised)' }}
    >
      <h2 className="font-sans text-sm font-medium">
        {meta.flagName ?? `Flag of ${name}`}
      </h2>
      <dl className="mt-1 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {meta.adopted && (
          <div className="flex gap-2">
            <dt style={{ color: 'var(--text-muted)' }}>Adopted</dt>
            <dd>{formatAdopted(meta.adopted)}</dd>
          </div>
        )}
        {meta.designer && (
          <div className="flex gap-2">
            <dt style={{ color: 'var(--text-muted)' }}>Designer</dt>
            <dd>{meta.designer}</dd>
          </div>
        )}
      </dl>
      {meta.symbolism && (
        <>
          <p className="mt-2">{meta.symbolism.text}</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
            Text from{' '}
            <a
              href={meta.symbolism.article}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2"
            >
              “{meta.symbolism.title}”, Wikipedia
            </a>
            , {meta.symbolism.license}, retrieved {meta.symbolism.retrieved}.
            {meta.adopted || meta.designer
              ? ' Adoption date and designer from Wikidata (CC0).'
              : ''}
          </p>
        </>
      )}
      {!meta.symbolism && (meta.adopted || meta.designer) && (
        <p className="mt-1 text-xs" style={{ color: 'var(--text-muted)' }}>
          Source: Wikidata (CC0).
        </p>
      )}
    </div>
  )
}

/**
 * Urban and rural population as one 100% breakdown, both shares pulled from
 * their own World Bank series (never 100 - urban), with absolute headcounts
 * from the UN WPP population for the matching year (2026-08-29).
 */
function UrbanRural({
  indicators,
  series,
}: {
  indicators: CountryIndicators | null
  series: CountrySeries | null
}) {
  const urban = indicatorValue(indicators, 'SP.URB.TOTL.IN.ZS')
  const rural = indicatorValue(indicators, 'SP.RUR.TOTL.ZS')
  if (!urban?.available || !urban.latest) {
    return (
      <Unavailable
        what="Urban and rural population"
        source={WB}
        reason={urban?.unavailableReason}
      />
    )
  }
  const year = urban.latest.year
  const ruralAtYear =
    rural?.available && rural.years.includes(year)
      ? rural.values[rural.years.indexOf(year)]
      : rural?.latest?.value
  const population = (() => {
    if (!series) return null
    const index = series.years.indexOf(year)
    const at = index >= 0 ? series.series.population?.[index] : null
    if (at != null) return at
    const lastEstimate = series.years.indexOf(series.estimatesThrough)
    return lastEstimate >= 0 ? (series.series.population?.[lastEstimate] ?? null) : null
  })()
  const headcount = (share: number) =>
    population != null ? formatPopulation(Math.round((population * share) / 100)) : null

  const items = [
    {
      label: 'Urban',
      percent: Math.round(urban.latest.value * 100) / 100,
      isUpperBound: false,
      official: false,
      qualifier: headcount(urban.latest.value)
        ? `about ${headcount(urban.latest.value)} people`
        : null,
    },
    ...(ruralAtYear != null
      ? [
          {
            label: 'Rural',
            percent: Math.round(ruralAtYear * 100) / 100,
            isUpperBound: false,
            official: false,
            qualifier: headcount(ruralAtYear)
              ? `about ${headcount(ruralAtYear)} people`
              : null,
          },
        ]
      : []),
  ]
  const field = completeBreakdown('urbanRural', items, {
    vintageYear: year,
    note:
      items.length === 1
        ? 'The World Bank publishes no rural share for this entity, so only the urban share is shown.'
        : population != null
          ? `Headcounts apply each share to the UN WPP population estimate for ${year}.`
          : null,
  })
  return (
    <div>
      <CompositionBar title="Urban and Rural Population" field={field} sourceName={WB} />
      {items.length === 2 && population != null && (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          {items.map((item) => (
            <StatTile
              key={item.label}
              label={`${item.label} population`}
              value={headcount(item.percent) ?? 'not available'}
              detail={`${formatShare(item.percent)}% of ${formatPopulation(population)}`}
              source={`${WB} share × ${WPP} population`}
              vintage={year}
            />
          ))}
        </div>
      )}
    </div>
  )
}
