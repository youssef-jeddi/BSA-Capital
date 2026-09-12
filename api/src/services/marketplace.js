/**
 * Secondary market for locked vault shares.
 *
 * During Investment an LP cannot redeem — VaultWithdraw returns tecTOO_SOON — but the
 * share MPT still transfers. So the position has a computable NAV and no exit, and can
 * instead be sold at a discount to a buyer the LEDGER considers eligible.
 *
 * Settlement: seller pays shares to custody, buyer pays the seller DIRECTLY, custody
 * releases the shares. Custody never touches cash.
 */
import { rippleTimeToUnixTime } from 'xrpl'
import * as listings from '../repositories/listings.js'
import { ZONES, toHex } from '../lib/zones.js'
import { publicAdmin } from './platformAdmin.js'
import { custodyWallet, ensureCustodyOptedIn, publicCustody, submit, withLedger } from './custody.js'

const fail = (status, ...errors) => ({ ok: false, status, errors: errors.flat() })
const ok = (data) => ({ ok: true, data })

const LSF_ACCEPTED = 0x00010000
const LSF_MPT_CAN_TRANSFER = 0x0020

export const sharesAmount = (mpt_issuance_id, value) => ({ mpt_issuance_id, value: String(value) })

/** Vault, share issuance, live NAV in drops per share, and the phase. Never cached. */
export async function vaultSnapshot(client, vaultId) {
  const vault = (await client.request({ command: 'ledger_entry', index: vaultId })).result.node
  if (vault.LedgerEntryType !== 'Vault') throw new Error(`${vaultId} is not a Vault`)
  const issuance = (await client.request({ command: 'ledger_entry', mpt_issuance: vault.ShareMPTID })).result.node

  const lgr = (await client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger
  const nowMs = rippleTimeToUnixTime(lgr.close_time)
  const sub = vault.SubscriptionDate ? rippleTimeToUnixTime(vault.SubscriptionDate) : null
  const red = vault.RedemptionDate ? rippleTimeToUnixTime(vault.RedemptionDate) : null
  const phase = sub === null ? 'Open' : nowMs < sub ? 'Subscription' : nowMs < red ? 'Investment' : 'Redemption'
  const outstanding = Number(issuance.OutstandingAmount ?? 0)

  return {
    vault_id: vaultId,
    share_mpt_id: vault.ShareMPTID,
    domain_id: issuance.DomainID ?? null,
    assets_total: vault.AssetsTotal ?? '0',
    outstanding: issuance.OutstandingAmount ?? '0',
    nav_drops: outstanding ? Number(vault.AssetsTotal ?? 0) / outstanding : null,
    phase, now_ms: nowMs, subscription_ms: sub, redemption_ms: red,
    transferable: (Number(issuance.Flags ?? 0) & LSF_MPT_CAN_TRANSFER) !== 0,
    locked: phase === 'Investment',
  }
}

/** The credentials a domain accepts, as `${Issuer}:${CredentialType}` keys. */
async function acceptedByDomain(client, domainId) {
  const dom = (await client.request({ command: 'ledger_entry', index: domainId })).result.node
  return new Set((dom.AcceptedCredentials ?? [])
    .map(({ Credential: cr }) => `${cr.Issuer}:${cr.CredentialType}`))
}

/**
 * Can this account RECEIVE these shares? Two independent gates.
 *
 * MPTokenAuthorize is permissionless — an uncredentialed account can opt in
 * successfully and only the payment is refused. So an existing MPToken proves
 * nothing about eligibility; the credential is checked explicitly, never inferred.
 */
export async function eligibility(client, account, shareMptId, domainId) {
  let optedIn = false
  try {
    await client.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: shareMptId, account } })
    optedIn = true
  } catch { /* no MPToken object */ }

  if (!domainId) return { credentialed: true, opted_in: optedIn, ready: optedIn, public: true, missing_zones: [] }

  const accepted = await acceptedByDomain(client, domainId)
  const held = await client.request({ command: 'account_objects', account, type: 'credential' })
    .then((r) => r.result.account_objects ?? []).catch(() => [])

  const credentialed = held.some((o) =>
    (o.Flags & LSF_ACCEPTED) !== 0 && accepted.has(`${o.Issuer}:${o.CredentialType}`))

  // Which of OUR zones would satisfy this domain, so the UI can route to the zone flow.
  const admin = publicAdmin()
  const missing = ZONES
    .filter((z) => accepted.has(`${admin.address}:${toHex(z.credentialType)}`))
    .filter((z) => !held.some((o) =>
      (o.Flags & LSF_ACCEPTED) !== 0 && o.Issuer === admin.address && o.CredentialType === toHex(z.credentialType)))
    .map((z) => z.code)

  return { credentialed, opted_in: optedIn, ready: credentialed && optedIn, public: false, missing_zones: missing }
}

/** Confirm on-ledger that a claimed transfer happened. A browser's hash is a claim. */
async function verifyShareTransfer(client, hash, { destination, shareMptId, shares }) {
  const tx = (await client.request({ command: 'tx', transaction: hash })).result
  const json = tx.tx_json ?? tx
  const amount = json.Amount ?? json.DeliverMax
  const good = (tx.meta ?? tx.metaData)?.TransactionResult === 'tesSUCCESS'
    && json.TransactionType === 'Payment'
    && json.Destination === destination
    && amount?.mpt_issuance_id === shareMptId
    && String(amount?.value) === String(shares)
  if (!good) throw new Error(`Transaction ${hash.slice(0, 12)}… is not a ${shares}-share payment to custody`)
  return { seller: json.Account }
}

async function verifyXrpPayment(client, hash, { destination, drops, notBefore }) {
  const tx = (await client.request({ command: 'tx', transaction: hash })).result
  const json = tx.tx_json ?? tx
  const raw = json.Amount ?? json.DeliverMax
  const good = (tx.meta ?? tx.metaData)?.TransactionResult === 'tesSUCCESS'
    && json.TransactionType === 'Payment'
    && json.Destination === destination
    && typeof raw === 'string'
    && BigInt(raw) >= BigInt(drops)
  if (!good) throw new Error(`Transaction ${hash.slice(0, 12)}… is not a payment of at least ${drops} drops to the seller`)

  // A payment older than the listing cannot have been made for it. Without this,
  // any prior transfer to the seller — a refund, an unrelated debt — buys shares.
  if (notBefore && tx.close_time_iso && new Date(tx.close_time_iso) < new Date(notBefore)) {
    throw new Error(`That payment predates the listing, so it was not made for it.`)
  }
  return { buyer: json.Account, paid: String(raw) }
}

/* ── operations ─────────────────────────────────────────── */

/** Custody opts in to the share MPT so the seller's payment can land. */
export async function prepare(vaultId) {
  return withLedger(async (client) => {
    const snap = await vaultSnapshot(client, vaultId)
    if (!snap.transferable) return fail(400, 'This vault issued non-transferable shares; they can only be redeemed.')
    const out = await ensureCustodyOptedIn(client, snap.share_mpt_id)
    return ok({ custody: publicCustody().address, share_mpt_id: snap.share_mpt_id, ...out })
  })
}

export async function createListing({ vault_id, shares, ask_drops, transfer_hash, seller }) {
  if (!/^[0-9A-Fa-f]{64}$/.test(vault_id ?? '')) return fail(400, 'vault_id must be 64 hex characters')
  if (!/^[0-9A-Fa-f]{64}$/.test(transfer_hash ?? '')) return fail(400, 'transfer_hash must be 64 hex characters')
  if (!/^\d+$/.test(String(shares))) return fail(400, 'shares must be a whole number')
  if (!/^\d+$/.test(String(ask_drops))) return fail(400, 'ask_drops must be a whole number of drops')

  const id = transfer_hash.slice(0, 16).toUpperCase()
  if (listings.findById(id)) return ok(listings.findById(id))

  return withLedger(async (client) => {
    const snap = await vaultSnapshot(client, vault_id)
    try {
      const { seller: onChainSeller } = await verifyShareTransfer(client, transfer_hash, {
        destination: publicCustody().address, shareMptId: snap.share_mpt_id, shares,
      })
      // The transfer's signer is the seller. A proven caller must be that account,
      // otherwise anyone could list someone else's transfer under their own name.
      if (seller && seller !== onChainSeller) {
        return fail(403, `That transfer was sent by ${onChainSeller}, not by you.`)
      }
      return ok(listings.insert({
        id, vault_id, share_mpt_id: snap.share_mpt_id, domain_id: snap.domain_id,
        seller_address: onChainSeller, shares: String(shares), ask_drops: String(ask_drops),
        nav_at_listing: snap.nav_drops == null ? null : String(snap.nav_drops),
        transfer_hash: transfer_hash.toUpperCase(),
      }))
    } catch (e) { return fail(400, e.message) }
  })
}

/**
 * Buyer has paid the seller; custody releases the shares.
 *
 * The listing is claimed in a single conditional UPDATE before anything moves, so a
 * concurrent settle loses the race cleanly and a reused payment hash is rejected by
 * the unique index rather than after delivery. Any failure after the claim releases
 * it, leaving the listing open again.
 */
export async function settleListing(id, { payment_hash }) {
  const row = listings.findById(id)
  if (!row) return fail(404, 'No such listing.')
  if (row.status !== 'open') return fail(409, `This listing is ${row.status}.`)
  if (!/^[0-9A-Fa-f]{64}$/.test(payment_hash ?? '')) return fail(400, 'payment_hash must be 64 hex characters')

  const already = listings.paymentUsed(payment_hash)
  if (already) return fail(409, `That payment already settled listing ${already.id}. Each payment settles one listing.`)

  let claimed = false
  try { claimed = listings.claimForSettlement(id, payment_hash) }
  catch (e) {
    // The unique index fires here when two settles race with the same hash.
    return fail(409, `That payment is already being used to settle another listing. (${e.code ?? e.message})`)
  }
  if (!claimed) return fail(409, 'Another settlement is already in progress for this listing.')

  try {
    return await withLedger(async (client) => {
      let buyer
      try {
        ({ buyer } = await verifyXrpPayment(client, payment_hash, {
          destination: row.seller_address, drops: row.ask_drops, notBefore: row.created_at,
        }))
      } catch (e) { listings.releaseClaim(id); return fail(400, e.message) }

      // Re-check immediately before moving. With no Batch amendment the legs cannot be
      // atomic, so a tecNO_AUTH here would leave the buyer paid and empty-handed.
      const el = await eligibility(client, buyer, row.share_mpt_id, row.domain_id)
      if (!el.ready) {
        listings.releaseClaim(id)
        return fail(409, `Buyer cannot receive these shares (credential: ${el.credentialed}, opted in: ${el.opted_in}). `
          + 'The payment has already left their account, so resolve eligibility and settle again.')
      }

      const r = await submit(client, custodyWallet(), {
        TransactionType: 'Payment', Account: publicCustody().address, Destination: buyer,
        Amount: sharesAmount(row.share_mpt_id, row.shares),
      })
      if (!r.ok) { listings.releaseClaim(id); return fail(500, `Share delivery failed: ${r.code}`) }
      return ok(listings.markSold(id, { buyer_address: buyer, delivery_hash: r.hash }))
    })
  } catch (e) {
    listings.releaseClaim(id)
    return fail(500, e.message)
  }
}

/** Seller changed their mind; custody returns the shares. The caller is proven. */
export async function cancelListing(id, provedSeller) {
  const row = listings.findById(id)
  if (!row) return fail(404, 'No such listing.')
  if (row.status !== 'open') return fail(409, `This listing is ${row.status}.`)
  if (provedSeller !== row.seller_address) return fail(403, 'Only the seller can cancel this listing.')

  if (!listings.claimForCancel(id)) return fail(409, 'This listing is already being settled or cancelled.')

  try {
    return await withLedger(async (client) => {
      const r = await submit(client, custodyWallet(), {
        TransactionType: 'Payment', Account: publicCustody().address, Destination: row.seller_address,
        Amount: sharesAmount(row.share_mpt_id, row.shares),
      })
      if (!r.ok) { listings.releaseClaim(id); return fail(500, `Share return failed: ${r.code}`) }
      return ok(listings.markCancelled(id, r.hash))
    })
  } catch (e) {
    listings.releaseClaim(id)
    return fail(500, e.message)
  }
}

/** Shares custody holds with no open listing: the residue of a mid-flight failure. */
export async function stranded(shareMptId) {
  return withLedger(async (client) => {
    let held = '0'
    try {
      const node = (await client.request({
        command: 'ledger_entry', mptoken: { mpt_issuance_id: shareMptId, account: publicCustody().address },
      })).result.node
      held = String(node.MPTAmount ?? '0')
    } catch { return ok({ held: '0', listed: '0', stranded: '0' }) }
    const listed = listings.openSharesFor(shareMptId)
    return ok({ held, listed, stranded: (BigInt(held) - BigInt(listed)).toString() })
  })
}

/** Listings joined with live NAV and the discount each represents. */
export async function board(filters) {
  const rows = listings.list(filters)
  if (!rows.length) return ok([])

  return withLedger(async (client) => {
    const snaps = new Map()
    for (const vaultId of new Set(rows.map((r) => r.vault_id))) {
      try { snaps.set(vaultId, await vaultSnapshot(client, vaultId)) } catch { snaps.set(vaultId, null) }
    }
    return ok(rows.map((row) => {
      const snap = snaps.get(row.vault_id)
      // Shares are stored as TEXT because they exceed safe integers; keep the
      // multiplication in BigInt and only cross to Number for the percentage.
      const navTotal = snap?.nav_drops == null ? null
        : (BigInt(row.shares) * BigInt(Math.round(snap.nav_drops * 1e6))) / 1_000_000n
      return {
        ...row,
        snapshot: snap,
        nav_drops_total: navTotal == null ? null : navTotal.toString(),
        discount_pct: navTotal && navTotal > 0n
          ? (1 - Number(BigInt(row.ask_drops) * 10_000n / navTotal) / 10_000) * 100
          : null,
      }
    }))
  })
}

export const listOne = (id) => listings.findById(id)
