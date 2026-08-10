import { Link, Route, Routes } from 'react-router'

import { FreshnessPanel } from './components/FreshnessPanel'
import { ContinentPage } from './routes/ContinentPage'
import { CountryPage } from './routes/CountryPage'
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
        <nav
          className="mx-auto flex max-w-7xl items-baseline gap-6 px-6 py-4"
          aria-label="Primary"
        >
          <Link to="/" className="text-sm font-medium tracking-tight">
            Global Population Dashboard
          </Link>
        </nav>
      </header>

      <main id="main" className="flex-1">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/continent/:id" element={<ContinentPage />} />
          <Route path="/country/:iso3" element={<CountryPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
      </main>

      <FreshnessPanel />
    </div>
  )
}
