import { NavLink, Route, Routes } from 'react-router'

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
          className="flex flex-wrap items-center gap-3 px-6 py-3"
          aria-label="Primary"
        >
          {/* Two section buttons (2026-08-30, maintainer request): the data
              atlas in the brand green, the history timeline in a clay red
              that sits opposite green on the wheel. The label "Global Data"
              replaced "Global Population Dashboard" because the atlas covers
              far more than population. Active section is marked with a ring
              as well as aria-current. */}
          <NavLink
            to="/"
            end
            className="rounded-md px-3 py-1.5 font-sans text-sm font-medium tracking-tight"
            style={({ isActive }) => ({
              background: 'var(--brand-bg)',
              color: 'var(--brand-text)',
              boxShadow: isActive ? '0 0 0 2px var(--surface), 0 0 0 4px var(--brand-bg)' : 'none',
            })}
          >
            Global Data
          </NavLink>
          <NavLink
            to="/history"
            className="rounded-md px-3 py-1.5 font-sans text-sm font-medium tracking-tight"
            style={({ isActive }) => ({
              background: 'var(--history-bg)',
              color: 'var(--history-text)',
              boxShadow: isActive ? '0 0 0 2px var(--surface), 0 0 0 4px var(--history-bg)' : 'none',
            })}
          >
            Human History
          </NavLink>
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
