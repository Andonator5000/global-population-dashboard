import { Link, Navigate, NavLink, Route, Routes } from 'react-router'

import { SECTIONS } from './config'
import { FreshnessPanel } from './components/FreshnessPanel'
import { ContinentPage } from './routes/ContinentPage'
import { EvolutionPage } from './routes/EvolutionPage'
import { CountryPage } from './routes/CountryPage'
import { HistoryPage } from './routes/HistoryPage'
import { HomePage } from './routes/HomePage'
import { NotFoundPage } from './routes/NotFoundPage'
import { SolarSystemPage } from './routes/SolarSystemPage'
import { SpacePage } from './routes/SpacePage'
import { TaxonomyPage } from './routes/TaxonomyPage'

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

      {/* Masthead (round-2 design pass, §34): a centred publication
          nameplate — serif title, small-caps tagline, double hairline —
          replacing the earlier left-edge title + coloured pill buttons.
          The primary nav is an editorial link row whose active state is a
          2px underline in the section's own hue plus a text-colour step,
          so hue is never the only signal. */}
      <header
        className="border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <div className="mx-auto max-w-7xl px-4 pt-5 text-center">
          <Link to="/" className="masthead-title font-display">
            Encyclopedia Andranika
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
          <Route path="/space/solar-system" element={<SolarSystemPage />} />
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
    </div>
  )
}
