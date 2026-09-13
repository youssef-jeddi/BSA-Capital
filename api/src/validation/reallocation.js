/**
 * The rules a mid-term rebalance has to satisfy, as pure functions.
 *
 * A curator's sub-fund position is locked in that fund's Investment phase, so a
 * rebalance is not a withdrawal: it is a sale on the secondary market followed
 * by a deposit somewhere else. Two things the protocol will not check for us:
 *
 *   the destination must still be accepting deposits, and
 *   the destination must redeem before the curator loan matures.
 *
 * Miss the first and the proceeds sit as idle cash after the shares are already
 * gone. Miss the second and the capital is locked when the loan comes due, which
 * is the one failure that cannot be recovered from.
 */
import { validateMaturityCascade } from './allocations.js'

/** A vault only accepts a deposit before its subscription date. */
export const isRaising = (vault, nowMs) =>
  vault?.subscription_date != null && nowMs < vault.subscription_date * 1000 + 946684800000

/**
 * @param from    the allocation being exited
 * @param to      the destination vault record from the index
 * @param context { superVaultId, loanMaturity, superRedemption, nowMs }
 * @returns string[] of reasons this reallocation cannot proceed
 */
export function validateReallocation({ from, to, context }) {
  const errors = []

  if (!from) return ['That allocation is not part of this super vault.']
  if (from.status !== 'exiting') {
    errors.push(from.status === 'exited'
      ? 'That position has already been reallocated.'
      : 'Sell the position before redeploying: nothing has been exited yet.')
  }

  if (!to) return errors.concat('The destination fund is not listed on the platform.')
  if (to.vault_id === context.superVaultId) errors.push('A super vault cannot allocate to itself.')
  if (to.vault_id === from.sub_vault_id) errors.push('The destination is the fund being exited.')

  if (!isRaising(to, context.nowMs)) {
    errors.push(`${to.name} has closed its subscription window, so it cannot accept a deposit. `
      + 'Choose a fund that is still raising.')
  }

  // Same ceiling the super vault was created under, re-checked for the new fund.
  errors.push(...validateMaturityCascade({
    superRedemption: context.superRedemption,
    loanMaturity: context.loanMaturity,
    subVaults: [to],
  }))

  return errors
}

/**
 * The ask, in drops, for a whole position sold at a discount to net asset value.
 *
 * BigInt throughout: a 50 XRP position is 50,000,000 shares, past the range where
 * floating point and whole drops agree.
 */
export function askFromNav({ shares, navDrops, discountBps }) {
  if (navDrops == null) return null
  const bps = Number(discountBps ?? 0)
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) return null
  // nav_drops is drops per share and fractional, so scale before rounding.
  const navTotal = (BigInt(shares) * BigInt(Math.round(navDrops * 1e6))) / 1_000_000n
  const ask = (navTotal * BigInt(10_000 - bps)) / 10_000n
  return { navTotal: navTotal.toString(), ask: ask.toString(), haircut: (navTotal - ask).toString() }
}
