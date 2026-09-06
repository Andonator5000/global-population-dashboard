import { Link } from 'react-router'

/**
 * The compact ⓘ that replaced in-page methodology prose (round-2 §36.4):
 * figures carry a short source label plus this link into the relevant
 * section of the Methodology page, where the full explanation lives once.
 */
export function MethodInfoLink({
  anchor,
  label = 'How this figure is computed',
}: {
  anchor: string
  label?: string
}) {
  return (
    <Link
      to={`/methodology#${anchor}`}
      aria-label={label}
      title={label}
      className="method-info"
    >
      ⓘ
    </Link>
  )
}
