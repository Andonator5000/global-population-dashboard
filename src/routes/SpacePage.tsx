import { Link } from 'react-router'

/**
 * /space -- the Space section landing (Phase 7). Solar System is the first
 * page; the section is structured like Biology so future pages slot in.
 */
export function SpacePage() {
  return (
    <div className="mx-auto max-w-5xl px-6 py-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Space</h1>
        <p
          className="mt-2 max-w-3xl text-sm"
          style={{ color: 'var(--text-muted)' }}
        >
          Beyond Earth, with the same rules as everywhere else on this site:
          NASA and JPL figures with source and vintage on every number, and
          scale handled honestly — when a view is not to scale, it says so.
        </p>
      </header>

      <div className="mt-8 grid gap-6 sm:grid-cols-2">
        <Link
          to="/space/solar-system"
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
          <h2 className="mt-1 text-xl">Solar System</h2>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            An interactive 3D model of the Sun, planets, dwarf planets,
            belts and every known moon — animated orbits, click-to-fly,
            and navigable globes with NASA Trek deep zoom for the Moon,
            Mars, Venus and Mercury.
          </p>
        </Link>

        <Link
          to="/space/phenomena"
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
          <h2 className="mt-1 text-xl">Cosmic Phenomena</h2>
          <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>
            Stars and their life cycles, neutron stars, black holes,
            quasars, supernovae, galaxies, dark matter and dark energy,
            gravitational waves and the Big Bang — illustrated with NASA
            and ESA imagery, sourced throughout.
          </p>
        </Link>
      </div>
    </div>
  )
}
