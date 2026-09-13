import { useEffect, useRef, useState } from 'react'
import { ledgerNowMs } from '../lib/ledger.js'

const OFFSET_KEY = 'bsa_demo_clock_offset'

/** Demo-only shift of the app's view of "now". Never changes what the ledger does. */
export const getDemoOffset = () => {
  try { return Number(localStorage.getItem(OFFSET_KEY) ?? 0) || 0 } catch { return 0 }
}
export const setDemoOffset = (ms) => {
  try { localStorage.setItem(OFFSET_KEY, String(ms)) } catch { /* private mode */ }
  window.dispatchEvent(new Event('bsa-demo-clock'))
}

/**
 * A once-per-second clock anchored to ledger time.
 *
 * Countdowns used to move only when the 8s data poll landed, so they jumped in
 * blocks. We sync the drift between ledger close time and the local clock
 * every 30s and tick locally in between, which is smooth and still accurate.
 */
export function useClock() {
  const drift = useRef(0)
  const [demo, setDemo] = useState(getDemoOffset)
  const [nowMs, setNowMs] = useState(() => Date.now() + getDemoOffset())

  useEffect(() => {
    let alive = true
    const sync = () => ledgerNowMs()
      .then((ledger) => { if (alive) drift.current = ledger - Date.now() })
      .catch(() => {})
    sync()
    const s = setInterval(sync, 30_000)
    return () => { alive = false; clearInterval(s) }
  }, [])

  useEffect(() => {
    const tick = () => setNowMs(Date.now() + drift.current + demo)
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [demo])

  useEffect(() => {
    const onChange = () => setDemo(getDemoOffset())
    window.addEventListener('bsa-demo-clock', onChange)
    return () => window.removeEventListener('bsa-demo-clock', onChange)
  }, [])

  return nowMs
}

/**
 * Refresh the moment a phase boundary passes, instead of waiting for the next
 * poll. Without this a vault sits in a stale phase for up to 8 seconds after
 * its countdown hits zero.
 */
export function useBoundaryRefresh(boundaries, refresh, nowMs) {
  useEffect(() => {
    const next = boundaries.filter((b) => b != null && b > nowMs).sort((a, b) => a - b)[0]
    if (next == null) return
    const t = setTimeout(refresh, Math.min(next - nowMs + 1500, 2147483000))
    return () => clearTimeout(t)
    }, [boundaries.join(','), refresh])
}
