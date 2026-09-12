import { dropsToXrp, xrpToDrops } from 'xrpl'

/** Shares are 1:1 with drops at Scale 0, so a share is worth a drop of NAV at par. */
export const sharesToXrp = (shares) => Number(dropsToXrp(String(shares)))
export const xrpToDropsStr = (xrp) => String(xrpToDrops(String(xrp)))
export const dropsToXrpNum = (drops) => (drops == null ? null : Number(dropsToXrp(String(Math.floor(Number(drops))))))

/** What the shares are worth at the vault's current NAV. */
export const navValueDrops = (shares, navDrops) =>
  navDrops == null ? null : Math.round(Number(shares) * navDrops)

export function discountPct(askDrops, navTotalDrops) {
  if (!navTotalDrops || !Number(navTotalDrops)) return null
  return (1 - Number(askDrops) / Number(navTotalDrops)) * 100
}

/**
 * Three buyer states, in the order they must be resolved. The gates are
 * independent: opting in is permissionless, so an MPToken proves nothing.
 */
export function buyerState(eligibility) {
  if (!eligibility) return 'loading'
  if (!eligibility.credentialed) return 'needs-credential'
  if (!eligibility.opted_in) return 'needs-optin'
  return 'ready'
}
