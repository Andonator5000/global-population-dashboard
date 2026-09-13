import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'

/**
 * The ⓘ definition control next to every property label (§47.4).
 *
 * Accessible by construction: a real <button> (focusable, Enter/Space),
 * aria-describedby pointing at the bubble so assistive tech reads the
 * definition whether or not it is visible, hover/focus reveal, click
 * PINS the bubble so the glossary link inside it is reachable by Tab,
 * Escape closes. Plain text glyph — the site's icon set is OpenMoji only
 * and no emoji is used.
 *
 * Escape is handled on this component's own root span (bubble phase),
 * covering both the ⓘ button and the pinned bubble's glossary link (a
 * sibling of the button, so a button-only handler would miss it), and
 * calls stopPropagation() so the keypress never reaches PeriodicTablePage's
 * own Escape-closes-the-panel handler — dismissing a pinned definition
 * must close only the innermost open thing, not the whole element panel
 * (review fix, §47).
 */
export function InfoTip({
  term,
  definition,
  unit,
  glossaryKey,
}: {
  term: string
  definition: string
  unit?: string | null | undefined
  glossaryKey: string
}) {
  const id = useId()
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const open = hover || pinned

  useEffect(() => {
    if (!pinned) return
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setPinned(false)
    }
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('pointerdown', onDown)
    }
  }, [pinned])

  return (
    <span
      ref={root}
      className="relative inline-block align-middle"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onKeyDown={(event) => {
        // Bubble handler on the shared root, not the button: the pinned
        // bubble's glossary link is a SIBLING of the button, so a
        // button-only handler would miss Escape pressed there. Only
        // stopPropagation while something of ours is actually open —
        // otherwise Escape should keep bubbling to close outer UI.
        if (event.key === 'Escape' && open) {
          event.stopPropagation()
          setPinned(false)
          setHover(false)
        }
      }}
    >
      <button
        type="button"
        className="method-info"
        aria-label={`Definition of ${term}`}
        aria-describedby={id}
        aria-expanded={open}
        onFocus={() => setHover(true)}
        onBlur={() => setHover(false)}
        onClick={() => setPinned((value) => !value)}
      >
        ⓘ
      </button>
      <span
        id={id}
        role="tooltip"
        hidden={!open}
        className="absolute left-0 top-full z-30 mt-1 w-72 rounded border px-3 py-2 text-xs font-normal leading-snug shadow-md"
        style={{
          background: 'var(--surface-raised)',
          borderColor: 'var(--border-strong)',
          color: 'var(--text)',
          boxShadow: 'var(--shadow-card)',
          textTransform: 'none',
          letterSpacing: 'normal',
        }}
      >
        <strong style={{ fontWeight: 600 }}>{term}</strong>
        {unit ? <span style={{ color: 'var(--text-muted)' }}> · {unit}</span> : null}
        <span className="mt-1 block">{definition}</span>
        <Link
          to={`/chemistry/glossary#${glossaryKey}`}
          className="mt-1 inline-block underline underline-offset-2"
          tabIndex={pinned ? 0 : -1}
        >
          Glossary entry and source
        </Link>
      </span>
    </span>
  )
}
