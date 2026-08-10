/**
 * d3-geo-projection ships no type declarations and has no @types package on
 * npm (verified 2026-08-09: registry returns 404 for @types/d3-geo-projection).
 *
 * We only use the alternative equal-area projections that config.ts allows as
 * swappable replacements for Equal Earth, so this declares exactly those rather
 * than the module's full ~70-projection surface. Add to it as needed.
 */
declare module 'd3-geo-projection' {
  import type { GeoProjection } from 'd3-geo'

  /** Mollweide equal-area pseudocylindrical projection. */
  export function geoMollweide(): GeoProjection

  /** Eckert IV equal-area pseudocylindrical projection. */
  export function geoEckert4(): GeoProjection

  /** Hammer (Aitoff-based) equal-area projection. */
  export function geoHammer(): GeoProjection

  /** Sinusoidal equal-area projection. */
  export function geoSinusoidal(): GeoProjection
}
