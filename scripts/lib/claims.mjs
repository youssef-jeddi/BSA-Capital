/** Claim shaping shared by every verifier provider. */

/**
 * Edel-ID returns `[{given_name:'Alice'},{family_name:'Smith'}]`; the direct EUDI
 * decoder returns a flat object. Accept either without a branch.
 */
export const flattenClaims = (verifiedClaims) => Object.assign({}, ...[].concat(verifiedClaims ?? []))

/**
 * Whole years by calendar arithmetic. `(now - birth) / 365.25 days` is off by a
 * day around the birthday — the single date on which an 18+ check changes its
 * answer, so it is the one case worth getting exactly right.
 */
export function ageFrom(birthdate, on = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(birthdate ?? ''))
  if (!m) return null
  const [y, mo, d] = m.slice(1).map(Number)
  const age = on.getFullYear() - y
  const beforeBirthday = on.getMonth() + 1 < mo || (on.getMonth() + 1 === mo && on.getDate() < d)
  return beforeBirthday ? age - 1 : age
}
