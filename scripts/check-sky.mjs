/**
 * Gate: the night sky behind the 3-D globe is real, complete and licensed
 * (round 13, DATA_DECISIONS section 66).
 *
 * The globe's surround is black on every view and palette direction, so the
 * sky is the only thing in it. A sky that silently lost half its stars, or
 * gained a NaN that blanks a canvas, or shipped without the licence its
 * sources require, would all look like "the space is a bit empty tonight".
 * This gate refuses each of them:
 *
 * - at least 8,000 stars, every one with a finite RA in [0, 360), a finite
 *   Dec in [-90, 90] and a finite visual magnitude, and every B-V either a
 *   finite number or an explicit null (never a silent zero);
 * - the parallel arrays are the same length and the named-star index list
 *   points inside them;
 * - exactly the 88 IAU constellations, each with a name, at least one line,
 *   an even, >= 4 long flattened coordinate list per line, a finite centroid
 *   and a rank;
 * - every source block carries a title, a URL, a licence and a citation, and
 *   the constellation figures are NOT under a copyleft licence (the site is
 *   permissively licensed; Stellarium's GPL sky cultures are the trap this
 *   check exists to catch);
 * - the artifact is at most 400 KB, because it loads on the map route.
 */

import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SKY_PATH = fileURLToPath(new URL('../data/geo/sky.json', import.meta.url))

const MIN_STARS = 8000
const IAU_CONSTELLATIONS = 88
const MAX_BYTES = 400_000
const COPYLEFT = /\bgpl\b|general public licence|general public license|\bagpl\b|\blgpl\b/i

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

const bytes = statSync(SKY_PATH).size
const sky = JSON.parse(readFileSync(SKY_PATH, 'utf-8'))

// -- stars ------------------------------------------------------------------

const stars = sky.stars ?? {}
const { ra, dec, mag, bv, names } = stars

if (!Array.isArray(ra) || !Array.isArray(dec) || !Array.isArray(mag)) {
  fail('stars.ra / stars.dec / stars.mag must all be arrays')
} else {
  if (ra.length < MIN_STARS) {
    fail(`only ${ra.length} stars; the gate needs at least ${MIN_STARS}`)
  }
  if (dec.length !== ra.length || mag.length !== ra.length) {
    fail(
      `parallel arrays disagree: ra=${ra.length} dec=${dec.length} ` +
        `mag=${mag.length}`,
    )
  }
  if (!Array.isArray(bv) || bv.length !== ra.length) {
    fail(`stars.bv must be an array of ${ra.length} entries`)
  }
  if (stars.count !== ra.length) {
    fail(`stars.count is ${stars.count} but there are ${ra.length} positions`)
  }

  let badRa = 0
  let badDec = 0
  let badMag = 0
  let badBv = 0
  let brightest = Infinity
  let faintest = -Infinity
  for (let i = 0; i < ra.length; i += 1) {
    const r = ra[i]
    const d = dec[i]
    const m = mag[i]
    if (!Number.isFinite(r) || r < 0 || r >= 360) badRa += 1
    if (!Number.isFinite(d) || d < -90 || d > 90) badDec += 1
    if (!Number.isFinite(m)) badMag += 1
    else {
      if (m < brightest) brightest = m
      if (m > faintest) faintest = m
    }
    const c = Array.isArray(bv) ? bv[i] : undefined
    if (c !== null && !Number.isFinite(c)) badBv += 1
  }
  if (badRa) fail(`${badRa} star(s) with a non-finite or out-of-range RA`)
  if (badDec) fail(`${badDec} star(s) with a non-finite or out-of-range Dec`)
  if (badMag) fail(`${badMag} star(s) with a non-finite magnitude`)
  if (badBv) fail(`${badBv} star(s) with a B-V that is neither a number nor null`)
  if (brightest > -1) {
    fail(`brightest star is magnitude ${brightest}; Sirius (-1.46) is missing`)
  }
  if (faintest < 6) {
    fail(`faintest star is magnitude ${faintest}; the catalogue should reach 6+`)
  }

  if (!Array.isArray(names)) {
    fail('stars.names must be an array of [index, name] pairs')
  } else {
    let badName = 0
    for (const pair of names) {
      if (
        !Array.isArray(pair) ||
        !Number.isInteger(pair[0]) ||
        pair[0] < 0 ||
        pair[0] >= ra.length ||
        typeof pair[1] !== 'string' ||
        pair[1].trim() === ''
      ) {
        badName += 1
      }
    }
    if (badName) fail(`${badName} malformed entr(ies) in stars.names`)
    if (names.length < 100) {
      fail(`only ${names.length} IAU proper names; expected well over 100`)
    }
    const byName = new Map(names.map(([i, n]) => [n, i]))
    for (const expected of ['Sirius', 'Betelgeuse', 'Rigel', 'Polaris', 'Vega']) {
      if (!byName.has(expected)) fail(`IAU name "${expected}" is missing`)
    }
  }
}

// -- constellations ---------------------------------------------------------

const constellations = sky.constellations
if (!Array.isArray(constellations)) {
  fail('constellations must be an array')
} else {
  if (constellations.length !== IAU_CONSTELLATIONS) {
    fail(
      `${constellations.length} constellations; there are exactly ` +
        `${IAU_CONSTELLATIONS} IAU constellations (Serpens counts once)`,
    )
  }
  const ids = new Set()
  for (const figure of constellations) {
    const id = figure?.id ?? '(no id)'
    if (ids.has(id)) fail(`duplicate constellation id ${id}`)
    ids.add(id)
    if (typeof figure?.name !== 'string' || figure.name.trim() === '') {
      fail(`${id}: missing name`)
    }
    if (!Number.isFinite(figure?.rank)) fail(`${id}: missing rank`)
    const centre = figure?.centre
    if (
      !Array.isArray(centre) ||
      centre.length !== 2 ||
      !Number.isFinite(centre[0]) ||
      !Number.isFinite(centre[1]) ||
      centre[0] < 0 ||
      centre[0] >= 360 ||
      centre[1] < -90 ||
      centre[1] > 90
    ) {
      fail(`${id}: centre is not a valid [ra, dec]`)
    }
    const lines = figure?.lines
    if (!Array.isArray(lines) || lines.length < 1) {
      fail(`${id}: needs at least one line`)
      continue
    }
    for (const flat of lines) {
      if (!Array.isArray(flat) || flat.length < 4 || flat.length % 2 !== 0) {
        fail(`${id}: a line is not an even, >= 4 long flat [ra, dec, ...]`)
        continue
      }
      for (let i = 0; i < flat.length; i += 2) {
        if (
          !Number.isFinite(flat[i]) ||
          flat[i] < 0 ||
          flat[i] >= 360 ||
          !Number.isFinite(flat[i + 1]) ||
          flat[i + 1] < -90 ||
          flat[i + 1] > 90
        ) {
          fail(`${id}: line vertex out of range at ${flat[i]}, ${flat[i + 1]}`)
          break
        }
      }
    }
  }
  for (const expected of ['Ori', 'UMa', 'Cru', 'Sco']) {
    if (!ids.has(expected)) fail(`constellation ${expected} is missing`)
  }
}

// -- provenance -------------------------------------------------------------

const sources = sky.sources
if (!sources || typeof sources !== 'object') {
  fail('no `sources` block')
} else {
  for (const key of ['stars', 'names', 'constellations']) {
    const source = sources[key]
    if (!source) {
      fail(`sources.${key} is missing`)
      continue
    }
    for (const field of ['title', 'url', 'licence', 'citation']) {
      if (typeof source[field] !== 'string' || source[field].trim() === '') {
        fail(`sources.${key}.${field} is missing`)
      }
    }
    if (typeof source.url === 'string' && !/^https?:\/\//.test(source.url)) {
      fail(`sources.${key}.url is not a URL: ${source.url}`)
    }
  }
  const figureLicence = sources.constellations?.licence ?? ''
  if (COPYLEFT.test(figureLicence)) {
    fail(
      `constellation figures are under "${figureLicence}"; this site is ` +
        'permissively licensed and must not ship GPL sky data',
    )
  }
}

if (typeof sky.equinox !== 'string' || !sky.equinox.includes('J2000')) {
  fail(`equinox should be stated as J2000.0, got ${sky.equinox}`)
}

// -- budget -----------------------------------------------------------------

if (bytes > MAX_BYTES) {
  fail(`data/geo/sky.json is ${bytes} bytes, over the ${MAX_BYTES} budget`)
}

// -- report -----------------------------------------------------------------

if (failures) {
  console.error(`\ncheck:sky FAILED with ${failures} problem(s)`)
  process.exit(1)
}

const lineCount = constellations.reduce((sum, c) => sum + c.lines.length, 0)
console.log(
  `check:sky OK  ${stars.count} stars (V ${sky.stars.magnitudeRange?.[0]} to ` +
    `${sky.stars.magnitudeRange?.[1]}), ${names.length} IAU names, ` +
    `${constellations.length} constellations in ${lineCount} polylines, ` +
    `${(bytes / 1024).toFixed(0)} KB of ${(MAX_BYTES / 1024).toFixed(0)} KB`,
)
