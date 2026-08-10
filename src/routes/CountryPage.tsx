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
import {
  useBiomes,
  useCountryFactbook,
  useCountryIndicators,
  useCountryPyramid,
  useCountrySeries,
  useEntities,
  useMapPalette,
} from '../lib/data'
import {
  formatDecimal,
  formatExact,
  formatGrowthRate,
  formatPopulation,
} from '../lib/format'
import type { CountryIndicators, FactbookField, IndicatorSeries } from '../types'

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

function indicatorValue(
  indicators: CountryIndicators | null,
  code: string,
): IndicatorSeries | undefined {
  return indicators?.indicators[code]
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
}: {
  indicator: IndicatorSeries | undefined
  label: string
  format: (value: number) => string
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
    <StatTile
      label={label}
      value={format(indicator.latest.value)}
      source={WB}
      vintage={indicator.latest.year}
    />
  )
}

function ProseField({
  field,
  label,
  source,
}: {
  field: FactbookField | undefined
  label: string
  source: string
}) {
  if (!field?.available || !field.text) {
    return <Unavailable what={label} source={source} />
  }
  return (
    <div>
      <h3 className="text-sm font-medium">{label}</h3>
      <p className="mt-1 text-sm">{field.text}</p>
      <SourceLine
        source={source}
        vintage={field.vintageYear ?? null}
        qualifier={field.vintageQualifier}
        note={field.note}
      />
    </div>
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
  const biomeState = useBiomes()

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
  const biome =
    biomeState.status === 'ready' && iso3
      ? biomeState.data.entities[iso3]
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

  return (
    <div className="mx-auto max-w-4xl px-6 py-10">
      {palette?.flag && (
        <div className="mb-4 flex gap-1" aria-hidden="true">
          {palette.flag.accents.map((hex, index) => (
            <span
              key={`${hex}-${index}`}
              className="h-1.5 flex-1 rounded-full"
              style={{ background: hex }}
            />
          ))}
        </div>
      )}

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
        {/* ---------------------------------------------------- Population */}
        <Section id="population" title="Population" accent={accent}>
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
                <Unavailable
                  what="Age and sex structure"
                  source={`${WPP}`}
                />
              )}
            </>
          ) : (
            <Unavailable
              what="Population series"
              source={WPP}
              reason="This entity has no separately published series; its residents are counted within another country's total."
            />
          )}
        </Section>

        {/* --------------------------------------------------------- Land */}
        <Section id="land" title="Land" accent={accent}>
          <div className="grid gap-4 sm:grid-cols-3">
            <StatTile
              label="Land area"
              value={
                entity?.area_km2
                  ? `${new Intl.NumberFormat('en').format(entity.area_km2)} km²`
                  : 'not available'
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
          </div>
          <div>
            <h3 className="text-sm font-medium">Land borders</h3>
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
              <h3 className="text-sm font-medium">Biome breakdown</h3>
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

        {/* ------------------------------------------------------- People */}
        <Section id="people" title="People" accent={accent}>
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
            Countries define these categories differently, some figures are
            decades old, and some states do not collect them at all. Each figure
            below carries the year of its own census or estimate — they are
            often years apart. Nothing here is interpolated, projected, or
            combined across sources.
          </p>
          {factbook ? (
            <>
              <CompositionBar
                title="Ethnic groups"
                field={factbook.people.ethnicGroups}
                sourceName={FB}
              />
              <CompositionBar
                title="Religions"
                field={factbook.people.religions}
                sourceName={FB}
              />
              <CompositionBar
                title="Languages"
                field={factbook.people.languages}
                sourceName={FB}
              />
            </>
          ) : (
            <Unavailable
              what="Ethnic, religious and language composition"
              source={FB}
              reason="The Factbook has no entry for this entity."
            />
          )}
        </Section>

        {/* ---------------------------------------------------- Education */}
        <Section id="education" title="Education" accent={accent}>
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
              indicator={indicatorValue(indicators, 'SE.PRM.ENRR')}
              label="Primary enrolment (gross)"
              format={(v) => `${v.toFixed(1)}%`}
            />
            <IndicatorTile
              indicator={indicatorValue(indicators, 'SE.TER.ENRR')}
              label="Tertiary enrolment (gross)"
              format={(v) => `${v.toFixed(1)}%`}
            />
          </div>
        </Section>

        {/* ------------------------------------------------------ Economy */}
        <Section id="economy" title="Economy" accent={accent}>
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
            />
          </div>

          <SectorComposition indicators={indicators} />

          {factbook ? (
            <>
              <ProseField
                field={factbook.economy.industries}
                label="Major industries"
                source={FB}
              />
              <ProseField
                field={factbook.economy.agriculturalProducts}
                label="Principal agricultural products"
                source={FB}
              />
              <ProseField
                field={factbook.economy.exportCommodities}
                label="Main export commodities"
                source={FB}
              />
              <CompositionBar
                title="Export partners"
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

        {/* --------------------------------------------------- Government */}
        <Section id="government" title="Government" accent={accent}>
          {factbook ? (
            <div className="space-y-4">
              <ProseField
                field={factbook.government.governmentType}
                label="Government type"
                source={FB}
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
              />
              <ProseField
                field={factbook.government.chiefOfState}
                label="Chief of state"
                source={FB}
              />
              <ProseField
                field={factbook.government.headOfGovernment}
                label="Head of government"
                source={FB}
              />
              <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                Office-holders are as recorded in the Factbook edition retrieved
                for this build — see the data freshness panel below for the
                retrieval date. They may have changed since.
              </p>
            </div>
          ) : (
            <Unavailable what="Government information" source={FB} />
          )}
        </Section>
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
      <h3 className="text-sm font-medium">GDP composition by sector</h3>
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
