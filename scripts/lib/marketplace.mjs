/**
 * Secondary market for locked vault shares.
 *
 * A closed-ended vault freezes its LPs during the Investment phase — `VaultWithdraw`
 * returns `tecTOO_SOON` — but the share MPT itself still moves. So an LP who needs
 * liquidity sends shares to a custody account, we list them, and a buyer takes them
 * at whatever discount to NAV the seller accepted. Proven on Devnet by
 * `scripts/20-share-transfer-spike.mjs`.
 *
 * The gate that makes this compliant is not ours. To receive private-vault shares an
 * account needs BOTH an accepted credential in the vault's domain AND its own
 * `MPTokenAuthorize` opt-in; the ledger refuses anything else with `tecNO_AUTH`. The
 * share issuer is the vault's keyless pseudo-account, so domain membership is what
 * stands in for issuer authorization — there is no issuer-side authorize to perform.
 *
 * Opt-in is permissionless, so an existing MPToken object proves nothing about
 * eligibility. We check credentials explicitly rather than inferring them.
 */
import { Wallet, rippleTimeToUnixTime } from 'xrpl'
import fs from 'node:fs'
import path from 'node:path'
import { ledger, master, toHex, CREDENTIAL_TYPE } from './issuer.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')
const STORE = path.join(ROOT, 'data/listings.json')
const LSF_ACCEPTED = 0x00010000

export function custody() {
  const seed = process.env.CUSTODY_SEED
  if (!seed) throw new Error('CUSTODY_SEED missing from .env — run: node scripts/21-setup-custody.mjs')
  return Wallet.fromSeed(seed)
}

/**
 * Submit and never throw; ledger codes are information, not exceptions.
 *
 * `submitAndWait` can throw *after* the transaction has already applied — a dropped
 * websocket or an expired LastLedgerSequence while it still made it into a ledger. In
 * a marketplace that is the worst possible ambiguity: shares move but no listing is
 * recorded, and they are stranded in custody. The signature fixes the hash before
 * submission, so on any error we ask the ledger what actually happened rather than
 * assuming failure.
 */
export async function submit(wallet, tx) {
  const c = await ledger()
  const signed = wallet.sign(await c.autofill(tx))
  try {
    const res = await c.submitAndWait(signed.tx_blob)
    const code = res.result.meta?.TransactionResult
    return { ok: code === 'tesSUCCESS', code, hash: res.result.hash, result: res.result }
  } catch (e) {
    const msg = e.data?.error_message ?? e.message
    const landed = await lookUp(signed.hash)
    if (landed) return { ...landed, recovered: true }
    return { ok: false, code: /\b(te[cflms][A-Z_]+)/.exec(msg)?.[1] ?? 'REJECTED', error: msg, hash: signed.hash }
  }
}

/** Did this hash land? Retried, because validation lags the throw. */
async function lookUp(hash, tries = 4) {
  const c = await ledger()
  for (let i = 0; i < tries; i++) {
    try {
      const r = (await c.request({ command: 'tx', transaction: hash })).result
      const code = (r.meta ?? r.metaData)?.TransactionResult
      if (code) return { ok: code === 'tesSUCCESS', code, hash, result: r }
    } catch { /* not found yet */ }
    await new Promise((r) => setTimeout(r, 2000))
  }
  return null
}

/**
 * Shares sitting in custody with no open listing — the residue of exactly the failure
 * above. Surfaced so they can be returned rather than silently lost.
 */
export async function strandedShares(shareMPTID) {
  const c = await ledger()
  let held = 0
  try {
    const t = (await c.request({
      command: 'ledger_entry', mptoken: { mpt_issuance_id: shareMPTID, account: custody().address },
    })).result.node
    held = Number(t.MPTAmount ?? 0)
  } catch { return { held: 0, listed: 0, stranded: 0 } }
  const listed = listings()
    .filter((l) => l.shareMPTID === shareMPTID && l.status === 'open')
    .reduce((n, l) => n + Number(l.shares), 0)
  return { held, listed, stranded: held - listed }
}

export const sharesAmount = (mptIssuanceId, value) => ({ mpt_issuance_id: mptIssuanceId, value: String(value) })

/** Vault, share issuance, NAV in drops per share, and the live phase. */
export async function vaultSnapshot(vaultId) {
  const c = await ledger()
  const vault = (await c.request({ command: 'ledger_entry', index: vaultId })).result.node
  if (vault.LedgerEntryType !== 'Vault') throw new Error(`${vaultId} is not a Vault`)
  const issuance = (await c.request({ command: 'ledger_entry', mpt_issuance: vault.ShareMPTID })).result.node

  const lgr = (await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger
  const nowMs = rippleTimeToUnixTime(lgr.close_time)
  const sub = vault.SubscriptionDate ? rippleTimeToUnixTime(vault.SubscriptionDate) : null
  const red = vault.RedemptionDate ? rippleTimeToUnixTime(vault.RedemptionDate) : null
  const phase = sub === null ? 'Open' : nowMs < sub ? 'Subscription' : nowMs < red ? 'Investment' : 'Redemption'

  const outstanding = Number(issuance.OutstandingAmount ?? 0)
  return {
    vaultId,
    shareMPTID: vault.ShareMPTID,
    domainID: issuance.DomainID ?? null,
    pseudoAccount: vault.Account,
    assetsTotal: vault.AssetsTotal,
    assetsAvailable: vault.AssetsAvailable,
    outstanding: issuance.OutstandingAmount,
    // NAV per share. Vault asset is XRP in our vaults, so the unit is drops.
    navDrops: outstanding ? Number(vault.AssetsTotal ?? 0) / outstanding : null,
    phase, nowMs, subscriptionMs: sub, redemptionMs: red,
    transferable: (Number(issuance.Flags ?? 0) & 0x0020) !== 0,
  }
}

/** Credentials the domain accepts, as `${Issuer}:${CredentialType}` keys. */
async function acceptedByDomain(domainID) {
  const c = await ledger()
  const dom = (await c.request({ command: 'ledger_entry', index: domainID })).result.node
  return new Set((dom.AcceptedCredentials ?? [])
    .map(({ Credential: cr }) => `${cr.Issuer}:${cr.CredentialType}`))
}

/**
 * Can `account` receive these shares? Both conditions must hold, and neither is
 * implied by the other — opt-in is permissionless, credentials are not.
 */
export async function eligibility(account, shareMPTID, domainID) {
  const c = await ledger()

  let optedIn = false
  try {
    await c.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: shareMPTID, account } })
    optedIn = true
  } catch { /* no MPToken object yet */ }

  if (!domainID) return { credentialed: true, optedIn, ready: optedIn, public: true }

  const accepted = await acceptedByDomain(domainID)
  let credentialed = false
  try {
    const r = await c.request({ command: 'account_objects', account, type: 'credential' })
    credentialed = r.result.account_objects.some((o) =>
      (o.Flags & LSF_ACCEPTED) !== 0 && accepted.has(`${o.Issuer}:${o.CredentialType}`))
  } catch { /* unfunded account holds nothing */ }

  return { credentialed, optedIn, ready: credentialed && optedIn, public: false }
}

/** Custody must opt in before a seller can send it shares. Idempotent. */
export async function ensureCustodyOptedIn(shareMPTID) {
  const cust = custody()
  const { optedIn } = await eligibility(cust.address, shareMPTID, null)
  if (optedIn) return { already: true }
  const r = await submit(cust, {
    TransactionType: 'MPTokenAuthorize', Account: cust.address, MPTokenIssuanceID: shareMPTID,
  })
  if (!r.ok) throw new Error(`custody MPTokenAuthorize ${r.code}`)
  return { already: false, hash: r.hash }
}

/**
 * Confirm on-ledger that a claimed transfer really happened, before trusting it.
 * The browser reports a hash; the ledger decides whether it means anything.
 */
export async function verifyShareTransfer(hash, { destination, shareMPTID, shares }) {
  const c = await ledger()
  const tx = (await c.request({ command: 'tx', transaction: hash })).result
  const json = tx.tx_json ?? tx
  const amount = json.Amount ?? json.DeliverMax
  const ok = (tx.meta ?? tx.metaData)?.TransactionResult === 'tesSUCCESS'
    && json.TransactionType === 'Payment'
    && json.Destination === destination
    && amount?.mpt_issuance_id === shareMPTID
    && String(amount?.value) === String(shares)
  if (!ok) throw new Error(`tx ${hash} is not a ${shares}-share payment to ${destination}`)
  return { seller: json.Account }
}

/** Same, for the buyer's XRP leg. */
export async function verifyXrpPayment(hash, { destination, drops }) {
  const c = await ledger()
  const tx = (await c.request({ command: 'tx', transaction: hash })).result
  const json = tx.tx_json ?? tx
  const paid = Number(json.Amount ?? json.DeliverMax)
  const ok = (tx.meta ?? tx.metaData)?.TransactionResult === 'tesSUCCESS'
    && json.TransactionType === 'Payment'
    && json.Destination === destination
    && typeof (json.Amount ?? json.DeliverMax) === 'string'
    && paid >= Number(drops)
  if (!ok) throw new Error(`tx ${hash} is not a payment of >= ${drops} drops to ${destination}`)
  return { buyer: json.Account, paid }
}

// ── listing store ────────────────────────────────────────
// Off-ledger, because a listing is an intent, not ledger state. Every leg that
// moves value is a transaction and is recorded here by hash.

const read = () => {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')) } catch { return [] }
}
const write = (rows) => {
  fs.mkdirSync(path.dirname(STORE), { recursive: true })
  fs.writeFileSync(STORE, JSON.stringify(rows, null, 2))
}

export const listings = () => read()
export const listing = (id) => read().find((l) => l.id === id) ?? null

export function saveListing(row) {
  const rows = read()
  const i = rows.findIndex((l) => l.id === row.id)
  if (i >= 0) rows[i] = row; else rows.push(row)
  write(rows)
  return row
}

/** Records a listing whose share transfer to custody is already confirmed. */
export async function createListing({ vaultId, shares, askDrops, transferHash }) {
  const snap = await vaultSnapshot(vaultId)
  const { seller } = await verifyShareTransfer(transferHash, {
    destination: custody().address, shareMPTID: snap.shareMPTID, shares,
  })
  return saveListing({
    id: transferHash.slice(0, 16),
    vaultId, shareMPTID: snap.shareMPTID, domainID: snap.domainID,
    seller, shares: String(shares), askDrops: String(askDrops),
    navAtListing: snap.navDrops, phaseAtListing: snap.phase,
    status: 'open', createdAt: new Date().toISOString(), transferHash,
  })
}

/** Buyer has paid the seller; custody releases the shares. */
export async function settleListing(id, { paymentHash }) {
  const row = listing(id)
  if (!row) throw new Error(`no listing ${id}`)
  if (row.status !== 'open') throw new Error(`listing ${id} is ${row.status}`)

  const { buyer } = await verifyXrpPayment(paymentHash, {
    destination: row.seller, drops: row.askDrops,
  })

  // Check before moving: a tecNO_AUTH here would leave the buyer paid and empty-handed.
  const el = await eligibility(buyer, row.shareMPTID, row.domainID)
  if (!el.ready) {
    throw new Error(`buyer ${buyer} cannot receive shares (credentialed=${el.credentialed} optedIn=${el.optedIn})`)
  }

  const r = await submit(custody(), {
    TransactionType: 'Payment', Account: custody().address, Destination: buyer,
    Amount: sharesAmount(row.shareMPTID, row.shares),
  })
  if (!r.ok) throw new Error(`share delivery ${r.code}`)
  return saveListing({ ...row, status: 'sold', buyer, paymentHash, deliveryHash: r.hash,
    soldAt: new Date().toISOString() })
}

/** Seller changed their mind; custody returns the shares. */
export async function cancelListing(id) {
  const row = listing(id)
  if (!row) throw new Error(`no listing ${id}`)
  if (row.status !== 'open') throw new Error(`listing ${id} is ${row.status}`)
  const r = await submit(custody(), {
    TransactionType: 'Payment', Account: custody().address, Destination: row.seller,
    Amount: sharesAmount(row.shareMPTID, row.shares),
  })
  if (!r.ok) throw new Error(`share return ${r.code}`)
  return saveListing({ ...row, status: 'cancelled', returnHash: r.hash, cancelledAt: new Date().toISOString() })
}

export { CREDENTIAL_TYPE, toHex, master }
