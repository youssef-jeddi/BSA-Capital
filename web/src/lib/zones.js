/** Zone helpers shared by the manager picker and the investor gate. */

export const ZONE_LABELS = { EU: 'European Union', CH: 'Switzerland', US: 'United States' }

export const zoneLabel = (code) => ZONE_LABELS[code] ?? code

/**
 * A vault gated to zones admits anyone holding a credential for ANY of them:
 * its permissioned domain accepts all the corresponding credential types.
 */
export function zoneAccess(vaultZones, heldZones) {
  const required = vaultZones ?? []
  if (!required.length) return { gated: false, allowed: true, missing: [] }

  const accepted = (heldZones ?? []).filter((z) => z.accepted).map((z) => z.zone)
  const allowed = required.some((z) => accepted.includes(z))
  return {
    gated: true,
    allowed,
    missing: required.filter((z) => !accepted.includes(z)),
    // Issued but not yet accepted: the investor only needs to sign.
    pending: (heldZones ?? []).filter((z) => !z.accepted && required.includes(z.zone)).map((z) => z.zone),
  }
}

export const describeZones = (zones) =>
  !zones?.length ? 'Open to everyone' : zones.map(zoneLabel).join(' or ')
