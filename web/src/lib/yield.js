/**
 * Two different numbers, never conflated.
 *
 * TARGET is a promise the manager typed at creation. It is stored off-ledger and
 * means nothing until loans actually pay.
 *
 * REALISED is what the ledger says happened: shares are minted at 1.000000 and
 * price per share only moves when a LoanPay lands in the vault, so the whole
 * return a depositor has earned is `pps - 1`. Nothing else needs reading.
 *
 * Rates are held in the ledger's own unit throughout: 1/10th of a basis point,
 * so 1000 is 1% and 100000 is 100% a year, the ceiling XLS-66 puts on a loan's
 * InterestRate.
 */

export const RATE_UNIT = 1000          // 1000 = 1%
export const MAX_RATE = 100000         // 100% annual, the protocol ceiling
const YEAR_MS = 365 * 24 * 60 * 60 * 1000

/** An annualisation over a few minutes is arithmetic, not information. */
export const RELIABLE_AFTER_MS = 60 * 60 * 1000

export const rateToPct = (r) => (r == null ? null : r / RATE_UNIT)
export const pctToRate = (p) => (p == null || p === '' ? null : Math.round(Number(p) * RATE_UNIT))

/** "9.40%" — the one place a rate becomes text. */
export function formatRate(rate, { digits = 2 } = {}) {
  const pct = rateToPct(rate)
  return pct == null ? '—' : `${pct.toFixed(digits)}%`
}

/**
 * What the fund has actually returned, from price per share alone.
 *
 * `since` is when the capital started working — subscription close, not fund
 * creation, because nothing can be lent before then. Returns null when there is
 * nothing to measure yet rather than a misleading zero.
 *
 * @returns {{ gain: number, apy: number, elapsedMs: number, reliable: boolean }|null}
 */
export function realisedYield({ pps, since, nowMs }) {
  if (pps == null || since == null || nowMs == null) return null
  const elapsedMs = nowMs - since
  if (elapsedMs <= 0) return null                 // still raising, no capital at work

  const gain = pps - 1
  return {
    gain,
    // Simple annualisation, not compounded: the term is fixed and short, and
    // compounding a number this noisy would only add false precision.
    apy: (gain * YEAR_MS) / elapsedMs,
    elapsedMs,
    reliable: elapsedMs >= RELIABLE_AFTER_MS,
  }
}

/** "+0.0013% earned" — the part of a realised yield that is always honest. */
export const formatGain = (gain) =>
  gain == null ? '—' : `${gain >= 0 ? '+' : ''}${(gain * 100).toFixed(4)}%`

/**
 * A super vault's sub-funds blended by their allocation weight.
 *
 * This is what the CURATOR earns, not what a depositor earns. A depositor is
 * paid through the curator loan, so the two differ by the curator's spread and
 * both belong on screen — showing only the blend overstates the return.
 *
 * @param positions allocations carrying `target_bps`
 * @param targetOf  sub_vault_id -> target_apy, in rate units
 */
export function blendedTarget(positions, targetOf) {
  if (!positions?.length) return null
  let weighted = 0
  let covered = 0
  for (const p of positions) {
    const rate = targetOf(p.sub_vault_id)
    if (rate == null) continue
    weighted += rate * (p.target_bps ?? 0)
    covered += p.target_bps ?? 0
  }
  if (!covered) return null
  return {
    rate: Math.round(weighted / covered),
    // Weight of the allocation whose sub-funds published a target at all.
    coverage: covered / 10000,
    complete: covered === 10000,
  }
}
