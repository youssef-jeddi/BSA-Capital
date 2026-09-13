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

/**
 * Target APY is stored in the ledger's own rate unit, 1/10th bps, so 1000 is 1%
 * and 100000 is 100% a year — the ceiling XLS-66 puts on InterestRate. A fund
 * cannot honestly advertise more than the loans inside it are allowed to charge.
 */
export const MAX_TARGET_APY = 100000
const validateTargetApy = (v) => {
  if (v == null || v === '') return null
  const n = Number(v)
  if (!Number.isInteger(n) || n < 0 || n > MAX_TARGET_APY) {
    return `target_apy must be a whole number between 0 and ${MAX_TARGET_APY} (100% annual, the ledger's InterestRate ceiling)`
  }
  return null
}

export function recordVault(input) {
  const errors = collect(
    isLedgerId(input.vault_id) ? null : 'vault_id must be 64 hexadecimal characters',
    validateAddress(input.company_address),
    input.loan_broker_id && !isLedgerId(input.loan_broker_id)
      ? 'loan_broker_id must be 64 hexadecimal characters' : null,
    clean(input.name) ? null : 'name is required',
    validateTargetApy(input.target_apy),
    validateZones(input.zones ?? []),
  )
  if (errors.length) return fail(400, errors)

  const address = clean(input.company_address)
  if (!companies.findByAddress(address)) {
    return fail(403, 'Only a registered company can list a vault.')
  }
  // A re-post completes the record rather than being dropped. The broker id only
  // exists after LoanBrokerSet, which runs after the first post, so treating the
  // second post as a no-op left every UI-created fund with no broker and made it
  // impossible to borrow from.
  const existing = vaults.findById(input.vault_id.toUpperCase())
  if (existing) {
    return ok(vaults.fillMissing(input.vault_id.toUpperCase(), {
      loan_broker_id: clean(input.loan_broker_id)?.toUpperCase() ?? null,
      share_mpt_id: clean(input.share_mpt_id)?.toUpperCase() ?? null,
      domain_id: clean(input.domain_id)?.toUpperCase() ?? null,
      tx_hash: clean(input.tx_hash),
      target_apy: toInt(input.target_apy),
    }))
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
    target_apy: toInt(input.target_apy),
  }))
}

export const listVaults = (filters) => vaults.list(filters)
export const getVault = (vaultId) => vaults.findById(vaultId?.toUpperCase())
