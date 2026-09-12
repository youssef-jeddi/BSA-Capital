/**
 * Phase boundaries as absolute dates.
 *
 * "Minutes from now" was fine for smoke tests and useless for planning a demo
 * at a known time, so the forms take real dates and convert to Ripple time.
 */
import { unixTimeToRippleTime } from 'xrpl'

/** Value shape a datetime-local input expects, in the browser's timezone. */
export function toInputValue(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const fromInputValue = (value) => (value ? new Date(value).getTime() : null)

export const inMinutes = (minutes) => toInputValue(Date.now() + minutes * 60_000)

export const toRipple = (value) => {
  const ms = fromInputValue(value)
  return ms == null ? null : unixTimeToRippleTime(ms)
}

export const PRESETS = [
  { label: '+5 min', minutes: 5 },
  { label: '+15 min', minutes: 15 },
  { label: '+1 hour', minutes: 60 },
  { label: '+1 day', minutes: 1440 },
]

export function describeGap(fromValue, toValue) {
  const a = fromInputValue(fromValue)
  const b = fromInputValue(toValue)
  if (a == null || b == null) return null
  const seconds = Math.round((b - a) / 1000)
  if (seconds < 0) return { seconds, text: 'ends before it starts' }
  if (seconds < 90) return { seconds, text: `${seconds}s` }
  if (seconds < 5400) return { seconds, text: `${Math.round(seconds / 60)} min` }
  return { seconds, text: `${(seconds / 3600).toFixed(1)} h` }
}
