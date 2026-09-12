/**
 * Rolling a closed fund into its next series.
 *
 * A close-ended vault cannot be restarted: Redemption is terminal and the
 * phase dates are immutable. The real-world equivalent is launching Fund II,
 * so this carries a finished vault's configuration into a fresh creation form
 * with only the dates left to choose.
 */
import { decodeMPTokenMetadata, dropsToXrp } from 'xrpl'

const KEY = 'bsa_relaunch_draft'

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII']

/** "Credit Fund I" -> "Credit Fund II", "Series 2" -> "Series 3", else append II. */
export function nextSeriesName(name = '') {
  const trimmed = name.trim()

  const roman = trimmed.match(/^(.*?)\s+([IVX]+)$/)
  if (roman) {
    const index = ROMAN.indexOf(roman[2].toUpperCase())
    if (index >= 0 && index + 1 < ROMAN.length) return `${roman[1]} ${ROMAN[index + 1]}`
  }

  const numeric = trimmed.match(/^(.*?)(\d+)$/)
  if (numeric) return `${numeric[1]}${Number(numeric[2]) + 1}`

  const letter = trimmed.match(/^(.*?\bSeries)\s+([A-Y])$/i)
  if (letter) return `${letter[1]} ${String.fromCharCode(letter[2].toUpperCase().charCodeAt(0) + 1)}`

  return `${trimmed} II`
}

const decodeMeta = (issuance) => {
  try { return issuance?.MPTokenMetadata ? decodeMPTokenMetadata(issuance.MPTokenMetadata) : null }
  catch { return null }
}

/** Everything worth carrying forward from a finished fund. Dates deliberately omitted. */
export function draftFromVault(entry) {
  const meta = decodeMeta(entry.issuance)
  const cap = entry.vault?.AssetsMaximum
  return {
    kind: entry.kind === 'super' ? 'super' : 'fund',
    sourceVaultId: entry.vault_id,
    name: nextSeriesName(entry.name),
    activity: entry.company_activity ?? '',
    strategy: entry.strategy ?? '',
    assetCode: entry.asset_code ?? 'XRP',
    cap: cap && Number(cap) > 0 ? String(dropsToXrp(String(cap))) : '',
    isPrivate: !!entry.is_private,
    domainId: entry.vault?.DomainID ?? '',
    ticker: meta?.ticker ?? meta?.t ?? '',
    issuerName: meta?.issuer_name ?? meta?.in ?? '',
    assetClass: meta?.asset_class ?? meta?.ac ?? 'rwa',
    assetSubclass: meta?.asset_subclass ?? meta?.as ?? 'private_credit',
    desc: meta?.desc ?? meta?.d ?? '',
    icon: meta?.icon ?? meta?.i ?? '',
    allocations: (entry.positions ?? []).map((p) => ({
      sub_vault_id: p.sub_vault_id, target_bps: p.target_bps,
    })),
    deployment: entry.deployment_address ?? '',
  }
}

export function stageRelaunch(draft) {
  try { sessionStorage.setItem(KEY, JSON.stringify(draft)) } catch { /* private mode */ }
}

/** Read once and clear, so a reload does not silently reapply an old draft. */
export function takeRelaunch(kind) {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (!raw) return null
    const draft = JSON.parse(raw)
    if (kind && draft.kind !== kind) return null
    sessionStorage.removeItem(KEY)
    return draft
  } catch { return null }
}
