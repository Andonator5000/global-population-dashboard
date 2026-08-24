import { useEffect, useState } from 'react'

import type { AsyncState } from './data'

/**
 * LIVE client-side fetches.
 *
 * A deliberate, contained exception to this app's "no upstream calls at
 * render time" rule (2026-08-23, maintainer request): live exchange rates
 * and live weather cannot exist in a committed artifact by definition. The
 * exception is held to sources that are keyless, CORS-enabled, and verified
 * from a browser context:
 *
 *   open.er-api.com   daily FX rates, ~166 ISO-4217 currencies. Free-tier
 *                     terms REQUIRE a visible attribution link; the tile
 *                     renders it.
 *   open-meteo.com    current weather. Free for non-commercial use, data
 *                     CC BY 4.0; the panel names it.
 *
 * Every failure resolves to the app's normal explicit-unavailable state.
 * These fetches never block the committed figures around them.
 */

const FX_URL = 'https://open.er-api.com/v6/latest/USD'
export const FX_ATTRIBUTION = {
  label: 'Rates By Exchange Rate API',
  href: 'https://www.exchangerate-api.com',
}

export interface LiveRates {
  /** ISO 4217 code -> units of that currency per 1 USD. */
  rates: Record<string, number>
  /** Publisher's own timestamp for the rate set, not our fetch time. */
  updatedUtc: string
}

/** One in-flight/settled promise per session; rates update daily upstream. */
let ratesPromise: Promise<LiveRates> | null = null

function fetchRates(): Promise<LiveRates> {
  if (!ratesPromise) {
    ratesPromise = fetch(FX_URL)
      .then((response) => {
        if (!response.ok) throw new Error(`FX HTTP ${response.status}`)
        return response.json()
      })
      .then((payload: unknown) => {
        const body = payload as {
          result?: string
          rates?: Record<string, number>
          time_last_update_utc?: string
        }
        if (body.result !== 'success' || !body.rates) {
          throw new Error('FX response not successful')
        }
        return {
          rates: body.rates,
          updatedUtc: body.time_last_update_utc ?? 'unknown',
        }
      })
      .catch((error: unknown) => {
        // Allow a later mount to retry rather than caching the failure for
        // the whole session.
        ratesPromise = null
        throw error
      })
  }
  return ratesPromise
}

export function useLiveRates(): AsyncState<LiveRates> {
  const [state, setState] = useState<AsyncState<LiveRates>>({
    status: 'loading',
  })
  useEffect(() => {
    let cancelled = false
    fetchRates()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [])
  return state
}

// ---------------------------------------------------------------------------

export interface LiveWeather {
  timeIso: string
  temperatureC: number
  relativeHumidityPct: number
  windSpeedKmh: number
  weatherCode: number
}

/**
 * WMO 4677 weather interpretation codes, as Open-Meteo emits them. Grouped —
 * the panel needs "what is it like outside", not the full synoptic table.
 */
const WMO_DESCRIPTIONS: [Set<number>, string][] = [
  [new Set([0]), 'Clear sky'],
  [new Set([1]), 'Mainly clear'],
  [new Set([2]), 'Partly cloudy'],
  [new Set([3]), 'Overcast'],
  [new Set([45, 48]), 'Fog'],
  [new Set([51, 53, 55, 56, 57]), 'Drizzle'],
  [new Set([61, 63, 65, 66, 67]), 'Rain'],
  [new Set([71, 73, 75, 77]), 'Snow'],
  [new Set([80, 81, 82]), 'Rain showers'],
  [new Set([85, 86]), 'Snow showers'],
  [new Set([95, 96, 99]), 'Thunderstorm'],
]

export function describeWeatherCode(code: number): string {
  for (const [codes, label] of WMO_DESCRIPTIONS) {
    if (codes.has(code)) return label
  }
  return `Weather code ${code}`
}

export function useLiveWeather(
  lat: number | null,
  lon: number | null,
): AsyncState<LiveWeather> {
  const [state, setState] = useState<AsyncState<LiveWeather>>({
    status: 'loading',
  })
  useEffect(() => {
    if (lat === null || lon === null) return
    let cancelled = false
    setState({ status: 'loading' })
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(3)}` +
      `&longitude=${lon.toFixed(3)}` +
      `&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m`
    fetch(url)
      .then((response) => {
        if (!response.ok) throw new Error(`weather HTTP ${response.status}`)
        return response.json()
      })
      .then((payload: unknown) => {
        const current = (
          payload as {
            current?: {
              time: string
              temperature_2m: number
              relative_humidity_2m: number
              weather_code: number
              wind_speed_10m: number
            }
          }
        ).current
        if (!current) throw new Error('weather response missing current block')
        if (cancelled) return
        setState({
          status: 'ready',
          data: {
            timeIso: current.time,
            temperatureC: current.temperature_2m,
            relativeHumidityPct: current.relative_humidity_2m,
            windSpeedKmh: current.wind_speed_10m,
            weatherCode: current.weather_code,
          },
        })
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: error instanceof Error ? error : new Error(String(error)),
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [lat, lon])
  return state
}

// ---------------------------------------------------------------------------

/**
 * Piecewise-linear interpolation of an annual series at a fractional year,
 * holding flat beyond either end. This is the population counter's
 * discipline applied to the IMF debt series: the moving number is a MODEL of
 * the published annual figures, and the page must say so.
 */
export function interpolateAnnual(
  years: number[],
  values: number[],
  atYear: number,
): number | null {
  if (years.length === 0) return null
  if (atYear <= years[0]!) return values[0] ?? null
  const last = years.length - 1
  if (atYear >= years[last]!) return values[last] ?? null
  let index = 0
  while (index < last && years[index + 1]! <= atYear) index++
  const y0 = years[index]!
  const y1 = years[index + 1]!
  const v0 = values[index]!
  const v1 = values[index + 1]!
  return v0 + ((atYear - y0) / (y1 - y0)) * (v1 - v0)
}

/** Current moment as a fractional year, for interpolateAnnual. */
export function fractionalYearNow(): number {
  const now = new Date()
  const start = Date.UTC(now.getUTCFullYear(), 0, 1)
  const end = Date.UTC(now.getUTCFullYear() + 1, 0, 1)
  return now.getUTCFullYear() + (now.getTime() - start) / (end - start)
}
