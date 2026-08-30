import { Link, NavLink, Route, Routes } from 'react-router'

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
          className="flex items-baseline gap-6 px-6 py-3"
          aria-label="Primary"
        >
          <Link
            to="/"
            className="rounded-md px-3 py-1.5 text-sm font-medium tracking-tight"
            style={{
              background: 'var(--brand-bg)',
              color: 'var(--brand-text)',
            }}
          >
            Global Population Dashboard
          </Link>
          <NavLink
            to="/history"
            className="text-sm underline-offset-2 hover:underline"
            style={({ isActive }) => ({
              color: isActive ? 'var(--text)' : 'var(--text-muted)',
              fontWeight: isActive ? 600 : 400,
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
