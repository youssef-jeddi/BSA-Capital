/**
 * The regulatory zones the platform gates on.
 *
 * A manager chooses which zones may invest in their vault; an investor needs a
 * credential for one of them. Keeping this list here, rather than letting
 * managers invent domains, is the point: the platform runs compliance, not
 * each fund.
 */
export const ZONES = [
  { code: 'EU', label: 'European Union', credentialType: 'ZONE_EU' },
  { code: 'CH', label: 'Switzerland', credentialType: 'ZONE_CH' },
  { code: 'US', label: 'United States', credentialType: 'ZONE_US' },
]

export const ZONE_CODES = ZONES.map((z) => z.code)
export const zoneByCode = (code) => ZONES.find((z) => z.code === code) ?? null
export const toHex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()

/** Canonical key for a set of zones, order-independent. */
export const comboKey = (zones) => [...new Set(zones)].sort().join('+')

/** Every non-empty subset, so any manager choice already has a domain. */
export function allCombos(codes = ZONE_CODES) {
  const out = []
  for (let mask = 1; mask < 1 << codes.length; mask += 1) {
    out.push(codes.filter((_, i) => mask & (1 << i)))
  }
  return out.sort((a, b) => a.length - b.length || comboKey(a).localeCompare(comboKey(b)))
}

export function validateZones(zones) {
  if (!Array.isArray(zones)) return ['zones must be an array']
  const bad = zones.filter((z) => !ZONE_CODES.includes(z))
  return bad.length ? [`Unknown zone(s): ${bad.join(', ')}`] : []
}
