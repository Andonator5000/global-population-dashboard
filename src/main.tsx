import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'

import { App } from './App'
import './index.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Root element #root missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    {/* basename matches Vite's base so routes resolve under the GitHub Pages
        project path (/global-population-dashboard/) as well as at root in
        development. Without it every internal link would drop the prefix. */}
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
