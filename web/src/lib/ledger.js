/** Read-side helpers. One shared client; the wallet handles all writes. */
import { Client, rippleTimeToUnixTime, dropsToXrp, xrpToDrops, encode } from 'xrpl'
import { cached, invalidate } from './ledgerCache.js'

const WSS = 'wss://s.devnet.rippletest.net:51233/'
let client

export async function ledger() {
  if (!client) client = new Client(WSS)
  if (!client.isConnected()) await client.connect()
  return client
}

/**
 * Phase must be derived from ledger close time, not Date.now(). The ledger is
 * the authority on when a phase flips; wall clock disagrees at the boundary.
 */
export const ledgerNowMs = () => cached('now', async () => {
  const c = await ledger()
  const r = await c.request({ command: 'ledger', ledger_index: 'validated' })
  return rippleTimeToUnixTime(r.result.ledger.close_time)
})

export const PHASES = ['Subscription', 'Investment', 'Redemption']

/** Official XLS-65 close-ended phase/action table. */
export const PHASE_RULES = {
  Subscription: { deposit: true,  withdraw: true,  lend: false, note: 'Deposits and withdrawals allowed. Lending blocked.' },
  Investment:   { deposit: false, withdraw: false, lend: true,  note: 'Capital locked. Loan origination, repayment and management only.' },
  Redemption:   { deposit: false, withdraw: true,  lend: false, note: 'Withdrawals and loan servicing. No new loans.' },
}

export function phaseOf(vault, nowMs) {
  const sub = rippleTimeToUnixTime(vault.SubscriptionDate)
  const red = rippleTimeToUnixTime(vault.RedemptionDate)
  if (nowMs < sub) return { phase: 'Subscription', endsAt: sub }
  if (nowMs < red) return { phase: 'Investment', endsAt: red }
  return { phase: 'Redemption', endsAt: null }
}

export const fetchVault = (vaultId) => cached(`vault:${vaultId}`, async () => {
  const c = await ledger()
  const vault = (await c.request({ command: 'ledger_entry', index: vaultId })).result.node
  const issuance = (await c.request({ command: 'ledger_entry', mpt_issuance: vault.ShareMPTID })).result.node
  return { vault, issuance }
})

export const fetchPosition = (address, shareMPTID) => cached(`pos:${address}:${shareMPTID}`, async () => {
  const c = await ledger()
  try {
    const r = await c.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: shareMPTID, account: address },
    })
    return r.result.node
  } catch {
    return null // no MPToken object = never deposited
  }
})

export const isXrpVault = (vault) => vault.Asset?.currency === 'XRP' && !vault.Asset?.issuer

/** Vault.AssetsTotal is in drops for an XRP vault. */
export const assetToDisplay = (vault, raw) =>
  raw == null ? '0' : isXrpVault(vault) ? dropsToXrp(raw).toString() : String(raw)

/** Build the Amount field for a deposit/withdraw denominated in the vault asset. */
export function assetAmount(vault, value) {
  const a = vault.Asset
  if (a.mpt_issuance_id) return { mpt_issuance_id: a.mpt_issuance_id, value: String(value) }
  if (a.issuer) return { currency: a.currency, issuer: a.issuer, value: String(value) }
  return xrpToDrops(value)
}

/** Price per share, in asset units per share. Shares are integers. */
export function pricePerShare(vault, issuance) {
  const shares = Number(issuance?.OutstandingAmount ?? 0)
  if (!shares) return null
  return Number(vault.AssetsTotal ?? 0) / shares
}

export function decodeData(hex) {
  if (!hex) return null
  try {
    const s = new TextDecoder().decode(Uint8Array.from(hex.match(/../g).map((b) => parseInt(b, 16))))
    return JSON.parse(s)
  } catch { return null }
}

export const countdown = (ms) => {
  if (ms == null) return '—'
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
}

/* ── loans (XLS-66) ─────────────────────────────────── */

export const LOAN_FLAGS = { lsfLoanDefault: 0x00010000, lsfLoanImpaired: 0x00020000, lsfLoanOverpayment: 0x00040000 }

export const loanState = (loan) =>
  loan.Flags & LOAN_FLAGS.lsfLoanDefault ? 'defaulted'
  : loan.Flags & LOAN_FLAGS.lsfLoanImpaired ? 'impaired'
  : 'current'

export async function fetchObjects(account, type) {
  const c = await ledger()
  try {
    const r = await c.request({ command: 'account_objects', account, type, ledger_index: 'validated' })
    return r.result.account_objects ?? []
  } catch { return [] }
}

export const fetchLoans = (account) => fetchObjects(account, 'loan')
export const fetchBrokers = (account) => fetchObjects(account, 'loan_broker')

export async function fetchBroker(brokerId) {
  const c = await ledger()
  const broker = (await c.request({ command: 'ledger_entry', index: brokerId })).result.node
  const { vault, issuance } = await fetchVault(broker.VaultID)
  return { broker, vault, issuance }
}

/** Rates are stored as integers: 100000 = 100%. */
export const rateToPct = (r) => (r == null ? null : r / 1000)

/**
 * Submit an already fully-signed transaction. Needed for the two-party LoanSet:
 * with signature_target set the wallet signs but does not submit.
 */
/**
 * A validity window wide enough for a human to switch wallet accounts.
 *
 * xrpl.js autofill sets LastLedgerSequence to current + 20, about 80 seconds.
 * That is right for sign-and-send, and wrong for every two-party transaction
 * here: the first party signs, the blob is parked, and the second party signs
 * and submits minutes later. The window closes in between and the ledger
 * answers tefPAST_SEQ. The field is covered by the signature, so it has to be
 * set before anyone signs — it cannot be refreshed afterwards.
 *
 * Wide, not absent. An unbounded transaction can be submitted forever by
 * anyone holding the blob; ten minutes is enough for the handoff and no more.
 */
export const HANDOFF_LEDGERS = 150      // ~4s per ledger, so roughly 10 minutes

export async function withHandoffWindow(tx) {
  const c = await ledger()
  const index = await c.getLedgerIndex()
  return { ...tx, LastLedgerSequence: index + HANDOFF_LEDGERS }
}

/** Whether a parked signature is still submittable, so we can say so first. */
export async function handoffExpiry(tx_json) {
  const last = Number(tx_json?.LastLedgerSequence)
  if (!last) return { expired: false, ledgersLeft: null }
  const c = await ledger()
  const index = await c.getLedgerIndex()
  return { expired: index > last, ledgersLeft: last - index, index, last }
}

export async function submitSigned(tx_json) {
  const c = await ledger()
  const r = await c.submitAndWait(encode(tx_json))
  invalidate()   // anything on-chain may have moved
  return r.result
}
