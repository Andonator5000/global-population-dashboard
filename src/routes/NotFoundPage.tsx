import { Link } from 'react-router'

export function NotFoundPage() {
  return (
    <div className="mx-auto max-w-7xl px-6 py-12">
      <h1 className="text-2xl font-semibold">Page not found</h1>
      <p className="mt-2" style={{ color: 'var(--text-muted)' }}>
        <Link to="/" className="underline underline-offset-2">
          Back to the map
        </Link>
      </p>
    </div>
  )
}
