/**
 * Gate: the evolution timeline is complete and honestly sourced
 * (round-2 §40.4).
 *
 * - Every ICS PERIOD is covered by at least one event (an event covers a
 *   period when its date range overlaps it) — the maintainer found the
 *   Tonian empty once; this keeps every unit inhabited from now on.
 * - Every event carries a date, a summary, a Wikipedia anchor and at
 *   least one source; images, where present, carry a licence.
 * - Banner units carry their editorial description and etymology.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const DATA_DIR = fileURLToPath(
  new URL('../data/biology/evolution/', import.meta.url),
)

let failures = 0
const fail = (message) => {
  failures += 1
  console.error(`  FAIL  ${message}`)
}

const chart = JSON.parse(readFileSync(join(DATA_DIR, 'chart.json'), 'utf-8'))
const eventsFile = JSON.parse(
  readFileSync(join(DATA_DIR, 'events.json'), 'utf-8'),
)
const events = eventsFile.events

for (const event of events) {
  if (typeof event.startMa !== 'number') fail(`${event.id}: no startMa`)
  if (!event.summary || event.summary.split(' ').length < 30) {
    fail(`${event.id}: summary missing or too short`)
  }
  if (!event.wikipedia) fail(`${event.id}: no wikipedia anchor`)
  if (!event.sources?.length) fail(`${event.id}: no sources`)
  if (event.image && !event.image.license) {
    fail(`${event.id}: image without a licence`)
  }
}

const periods = chart.intervals.filter((i) => i.rank === 'Period')
const covers = (event, period) => {
  const end = event.endMa ?? event.startMa
  return event.startMa >= period.endMa && end <= period.startMa
}
for (const period of periods) {
  const inside = events.filter((event) => covers(event, period))
  if (inside.length === 0) {
    fail(`period ${period.name} (${period.startMa}–${period.endMa} Ma) has no events`)
  }
}

const banners = chart.intervals.filter((i) =>
  ['Eon', 'Era', 'Period'].includes(i.rank),
)
const missingNotes = banners.filter((i) => !i.description || !i.etymology)
if (missingNotes.length > 0) {
  fail(
    `banner units without description/etymology: ` +
      missingNotes.map((i) => i.name).join(', '),
  )
}

console.log(
  `  ${events.length} events; ${periods.length} periods all covered: ` +
    `${failures === 0}; ${banners.length} banner units annotated`,
)
if (failures > 0) {
  console.error(`\nFAIL — ${failures} evolution problem(s).`)
  process.exit(1)
}
console.log('\nPASS — every period is inhabited and every entry is sourced.')
