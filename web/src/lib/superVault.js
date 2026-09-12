/**
 * Client-side helpers for super vaults.
 *
 * The maturity cascade is enforced by the API, which is the authority. What
 * lives here is instant feedback while the curator edits weights, plus the
 * aggregate NAV maths, which is purely a read over live sub-vault state.
 */
export const TOTAL_BPS = 10_000
export const MIN_ALLOCATION_BPS = 100

export const bpsToPct = (bps) => (bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)
export const pctToBps = (pct) => Math.round(Number(pct) * 100)

/** Weight problems only. Maturity is checked server-side on submit. */
export function weightErrors(allocations) {
  if (!allocations.length) return ['Select at least one fund to allocate to.']
  const errors = []
  const total = allocations.reduce((s, a) => s + (Number(a.target_bps) || 0), 0)
  if (allocations.some((a) => Number(a.target_bps) < MIN_ALLOCATION_BPS)) {
    errors.push(`Each allocation must be at least ${bpsToPct(MIN_ALLOCATION_BPS)}%.`)
  }
  if (total !== TOTAL_BPS) {
    errors.push(`Allocations must total 100%. Currently ${bpsToPct(total)}%.`)
  }
  return errors
}

/**
 * Local preview of the cascade so the curator sees the problem before submitting.
 * Same rule the API enforces: every sub-vault must redeem at or before the
 * curator loan matures, and the loan must mature before the super vault redeems.
 */
export function cascadePreview({ superRedemption, loanMaturity, subVaults }) {
  const ceiling = loanMaturity ?? superRedemption
  return subVaults.map((sub) => ({
    ...sub,
    late: sub.redemption_date != null && ceiling != null && sub.redemption_date > ceiling,
    unknown: sub.redemption_date == null,
  }))
}

/**
 * Aggregate NAV across sub-vault positions.
 *
 * Price per share only moves at interest-payment events, so a blended number
 * is only as fresh as the least recently updated sub-vault. We surface the
 * per-position ledger sequence rather than pretending to a single live figure.
 */
export function aggregateNav(positions) {
  const known = positions.filter((p) => p.value != null)
  const total = known.reduce((s, p) => s + p.value, 0)
  const stalest = known.reduce(
    (min, p) => (p.lastLedger != null && (min == null || p.lastLedger < min) ? p.lastLedger : min),
    null,
  )
  return {
    total,
    counted: known.length,
    missing: positions.length - known.length,
    stalestLedger: stalest,
  }
}

/**
 * Split the deployment account's balance across allocations by weight, largest
 * remainder first so the parts sum exactly to the whole.
 */
export function splitRaise(entry, positions) {
  const total = BigInt(Math.floor(Number(entry.own?.vault?.AssetsTotal ?? 0)))
  const parts = positions.map((p) => ({
    sub_vault_id: p.sub_vault_id,
    raw: (total * BigInt(p.target_bps)) / BigInt(TOTAL_BPS),
    rem: (total * BigInt(p.target_bps)) % BigInt(TOTAL_BPS),
  }))
  let assigned = parts.reduce((s, p) => s + p.raw, 0n)
  const order = [...parts].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : 0))
  let i = 0
  while (assigned < total && order.length) {
    order[i % order.length].raw += 1n; assigned += 1n; i += 1
  }
  return parts.map((p) => ({ sub_vault_id: p.sub_vault_id, amount: p.raw.toString() }))
}
