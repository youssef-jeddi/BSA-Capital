/** Business rules for the vault index. */
import * as vaults from '../repositories/vaults.js'
import * as companies from '../repositories/companies.js'
import { validateAddress, collect } from '../validation/profiles.js'
import { validateZones } from '../lib/zones.js'

const fail = (status, ...errors) => ({ ok: false, status, errors: errors.flat() })
const ok = (data) => ({ ok: true, data })

const isLedgerId = (v) => typeof v === 'string' && /^[0-9A-Fa-f]{64}$/.test(v)
const clean = (v) => (typeof v === 'string' ? v.trim() : null) || null
const toInt = (v) => (v == null || v === '' ? null : Number(v))

export function recordVault(input) {
  const errors = collect(
    isLedgerId(input.vault_id) ? null : 'vault_id must be 64 hexadecimal characters',
    validateAddress(input.company_address),
    input.loan_broker_id && !isLedgerId(input.loan_broker_id)
      ? 'loan_broker_id must be 64 hexadecimal characters' : null,
    clean(input.name) ? null : 'name is required',
    validateZones(input.zones ?? []),
  )
  if (errors.length) return fail(400, errors)

  const address = clean(input.company_address)
  if (!companies.findByAddress(address)) {
    return fail(403, 'Only a registered company can list a vault.')
  }
  if (vaults.findById(input.vault_id.toUpperCase())) {
    return ok(vaults.findById(input.vault_id.toUpperCase())) // idempotent re-post
  }

  return ok(vaults.insert({
    vault_id: input.vault_id.toUpperCase(),
    company_address: address,
    loan_broker_id: clean(input.loan_broker_id)?.toUpperCase() ?? null,
    share_mpt_id: clean(input.share_mpt_id)?.toUpperCase() ?? null,
    name: clean(input.name),
    activity: clean(input.activity),
    asset_code: clean(input.asset_code) ?? 'XRP',
    subscription_date: toInt(input.subscription_date),
    redemption_date: toInt(input.redemption_date),
    is_private: input.is_private ? 1 : 0,
    zones: input.zones?.length ? JSON.stringify([...new Set(input.zones)].sort()) : null,
    domain_id: clean(input.domain_id)?.toUpperCase() ?? null,
    tx_hash: clean(input.tx_hash),
  }))
}

export const listVaults = (filters) => vaults.list(filters)
export const getVault = (vaultId) => vaults.findById(vaultId?.toUpperCase())
