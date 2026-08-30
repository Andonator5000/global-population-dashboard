/**
 * One OpenMoji glyph (colour variant, CC BY-SA 4.0), vendored under
 * public/icons/openmoji by scripts/fetch-icons.mjs.
 *
 * Rendered as an inline image sized in em so it scales with the text it
 * decorates. Always decorative: aria-hidden with an empty alt, never the
 * only carrier of meaning (the label is always beside it).
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
    <img
      src={url}
      alt=""
      aria-hidden="true"
      loading="lazy"
      className={`om-icon ${className}`.trim()}
      style={size ? { width: size, height: size } : undefined}
    />
  )
}

/** Attribution line required by OpenMoji's CC BY-SA 4.0 licence. */
export const ICON_ATTRIBUTION = 'Icons: OpenMoji (openmoji.org), CC BY-SA 4.0'
