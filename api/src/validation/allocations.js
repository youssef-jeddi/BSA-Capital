/**
 * The maturity cascade.
 *
 * XLS-66 already refuses a loan whose final payment falls after its vault's
 * RedemptionDate. A fund-of-funds needs the same rule one level up, and nothing
 * enforces it for us, so we enforce it here:
 *
 *   sub-vault redemption  <=  curator loan maturity  <   super vault redemption
 *
 * Break it and the super vault owes its depositors money that is still locked
 * inside a sub-vault.
 */
export const TOTAL_BPS = 10_000
export const MIN_ALLOCATION_BPS = 100 // 1%: below this the position is noise

export function validateAllocations(allocations) {
  const errors = []
  if (!Array.isArray(allocations) || allocations.length === 0) {
    return ['At least one sub-vault allocation is required']
  }

  const seen = new Set()
  let total = 0
  for (const a of allocations) {
    if (!/^[0-9A-Fa-f]{64}$/.test(a.sub_vault_id ?? '')) {
      errors.push('Each allocation needs a 64-character sub_vault_id')
      continue
    }
    if (seen.has(a.sub_vault_id)) errors.push(`Duplicate allocation for ${a.sub_vault_id.slice(0, 8)}`)
    seen.add(a.sub_vault_id)

    const bps = Number(a.target_bps)
    if (!Number.isInteger(bps) || bps < MIN_ALLOCATION_BPS || bps > TOTAL_BPS) {
      errors.push(`target_bps must be an integer between ${MIN_ALLOCATION_BPS} and ${TOTAL_BPS}`)
      continue
    }
    total += bps
  }

  if (!errors.length && total !== TOTAL_BPS) {
    errors.push(`Allocations must sum to 100% (${TOTAL_BPS} bps), got ${total}`)
  }
  return errors
}

/**
 * @param superRedemption  Ripple-time RedemptionDate of the super vault
 * @param loanMaturity     Ripple-time of the curator loan's final payment
 * @param subVaults        [{ vault_id, name, redemption_date }]
 */
export function validateMaturityCascade({ superRedemption, loanMaturity, subVaults }) {
  const errors = []

  if (loanMaturity != null && superRedemption != null && loanMaturity >= superRedemption) {
    errors.push('The curator loan must mature strictly before the super vault redeems')
  }

  for (const sub of subVaults) {
    if (sub.redemption_date == null) {
      errors.push(`${sub.name}: redemption date unknown, cannot verify the maturity cascade`)
      continue
    }
    const ceiling = loanMaturity ?? superRedemption
    if (ceiling != null && sub.redemption_date > ceiling) {
      errors.push(
        `${sub.name} redeems after the curator loan matures, so its capital would still be locked when the super vault owes its depositors`,
      )
    }
  }
  return errors
}

/** Split a raise across allocations. Largest remainder, so nothing is lost to rounding. */
export function splitAmount(totalDrops, allocations) {
  const total = BigInt(totalDrops)
  const exact = allocations.map((a) => ({
    ...a,
    raw: (total * BigInt(a.target_bps)) / BigInt(TOTAL_BPS),
    rem: (total * BigInt(a.target_bps)) % BigInt(TOTAL_BPS),
  }))
  let assigned = exact.reduce((s, e) => s + e.raw, 0n)
  const order = [...exact].sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : 0))
  let i = 0
  while (assigned < total) {
    order[i % order.length].raw += 1n
    assigned += 1n
    i += 1
  }
  return exact.map((e) => ({ sub_vault_id: e.sub_vault_id, target_bps: e.target_bps, amount: e.raw.toString() }))
}
