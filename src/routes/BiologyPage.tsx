import { Link } from 'react-router'

/**
 * /biology -- the Biology section landing (Phase 5). Structured like the
 * other sections: a titled landing that indexes the section's pages.
 * Taxonomy is the first; Evolution follows in Phase 6.
 */
export function BiologyPage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Biology</h1>
        <p
          className="mt-2 max-w-3xl text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          The living world, built from the same rules as the rest of the
          site: authoritative machine-readable sources, provenance on every
          figure, and open disagreement marked as such rather than smoothed
          over.
        </p>
      </header>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <Link
          to="/biology/taxonomy"
          className="block rounded-xl border px-6 py-6"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--surface-raised)',
          }}
        >
          <p
            className="font-sans text-xs font-medium uppercase tracking-widest"
            style={{ color: 'var(--text-muted)' }}
          >
            Page one
          </p>
          <h2 className="mt-1 text-xl">Taxonomy</h2>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            An interactive tree of life from the Catalogue of Life checklist:
            three domains, every kingdom, phylum, class, order and family,
            with species-level depth for well-known groups and each taxon
            linked to its Wikipedia article.
          </p>
        </Link>

        <Link
          to="/biology/evolution"
          className="block rounded-xl border px-6 py-6"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--surface-raised)',
          }}
        >
          <p
            className="font-sans text-xs font-medium uppercase tracking-widest"
            style={{ color: 'var(--text-muted)' }}
          >
            Page two
          </p>
          <h2 className="mt-1 text-xl">Evolution</h2>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            The history of life on Earth from the planet's formation to the
            present, banded by the ICS chronostratigraphic chart, with the
            major events, organisms and mass extinctions — dates carrying
            their stated uncertainty.
          </p>
        </Link>
      </div>
    </div>
  )
}
