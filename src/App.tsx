import { Link, NavLink, Route, Routes } from 'react-router'

import { SECTIONS } from './config'
import { FreshnessPanel } from './components/FreshnessPanel'
import { ContinentPage } from './routes/ContinentPage'
import { CountryPage } from './routes/CountryPage'
import { HistoryPage } from './routes/HistoryPage'
import { HomePage } from './routes/HomePage'
import { NotFoundPage } from './routes/NotFoundPage'

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

      <header
        className="border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        {/* Left-aligned deliberately (no mx-auto): the site title should sit
            at the left edge of the viewport at 100% zoom. */}
        <nav
          className="flex flex-wrap items-center gap-x-5 gap-y-2 px-6 py-3"
          aria-label="Primary"
        >
          {/* Masthead (2026-09-05, maintainer request): the site is named
              Encyclopedia Andranika. Serif via .font-display -- the masthead
              is a title, not data -- while the section buttons stay sans. */}
          <Link
            to="/"
            className="font-display text-xl leading-none tracking-tight"
            style={{ color: 'var(--text)' }}
          >
            Encyclopedia Andranika
          </Link>
          {/* Section buttons render from the SECTIONS registry (2026-09-05):
              each section owns a hue (2026-08-30 ruling — data atlas in the
              brand green, history in a clay red opposite it on the wheel),
              and new sections join by registering in src/config.ts. Active
              section is marked with a ring as well as aria-current. */}
          {SECTIONS.map((section) => (
            <NavLink
              key={section.path}
              to={section.path}
              {...(section.end ? { end: true } : {})}
              className="section-link rounded-md px-3 py-1.5 font-sans text-sm font-medium tracking-tight"
              style={({ isActive }) => ({
                background: section.bg,
                color: section.text,
                boxShadow: isActive
                  ? `0 0 0 2px var(--surface), 0 0 0 4px ${section.bg}`
                  : 'none',
              })}
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
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>

      <FreshnessPanel />
    </div>
  )
}
