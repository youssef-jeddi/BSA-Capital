/**
 * Builders for the XLS-65 / XLS-66 broker flow.
 *
 * Constraints below are enforced by xrpl.js 5.2.0-beta.0 client-side validation
 * (models/transactions/vaultCreate.js, loanBrokerSet.js) — mirroring them here
 * lets the form fail fast instead of at signing time.
 */
import {
  xrpToDrops, unixTimeToRippleTime, VaultCreateFlags,
  encodeMPTokenMetadata, validateMPTokenMetadata,
} from 'xrpl'

export const MIN_INVESTMENT_SECONDS = 180   // RedemptionDate - SubscriptionDate floor
export const VAULT_DATA_MAX_BYTES = 256
export const MPT_META_MAX_BYTES = 1024

// XLS-89. asset_class is a closed set of six; the finer categories are asset_subclass,
// which the validator makes REQUIRED whenever asset_class is 'rwa'.
export const ASSET_CLASSES = ['rwa', 'defi', 'wrapped', 'gaming', 'memes', 'other']
export const ASSET_SUBCLASSES = [
  'private_credit', 'treasury', 'equity', 'commodity', 'real_estate', 'stablecoin', 'other',
]

const enc = new TextEncoder()
export const byteLen = (s) => enc.encode(s).length
export const toHex = (s) =>
  Array.from(enc.encode(s)).map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null))

export function assetOf(f) {
  if (f.assetType === 'XRP') return { currency: 'XRP' }
  if (f.assetType === 'IOU') return { currency: f.iouCurrency, issuer: f.iouIssuer }
  return { mpt_issuance_id: f.mptIssuanceId }
}

/** Amounts are drops for XRP, plain values otherwise. */
export function amountOf(f, value) {
  if (f.assetType === 'XRP') return xrpToDrops(value)
  if (f.assetType === 'IOU') return { currency: f.iouCurrency, issuer: f.iouIssuer, value: String(value) }
  return { mpt_issuance_id: f.mptIssuanceId, value: String(value) }
}

/** Demo lifecycles are expressed in minutes from now, then converted to Ripple time. */
export function lifecycleDates(f) {
  const now = Date.now()
  return {
    subscriptionUnix: now + Number(f.subMinutes) * 60_000,
    redemptionUnix: now + Number(f.redMinutes) * 60_000,
    SubscriptionDate: unixTimeToRippleTime(now + Number(f.subMinutes) * 60_000),
    RedemptionDate: unixTimeToRippleTime(now + Number(f.redMinutes) * 60_000),
  }
}

export function validateForm(f) {
  const errs = []
  if (f.assetType === 'IOU' && (!f.iouCurrency || !f.iouIssuer)) errs.push('IOU needs a currency code and issuer.')
  if (f.assetType === 'MPT' && !f.mptIssuanceId) errs.push('MPT needs an issuance ID.')
  if (!f.ticker || !/^[A-Z0-9]{1,6}$/u.test(f.ticker)) errs.push('Ticker must be 1–6 uppercase letters or digits.')
  if (!f.shareName) errs.push('Share token name is required.')
  if (!f.issuerName) errs.push('Issuer name is required.')
  if (!f.icon) errs.push('Icon URL is required by XLS-89 (the validator rejects an empty icon).')
  if (f.assetClass === 'rwa' && !f.assetSubclass) errs.push("Asset subclass is required when asset class is 'rwa'.")

  if (f.private && !f.domainId) errs.push('A private vault needs a DomainID (the ledger rejects DomainID without tfVaultPrivate, and gating without a domain is pointless).')
  if (f.domainId && !f.private) errs.push('DomainID may only be set on a private vault.')
  if (f.domainId && !/^[0-9A-Fa-f]{64}$/u.test(f.domainId)) errs.push('DomainID must be 64 hex characters.')

  const gap = (Number(f.redMinutes) - Number(f.subMinutes)) * 60
  if (!(gap >= MIN_INVESTMENT_SECONDS)) {
    errs.push(`Investment period must be at least ${MIN_INVESTMENT_SECONDS}s (3 min). Currently ${Math.round(gap)}s.`)
  }
  if (Number(f.subMinutes) <= 0) errs.push('Subscription must end in the future.')

  // Both-or-neither, enforced by the SDK.
  const hasMin = f.coverRateMin !== '' && Number(f.coverRateMin) !== 0
  const hasLiq = f.coverRateLiq !== '' && Number(f.coverRateLiq) !== 0
  if (hasMin !== hasLiq) errs.push('Min cover rate and liquidation rate must both be set or both be empty.')

  if (byteLen(vaultDataJson(f)) > VAULT_DATA_MAX_BYTES) {
    errs.push(`Vault name + website exceed the ${VAULT_DATA_MAX_BYTES}-byte Data limit.`)
  }
  try {
    const meta = encodeMPTokenMetadata(shareMetadata(f))
    if (meta.length / 2 > MPT_META_MAX_BYTES) errs.push(`Share metadata exceeds ${MPT_META_MAX_BYTES} bytes.`)
  } catch (e) { errs.push(`Share metadata: ${e.message}`) }

  return errs
}

export const vaultDataJson = (f) => JSON.stringify(clean({ name: f.vaultName, website: f.website }))

export const shareMetadata = (f) => clean({
  ticker: f.ticker,
  name: f.shareName,
  issuer_name: f.issuerName,
  asset_class: f.assetClass,
  asset_subclass: f.assetClass === 'rwa' ? f.assetSubclass : undefined,
  desc: f.desc,
  icon: f.icon,
})

/**
 * The SDK only console.warns about XLS-89 non-compliance and submits anyway,
 * so surface it in the UI instead of losing it.
 */
export function metadataWarnings(f) {
  try { return validateMPTokenMetadata(encodeMPTokenMetadata(shareMetadata(f))) }
  catch { return [] }
}

export function buildVaultCreate(f, account) {
  const tx = {
    TransactionType: 'VaultCreate',
    Account: account,
    Asset: assetOf(f),
    WithdrawalPolicy: 1, // vaultStrategyFirstComeFirstServe — the only policy defined
    MPTokenMetadata: encodeMPTokenMetadata(shareMetadata(f)),
  }

  let flags = 0
  if (f.private) flags |= VaultCreateFlags.tfVaultPrivate
  if (f.nonTransferable) flags |= VaultCreateFlags.tfVaultShareNonTransferable
  if (flags) tx.Flags = flags
  if (f.private && f.domainId) tx.DomainID = f.domainId.toUpperCase()

  // Track 2: always close-ended. VaultKind=1 makes both dates mandatory.
  const { SubscriptionDate, RedemptionDate } = lifecycleDates(f)
  tx.VaultKind = 1
  tx.SubscriptionDate = SubscriptionDate
  tx.RedemptionDate = RedemptionDate

  const data = vaultDataJson(f)
  if (data !== '{}') tx.Data = toHex(data)
  if (f.capEnabled && f.cap) tx.AssetsMaximum = f.assetType === 'XRP' ? xrpToDrops(f.cap) : String(f.cap)

  return tx
}

export function buildLoanBrokerSet(f, account, vaultId) {
  const tx = { TransactionType: 'LoanBrokerSet', Account: account, VaultID: vaultId }
  if (f.mgmtFee !== '') tx.ManagementFeeRate = Math.round(Number(f.mgmtFee) * 100)      // 10000 = 100%
  if (f.maxDebt !== '') tx.DebtMaximum = f.assetType === 'XRP' ? xrpToDrops(f.maxDebt) : String(f.maxDebt)
  if (f.coverRateMin !== '') tx.CoverRateMinimum = Math.round(Number(f.coverRateMin) * 1000)   // 100000 = 100%
  if (f.coverRateLiq !== '') tx.CoverRateLiquidation = Math.round(Number(f.coverRateLiq) * 1000)
  return tx
}

export const buildCoverDeposit = (f, account, brokerId) => ({
  TransactionType: 'LoanBrokerCoverDeposit',
  Account: account,
  LoanBrokerID: brokerId,
  Amount: amountOf(f, f.firstLoss),
})

/** Pull a newly created ledger entry out of a validated transaction result. */
export function createdEntry(result, type) {
  const node = result?.meta?.AffectedNodes
    ?.map((n) => n.CreatedNode)
    .find((n) => n?.LedgerEntryType === type)
  return node ? { id: node.LedgerIndex, fields: node.NewFields } : null
}
