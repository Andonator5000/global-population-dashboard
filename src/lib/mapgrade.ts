/**
 * Imagery tone grades for the map colour directions (round 4,
 * DATA_DECISIONS.md §51).
 *
 * The six palette directions colour COUNTRY FILLS, and lightness is their
 * data channel — that has nothing to grade on satellite or terrain
 * imagery, which is why "Map colours" used to do nothing on those base
 * views (Andy: "Antique is not available for the Terrain map"). What a
 * direction CAN carry onto imagery is its sheet: a tone over the
 * picture, its line colour, its lettering. These grades are that tone,
 * applied per pixel in the imagery shader (and as a CSS filter on the
 * 2-D fallback). They are presentation only — no figure is encoded in
 * them, so they sit outside the palette gates — and the political fills
 * are never graded: they already ARE the palette.
 */

import type { MapPaletteKey } from '../config'

export interface ImageryGrade {
  /** 0 = full colour, 1 = luminance only. */
  desaturate: number
  /** Blend toward a warm sepia at equal luminance. */
  sepia: number
  /** Lift toward white (parchment and pastel paleness). */
  lift: number
  /** Recolour toward this hue at equal luminance, by `tintAmount`. */
  tint: [number, number, number]
  tintAmount: number
  /** Chroma boost at equal luminance: 0 = as shot, 0.35 = +35% (round 12). */
  saturate: number
  /** Contrast about mid-grey: 0 = as shot, 0.15 = +15% (round 12). */
  contrast: number
}

const NONE: ImageryGrade = {
  desaturate: 0,
  sepia: 0,
  lift: 0,
  tint: [1, 1, 1],
  tintAmount: 0,
  saturate: 0,
  contrast: 0,
}

export const IMAGERY_GRADES: Record<MapPaletteKey, ImageryGrade> = {
  atlas: NONE,
  paper: { ...NONE, desaturate: 0.4, lift: 0.08 },
  // The Blaeu sheet's tone (§48): the relief reads as a tinted engraving.
  antique: { ...NONE, sepia: 0.9, lift: 0.06 },
  pastel: { ...NONE, desaturate: 0.5, lift: 0.22 },
  // Chart blue, measured from the nautical direction's water.
  nautical: { ...NONE, desaturate: 0.25, tint: [0.55, 0.7, 0.82], tintAmount: 0.3 },
  mono: { ...NONE, desaturate: 1 },
}

export function isIdentityGrade(grade: ImageryGrade): boolean {
  return (
    grade.desaturate === 0 &&
    grade.sepia === 0 &&
    grade.lift === 0 &&
    grade.tintAmount === 0 &&
    grade.saturate === 0 &&
    grade.contrast === 0
  )
}

/** The same grade as a CSS filter, for the no-WebGL2 canvas fallback.
 *  Approximate by construction (CSS has no luminance-preserving tint);
 *  the fallback is already the lesser renderer. */
export function gradeFilter(grade: ImageryGrade): string {
  if (isIdentityGrade(grade)) return 'none'
  const parts: string[] = []
  if (grade.desaturate > 0) parts.push(`saturate(${(1 - grade.desaturate).toFixed(2)})`)
  if (grade.saturate > 0) parts.push(`saturate(${(1 + grade.saturate).toFixed(2)})`)
  if (grade.contrast > 0) parts.push(`contrast(${(1 + grade.contrast).toFixed(2)})`)
  if (grade.sepia > 0) parts.push(`sepia(${grade.sepia.toFixed(2)})`)
  if (grade.lift > 0) parts.push(`brightness(${(1 + grade.lift * 0.6).toFixed(2)})`)
  return parts.join(' ') || 'none'
}
