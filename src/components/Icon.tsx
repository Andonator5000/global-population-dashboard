import type { CSSProperties } from 'react'

/**
 * One monochrome OpenMoji glyph (black-outline variant, CC BY-SA 4.0),
 * vendored under public/icons/openmoji by scripts/fetch-icons.mjs.
 *
 * Painted through a CSS mask in currentColor, so the same SVG follows the
 * theme and any text colour it sits beside. Always decorative: aria-hidden,
 * never the only carrier of meaning (the label is always beside it).
 */
export function Icon({
  code,
  className = '',
  size,
}: {
  /** OpenMoji hexcode, e.g. "1F349". */
  code: string
  className?: string
  /** CSS size; defaults to 1.25em via the .om-icon rule. */
  size?: string
}) {
  const url = `${import.meta.env.BASE_URL}icons/openmoji/${code}.svg`
  return (
    <span
      aria-hidden="true"
      className={`om-icon ${className}`.trim()}
      style={
        {
          '--icon': `url("${url}")`,
          ...(size ? { width: size, height: size } : {}),
        } as CSSProperties
      }
    />
  )
}

/** Attribution line required by OpenMoji's CC BY-SA 4.0 licence. */
export const ICON_ATTRIBUTION = 'Icons: OpenMoji (openmoji.org), CC BY-SA 4.0'
