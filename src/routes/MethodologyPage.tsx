/**
 * /methodology (round-2 §36.4): the single home for the site's method
 * explanations. Pages show a compact source label and an ⓘ linking to an
 * anchor here; the honesty that used to live as paragraphs on every page
 * lives here once. The governing editorial rulings remain in
 * DATA_DECISIONS.md, linked below.
 */

const DECISIONS_URL =
  'https://github.com/Andonator5000/global-population-dashboard/blob/main/DATA_DECISIONS.md'

function Section({
  id,
  title,
  children,
}: {
  id: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section id={id} className="mt-8 scroll-mt-6">
      <h2 className="text-lg">{title}</h2>
      <div
        className="mt-2 max-w-3xl space-y-3 text-sm"
        style={{ color: 'var(--text)' }}
      >
        {children}
      </div>
    </section>
  )
}

export function MethodologyPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Methodology</h1>
        <p
          className="mt-2 max-w-3xl text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          Every figure on this site carries a source and a vintage; this page
          explains, once, how the derived and animated figures are computed.
          The full editorial record — every sourcing decision and its
          reasoning — is in{' '}
          <a
            className="underline underline-offset-2"
            href={DECISIONS_URL}
            target="_blank"
            rel="noreferrer"
          >
            DATA_DECISIONS.md
          </a>
          .
        </p>
      </header>

      <Section id="live-population" title="The live population counter">
        <p>
          No source publishes live population. The ticking figure is a
          modelled estimate: it is interpolated between two adjacent annual
          figures from UN World Population Prospects (each dated 1 July) and
          advanced continuously at the rate those two imply. Because UN WPP
          carries estimates only through its latest estimate year, a counter
          running in a later year is interpolating between{' '}
          <strong>projections, not measurements</strong> — the medium
          variant, which is also what the label beside the figure says.
        </p>
        <p>
          Why not build the tick from births, deaths and migration? UN WPP
          publishes those as calendar-year totals, while population is a
          1&nbsp;July snapshot; the two imply slightly different per-second
          rates. The counter follows the annual population figures, so it
          stays consistent with the published series rather than drifting
          away from it. The same discipline applies to every ticking figure
          on country pages.
        </p>
      </Section>

      <Section id="time-scrubber" title="Estimates vs. projection on the time axis">
        <p>
          Year-by-year population runs from 1950 to 2100. Years up to the
          source's latest estimate year are UN WPP estimates; every later
          year is the medium-variant projection. Wherever a time axis spans
          the boundary, it is marked on the control itself.
        </p>
      </Section>

      <Section id="projections" title="Map projections">
        <p>
          The flat map views use equal-area projections (Equal Earth by
          default), so land areas are shown in true relative size — a
          verification gate holds the Africa-to-Greenland ratio to reality.
          The globe view is an orthographic perspective: shapes foreshorten
          toward the horizon exactly as on a physical globe, which is a
          property of perspective, not a distortion of the data. Area
          computations behind the figures are done in an equal-area
          coordinate system regardless of the view.
        </p>
      </Section>

      <Section id="map-colours" title="What the map colours mean">
        <p>
          In the political view, each country's fill hue is derived from its
          flag's dominant colour, and its lightness encodes a four-tier
          population ranking — darker is more populous. Neighbouring
          countries are guaranteed perceptibly distinct fills by a gated
          palette build. The satellite and terrain views are NASA Blue Marble
          and Natural Earth relief imagery, projected per pixel on the GPU
          (WebGL) so the sphere has no seams, and carry no data encoding.
        </p>
      </Section>

      <Section id="live-economy" title="Live economic figures">
        <p>
          Public-debt and GDP tickers on country pages are modelled the same
          way as the population counter: interpolated between IMF World
          Economic Outlook annual figures (which include projection years)
          and advanced continuously. The US-dollar debt figure is derived
          from the same source's nominal GDP. None of these are measured
          live numbers — no such numbers exist.
        </p>
      </Section>

      <Section id="freshness" title="Three dates, never conflated">
        <p>
          Every source in the Sources panel shows three separate dates: the
          year the observation <em>describes</em> (its vintage), when the
          publisher released it, and when this site's build retrieved it.
          Conflating them is the usual way a dashboard implies its numbers
          are fresher than they are, so they are never merged here.
        </p>
      </Section>
    </div>
  )
}
