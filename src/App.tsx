import { Link, Navigate, NavLink, Route, Routes } from 'react-router'

import { SECTIONS } from './config'
import { FreshnessPanel } from './components/FreshnessPanel'
import { ContinentPage } from './routes/ContinentPage'
import { EvolutionPage } from './routes/EvolutionPage'
import { CountryPage } from './routes/CountryPage'
import { HistoryPage } from './routes/HistoryPage'
import { HomePage } from './routes/HomePage'
import { MethodologyPage } from './routes/MethodologyPage'
import { lazy, Suspense } from 'react'

import { NotFoundPage } from './routes/NotFoundPage'
import { SpacePage } from './routes/SpacePage'
import { TaxonomyPage } from './routes/TaxonomyPage'

// Code-split (round-2 §41): three.js only loads on the pages that use it.
const SolarSystemPage = lazy(() => import('./routes/SolarSystemPage'))
const CosmicPhenomenaPage = lazy(() => import('./routes/CosmicPhenomenaPage'))
// Round 3 §47: the periodic table (three.js atom model is split again
// inside the page) and its glossary.
const PeriodicTablePage = lazy(() => import('./routes/PeriodicTablePage'))
const ChemistryGlossaryPage = lazy(() => import('./routes/ChemistryGlossaryPage'))
// Round 6 (§55): the anatomy reference is ~8k words plus diagrams; split.
const AnatomyPage = lazy(() => import('./routes/AnatomyPage'))

export function App() {
  return (
    <div className="flex min-h-full flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded focus:px-3 focus:py-2"
        style={{ background: 'var(--surface-raised)', color: 'var(--text)' }}
      >
        Skip to content
      </a>

      {/* Masthead (round-2 §34, reworked round 12). A publication front: the
          nameplate inside the magazine's border mark — a thick supernova
          rectangle — on a stark black band that spans the page in BOTH
          themes, with the uppercase nav row on the same band. Active section
          = supernova text + a 2px supernova underline; the section's own hue
          survives as the dot beside the label, so identity is kept while the
          state signal is yellow everywhere. `aria-current` is unchanged, and
          the underline means colour is never the only carrier. */}
      <header className="masthead">
        <div className="masthead-inner mx-auto max-w-7xl px-4 text-center">
          <Link to="/" className="masthead-frame">
            <span className="masthead-title font-display">
              <span className="masthead-title-line">Encyclopedia</span>
              <span className="masthead-title-line">Andranika</span>
            </span>
          </Link>
          <p className="masthead-tagline font-sans">
            A reference atlas with a source on every figure
          </p>
          <div className="masthead-rule" aria-hidden="true" />
        </div>
        <nav
          className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-x-1 px-2"
          aria-label="Primary"
        >
          {SECTIONS.map((section) => (
            <NavLink
              key={section.path}
              to={section.path}
              {...(section.end ? { end: true } : {})}
              className="nav-link font-sans"
              style={{ '--nav-accent': section.accent } as React.CSSProperties}
            >
              <span className="nav-dot" aria-hidden="true" />
              {section.label}
            </NavLink>
          ))}
        </nav>
      </header>

      <main id="main" className="flex-1">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/continent/:id" element={<ContinentPage />} />
          <Route path="/country/:iso3" element={<CountryPage />} />
          <Route path="/history" element={<HistoryPage />} />
          <Route path="/taxonomy" element={<TaxonomyPage />} />
          <Route path="/evolution" element={<EvolutionPage />} />
          <Route path="/space" element={<SpacePage />} />
          <Route
            path="/space/solar-system"
            element={
              <Suspense
                fallback={<p className="p-10 text-sm">Loading the Solar System…</p>}
              >
                <SolarSystemPage />
              </Suspense>
            }
          />
          <Route
            path="/space/phenomena"
            element={
              <Suspense
                fallback={<p className="p-10 text-sm">Loading…</p>}
              >
                <CosmicPhenomenaPage />
              </Suspense>
            }
          />
          <Route
            path="/chemistry"
            element={
              <Suspense
                fallback={<p className="p-10 text-sm">Loading the periodic table…</p>}
              >
                <PeriodicTablePage />
              </Suspense>
            }
          />
          <Route
            path="/chemistry/glossary"
            element={
              <Suspense fallback={<p className="p-10 text-sm">Loading…</p>}>
                <ChemistryGlossaryPage />
              </Suspense>
            }
          />
          <Route
            path="/anatomy"
            element={
              <Suspense fallback={<p className="p-10 text-sm">Loading the anatomy reference…</p>}>
                <AnatomyPage />
              </Suspense>
            }
          />
          <Route path="/methodology" element={<MethodologyPage />} />
          {/* Round-2 IA: Biology dissolved into two top-level pages. The
              old paths redirect so bookmarks and inbound links survive. */}
          <Route path="/biology" element={<Navigate to="/taxonomy" replace />} />
          <Route
            path="/biology/taxonomy"
            element={<Navigate to="/taxonomy" replace />}
          />
          <Route
            path="/biology/evolution"
            element={<Navigate to="/evolution" replace />}
          />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>

      <FreshnessPanel />

      {/* Colophon (round 12): the masthead's counterpart at the foot of the
          page — a stark black band under a supernova rule. It states the one
          promise the site makes and points at where the promise is kept. The
          provenance panel above it keeps its own quiet surface. */}
      <div className="site-colophon">
        <div className="mx-auto flex max-w-7xl flex-wrap items-baseline justify-between gap-x-6 gap-y-2 px-4 py-5 sm:px-6">
          <p className="colophon-name font-display">Encyclopedia Andranika</p>
          <p className="colophon-line font-sans">
            Sources on every figure ·{' '}
            <Link to="/methodology" className="colophon-link">
              Methodology
            </Link>
          </p>
        </div>
      </div>
    </div>
  )
}
