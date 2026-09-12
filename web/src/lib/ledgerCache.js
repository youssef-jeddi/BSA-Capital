/**
 * One in-flight request per key, and a short TTL.
 *
 * Every list hook fetched the same vault independently on its own 8s timer, and
 * three tabs mount three copies of useVaults. A vault list of 20 cost ~150
 * websocket requests a minute for data that only changes at ledger cadence.
 *
 * This deduplicates concurrent reads and serves a recent answer to the rest.
 */
const TTL_MS = 4000

const entries = new Map()   // key -> { at, value }
const inFlight = new Map()  // key -> Promise

export async function cached(key, fetcher, ttl = TTL_MS) {
  const hit = entries.get(key)
  if (hit && Date.now() - hit.at < ttl) return hit.value

  const pending = inFlight.get(key)
  if (pending) return pending

  const promise = (async () => {
    try {
      const value = await fetcher()
      entries.set(key, { at: Date.now(), value })
      return value
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, promise)
  return promise
}

/** Drop cached reads for one key, or everything, after a write. */
export function invalidate(prefix) {
  if (!prefix) { entries.clear(); return }
  for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key)
}
