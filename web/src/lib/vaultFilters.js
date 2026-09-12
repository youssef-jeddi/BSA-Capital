/**
 * Pure list shaping for the fund browser. No React, no fetching: takes the
 * enriched vault list and returns a new one.
 */

export const PHASE_FILTERS = [
  { id: 'open', label: 'Open for deposits' },
  { id: 'all', label: 'All funds' },
]

export const SORTS = [
  { id: 'closing', label: 'Closing soonest' },
  { id: 'raised', label: 'Most raised' },
  { id: 'newest', label: 'Newest' },
  { id: 'name', label: 'Name A–Z' },
]

const raised = (v) => Number(v.vault?.AssetsTotal ?? 0)
const endsAt = (v) => v.phase?.endsAt ?? Number.MAX_SAFE_INTEGER

/** Distinct issuers present in the list, for the issuer dropdown. */
export function issuersOf(vaults) {
  const seen = new Map()
  for (const v of vaults) {
    if (!seen.has(v.company_address)) {
      seen.set(v.company_address, {
        address: v.company_address,
        name: v.company_name,
        activity: v.company_activity,
        count: 0,
      })
    }
    seen.get(v.company_address).count += 1
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function filterVaults(vaults, { phase = 'open', issuer = 'all' } = {}) {
  return vaults.filter((v) => {
    if (phase === 'open' && v.phase?.phase !== 'Subscription') return false
    if (issuer !== 'all' && v.company_address !== issuer) return false
    return true
  })
}

export function sortVaults(vaults, sort = 'closing') {
  const copy = [...vaults]
  switch (sort) {
    case 'raised': return copy.sort((a, b) => raised(b) - raised(a))
    case 'newest': return copy.sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
    case 'name': return copy.sort((a, b) => a.name.localeCompare(b.name))
    default: return copy.sort((a, b) => endsAt(a) - endsAt(b))
  }
}

export const openCount = (vaults, issuer = 'all') =>
  filterVaults(vaults, { phase: 'open', issuer }).length
