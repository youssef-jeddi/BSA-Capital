/** Business rules for super vaults. */
import * as supers from '../repositories/superVaults.js'
import * as vaults from '../repositories/vaults.js'
import * as companies from '../repositories/companies.js'
import { validateAddress, collect } from '../validation/profiles.js'
import { validateAllocations, validateMaturityCascade, validateFundingWindow } from '../validation/allocations.js'

const fail = (status, ...errors) => ({ ok: false, status, errors: errors.flat() })
const ok = (data) => ({ ok: true, data })
const isLedgerId = (v) => typeof v === 'string' && /^[0-9A-Fa-f]{64}$/.test(v)
const clean = (v) => (typeof v === 'string' ? v.trim() : null) || null

export function createSuperVault(input) {
  const allocations = input.allocations ?? []
  const errors = collect(
    isLedgerId(input.vault_id) ? null : 'vault_id must be 64 hexadecimal characters',
    validateAddress(input.curator_address),
    clean(input.name) ? null : 'name is required',
    validateAddress(input.deployment_address),
    clean(input.deployment_address) === clean(input.curator_address)
      ? 'The deployment account must differ from the curator: a LoanSet with Account equal to Counterparty is rejected'
      : null,
    validateAllocations(allocations),
  )
  if (errors.length) return fail(400, errors)

  const curator = clean(input.curator_address)
  if (!companies.findByAddress(curator)) {
    return fail(403, 'Only a registered company can curate a super vault.')
  }

  // Every sub-vault must be indexed, otherwise we cannot read its maturity.
  const subVaults = []
  for (const a of allocations) {
    const sub = vaults.findById(a.sub_vault_id.toUpperCase())
    if (!sub) return fail(400, `Sub-vault ${a.sub_vault_id.slice(0, 8)} is not listed on the platform.`)
    if (sub.vault_id === input.vault_id.toUpperCase()) return fail(400, 'A super vault cannot allocate to itself.')
    subVaults.push(sub)
  }

  const cascade = validateMaturityCascade({
    superRedemption: input.redemption_date ?? null,
    loanMaturity: input.loan_maturity ?? null,
    subVaults,
  })
  if (cascade.length) return fail(400, cascade)

  const window = validateFundingWindow({
    superSubscription: input.subscription_date ?? null,
    subVaults,
  })
  if (window.length) return fail(400, window)

  if (supers.findById(input.vault_id.toUpperCase())) {
    return ok(supers.findById(input.vault_id.toUpperCase()))
  }

  return ok(supers.insert({
    vault_id: input.vault_id.toUpperCase(),
    curator_address: curator,
    deployment_address: clean(input.deployment_address),
    loan_broker_id: clean(input.loan_broker_id)?.toUpperCase() ?? null,
    name: clean(input.name),
    strategy: clean(input.strategy),
    subscription_date: input.subscription_date ?? null,
    redemption_date: input.redemption_date ?? null,
    loan_maturity: input.loan_maturity ?? null,
  }, allocations.map((a) => ({
    sub_vault_id: a.sub_vault_id.toUpperCase(),
    target_bps: Number(a.target_bps),
  }))))
}

export function markDeployed(vaultId, loanId) {
  if (!supers.findById(vaultId?.toUpperCase())) return fail(404, 'Super vault not found.')
  if (!isLedgerId(loanId)) return fail(400, 'loan_id must be 64 hexadecimal characters')
  return ok(supers.setDeployed(vaultId.toUpperCase(), loanId.toUpperCase()))
}

export function markAllocationFunded(vaultId, subVaultId, txHash) {
  if (!supers.findById(vaultId?.toUpperCase())) return fail(404, 'Super vault not found.')
  return ok(supers.markAllocationDeposited(vaultId.toUpperCase(), subVaultId.toUpperCase(), clean(txHash)))
}

export const listSuperVaults = (filters) => supers.list(filters)
export const getSuperVault = (id) => supers.findById(id?.toUpperCase())
