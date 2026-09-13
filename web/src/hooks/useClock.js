import { useEffect, useRef, useState } from 'react'
import { ledgerNowMs } from '../lib/ledger.js'

/**
 * A once-per-second clock anchored to ledger time.
 *
 * Countdowns used to move only when the 8s data poll landed, so they jumped in
 * blocks. We sync the drift between ledger close time and the local clock
 * every 30s and tick locally in between, which is smooth and still accurate.
 */
export function useClock() {
  const drift = useRef(0)
  const [nowMs, setNowMs] = useState(() => Date.now())

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
    const tick = () => setNowMs(Date.now() + drift.current)
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
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
