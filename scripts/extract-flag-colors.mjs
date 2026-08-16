/**
 * Flag colour extraction.
 *
 * Stage 1 of the map palette: fetch each entity's flag SVG, rasterise it,
 * quantise, and pull out the dominant NON-NEUTRAL colour plus a full accent
 * palette.
 *
 * Why non-neutral: a naive "most common pixel" picks white for a large share
 * of the world's flags (Japan, Finland, Poland, Nigeria...) and produces a map
 * of identical pale blobs. We skip pixels whose OKLCH chroma is below a floor
 * or whose lightness is at either extreme, then take the most frequent hue
 * bucket of what remains. Flags that are genuinely all-neutral (a handful) are
 * reported rather than silently assigned a colour.
 *
 * Output: data/flags/raw-palette.json — the UNCLAMPED flag colours, used on
 * country detail pages where a colour has room to breathe. Normalisation into
 * the map's narrow band, and the adjacency pass, happen in
 * scripts/build-map-palette.mjs.
 *
 * Run: npm run flags
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { converter, formatHex } from 'culori'
import sharp from 'sharp'

const ROOT = resolve(import.meta.dirname, '..')
const ENTITIES = resolve(ROOT, 'data/entities.json')
const CACHE_DIR = resolve(ROOT, '.cache/flags')
const OUT_DIR = resolve(ROOT, 'data/flags')
const OUT_FILE = resolve(OUT_DIR, 'raw-palette.json')
/**
 * Committed copies of the flag SVGs themselves, keyed by ISO3 so the app can
 * address them with its join key. The browser never calls flagcdn (or any
 * upstream) at render time, so showing a flag on a country page requires the
 * artifact to live in /data like everything else. ~4 MB for all 250.
 */
const SVG_DIR = resolve(OUT_DIR, 'svg')

const RASTER_WIDTH = 160
/** Pixels below this OKLCH chroma are neutral (white/black/grey) and skipped. */
const CHROMA_FLOOR = 0.04
/** Pixels outside this lightness range carry no usable hue. */
const LIGHTNESS_RANGE = [0.12, 0.95]
/** Hue bucket width, degrees. Coarse enough that a gradient stays one colour. */
const HUE_BUCKET = 10
/** How many accent colours to keep per flag for the country detail page. */
const ACCENT_COUNT = 4

const toOklch = converter('oklch')
const toRgb = converter('rgb')

const concurrency = 12

async function fetchFlag(iso2) {
  const code = iso2.toLowerCase()
  const cached = resolve(CACHE_DIR, `${code}.svg`)
  if (existsSync(cached)) return readFileSync(cached)

  const response = await fetch(`https://flagcdn.com/${code}.svg`)
  if (!response.ok) return null
  const buffer = Buffer.from(await response.arrayBuffer())
  writeFileSync(cached, buffer)
  return buffer
}

/**
 * Quantise a raster into hue buckets weighted by pixel count.
 * Returns buckets sorted by coverage, each with a representative colour.
 */
function quantise(data, channels) {
  const buckets = new Map()
  let neutralPixels = 0
  let totalPixels = 0

  for (let i = 0; i < data.length; i += channels) {
    const alpha = channels === 4 ? data[i + 3] : 255
    if (alpha < 128) continue
    totalPixels += 1

    const colour = toOklch({
      mode: 'rgb',
      r: data[i] / 255,
      g: data[i + 1] / 255,
      b: data[i + 2] / 255,
    })
    const chroma = colour.c ?? 0
    const lightness = colour.l ?? 0

    if (
      chroma < CHROMA_FLOOR ||
      lightness < LIGHTNESS_RANGE[0] ||
      lightness > LIGHTNESS_RANGE[1]
    ) {
      neutralPixels += 1
      continue
    }

    const hue = ((colour.h ?? 0) % 360 + 360) % 360
    const key = Math.floor(hue / HUE_BUCKET)
    const bucket = buckets.get(key) ?? { count: 0, l: 0, c: 0, sin: 0, cos: 0 }
    bucket.count += 1
    bucket.l += lightness
    bucket.c += chroma
    // Circular mean, so a bucket straddling 0/360 does not average to 180.
    bucket.sin += Math.sin((hue * Math.PI) / 180)
    bucket.cos += Math.cos((hue * Math.PI) / 180)
    buckets.set(key, bucket)
  }

  const ranked = [...buckets.values()]
    .map((bucket) => {
      const hue =
        ((Math.atan2(bucket.sin / bucket.count, bucket.cos / bucket.count) *
          180) /
          Math.PI +
          360) %
        360
      return {
        share: bucket.count / Math.max(1, totalPixels),
        pixels: bucket.count,
        oklch: {
          l: bucket.l / bucket.count,
          c: bucket.c / bucket.count,
          h: hue,
        },
      }
    })
    .sort((a, b) => b.pixels - a.pixels)

  return {
    ranked,
    neutralShare: neutralPixels / Math.max(1, totalPixels),
    totalPixels,
  }
}

function hexOf(oklch) {
  return formatHex(toRgb({ mode: 'oklch', ...oklch }))
}

async function processEntity(entity) {
  if (!entity.iso2) {
    return { iso3: entity.iso3, status: 'no-iso2' }
  }

  let buffer
  try {
    buffer = await fetchFlag(entity.iso2)
  } catch (error) {
    return { iso3: entity.iso3, status: 'fetch-error', error: String(error) }
  }
  if (!buffer) return { iso3: entity.iso3, status: 'no-flag' }

  // Commit the SVG itself, even when no colour can be extracted from it — an
  // achromatic flag is still a flag the country page should show.
  writeFileSync(resolve(SVG_DIR, `${entity.iso3}.svg`), buffer)

  let raster
  try {
    raster = await sharp(buffer, { density: 200 })
      .resize({ width: RASTER_WIDTH, fit: 'inside' })
      .flatten({ background: '#ffffff' })
      .raw()
      .toBuffer({ resolveWithObject: true })
  } catch (error) {
    return { iso3: entity.iso3, status: 'raster-error', error: String(error) }
  }

  const { ranked, neutralShare } = quantise(
    raster.data,
    raster.info.channels,
  )

  if (ranked.length === 0) {
    // A genuinely achromatic flag. Reported, never guessed at.
    return {
      iso3: entity.iso3,
      status: 'achromatic',
      neutralShare,
    }
  }

  const dominant = ranked[0]
  return {
    iso3: entity.iso3,
    iso2: entity.iso2,
    name: entity.name_common,
    status: 'ok',
    neutralShare: Number(neutralShare.toFixed(4)),
    dominant: {
      hex: hexOf(dominant.oklch),
      oklch: {
        l: Number(dominant.oklch.l.toFixed(4)),
        c: Number(dominant.oklch.c.toFixed(4)),
        h: Number(dominant.oklch.h.toFixed(2)),
      },
      share: Number(dominant.share.toFixed(4)),
    },
    accents: ranked.slice(0, ACCENT_COUNT).map((bucket) => ({
      hex: hexOf(bucket.oklch),
      oklch: {
        l: Number(bucket.oklch.l.toFixed(4)),
        c: Number(bucket.oklch.c.toFixed(4)),
        h: Number(bucket.oklch.h.toFixed(2)),
      },
      share: Number(bucket.share.toFixed(4)),
    })),
  }
}

async function main() {
  mkdirSync(CACHE_DIR, { recursive: true })
  mkdirSync(OUT_DIR, { recursive: true })
  mkdirSync(SVG_DIR, { recursive: true })

  const entities = JSON.parse(readFileSync(ENTITIES, 'utf-8'))
  console.log(`Extracting flag colours for ${entities.length} entities…`)

  const results = []
  for (let i = 0; i < entities.length; i += concurrency) {
    const slice = entities.slice(i, i + concurrency)
    results.push(...(await Promise.all(slice.map(processEntity))))
    process.stdout.write(
      `\r  ${Math.min(i + concurrency, entities.length)}/${entities.length}`,
    )
  }
  process.stdout.write('\n')

  const ok = results.filter((r) => r.status === 'ok')
  const problems = results.filter((r) => r.status !== 'ok')

  const byIso3 = {}
  for (const result of ok) byIso3[result.iso3] = result

  writeFileSync(
    OUT_FILE,
    JSON.stringify(
      {
        note:
          'Unclamped dominant flag colours and accent palettes. Used on ' +
          'country detail pages. The map fill is derived from these in ' +
          'build-map-palette.mjs, which clamps lightness and chroma.',
        source: 'flagcdn.com flag SVGs',
        rasterWidth: RASTER_WIDTH,
        chromaFloor: CHROMA_FLOOR,
        extracted: ok.length,
        unavailable: problems.map((p) => ({
          iso3: p.iso3,
          status: p.status,
        })),
        flags: byIso3,
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  )

  console.log(`  extracted ${ok.length}, ${problems.length} without a colour`)
  const grouped = {}
  for (const p of problems) grouped[p.status] = (grouped[p.status] ?? 0) + 1
  for (const [status, count] of Object.entries(grouped)) {
    console.log(`    ${status}: ${count}`)
  }

  // Hue histogram -- the whole reason the brief warns about naive flag colour.
  const hues = ok.map((r) => r.dominant.oklch.h)
  const bands = { red: 0, orange: 0, yellow: 0, green: 0, cyan: 0, blue: 0, purple: 0, magenta: 0 }
  for (const h of hues) {
    if (h < 25 || h >= 345) bands.red += 1
    else if (h < 65) bands.orange += 1
    else if (h < 105) bands.yellow += 1
    else if (h < 165) bands.green += 1
    else if (h < 215) bands.cyan += 1
    else if (h < 285) bands.blue += 1
    else if (h < 320) bands.purple += 1
    else bands.magenta += 1
  }
  console.log('\n  dominant hue distribution:')
  for (const [band, count] of Object.entries(bands)) {
    const share = ((count / ok.length) * 100).toFixed(1)
    console.log(`    ${band.padEnd(8)} ${String(count).padStart(3)}  ${share}%`)
  }
  console.log(`\n  wrote ${OUT_FILE}`)
}

await main()
