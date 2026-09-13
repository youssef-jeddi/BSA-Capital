/**
 * Rebalancing a super vault mid-term, through our own secondary market.
 *
 * A sub-fund position is locked in that fund's Investment phase: VaultWithdraw
 * returns tecTOO_SOON and the capital cannot be moved. But the share token still
 * transfers, which is the whole reason the resale market exists. So a curator
 * rebalances in two steps with a real gap between them:
 *
 *   exit     the deployment account sells the whole position to custody and it
 *            is listed. Nothing is guaranteed: without a buyer it stays listed.
 *   redeploy once the listing sells, the XRP that landed on the deployment
 *            account is deposited into a fund that is still raising.
 *
 * Both are authorised by the curator and executed with the deployment account's
 * key, the same arrangement every other deployment action already uses.
 *
 * The marketplace needs no special case for this. createListing takes the seller
 * from the on-ledger signer of the share transfer, so the deployment account
 * becomes the seller simply by signing, and the buyer pays it directly.
 */
import * as xrpl from 'xrpl'
import * as supers from '../repositories/superVaults.js'
import * as vaults from '../repositories/vaults.js'
import * as listings from '../repositories/listings.js'
import * as market from './marketplace.js'
import { loadAccount, depositToVault, ensureZoneCredentials } from './deploymentAccount.js'
import { askFromNav, validateReallocation } from '../validation/reallocation.js'

const WSS = process.env.XRPL_WSS ?? 'wss://s.devnet.rippletest.net:51233/'
const fail = (status, ...errors) => ({ ok: false, status, errors: errors.flat() })
const ok = (data) => ({ ok: true, data })

async function withClient(fn) {
  const client = new xrpl.Client(WSS)
  await client.connect()
  try { return await fn(client) } finally { await client.disconnect().catch(() => {}) }
}

/** Whole positions only: half a position is a second row this table cannot hold. */
async function heldShares(client, account, shareMptId) {
  return client.request({
    command: 'ledger_entry', mptoken: { mpt_issuance_id: shareMptId, account },
  }).then((r) => String(r.result.node.MPTAmount ?? '0')).catch(() => '0')
}

/**
 * Sell the whole position into custody and list it.
 *
 * Ordered so nothing is recorded until the shares have actually moved: a listing
 * whose transfer failed would be a claim on shares that are still with us.
 */
export async function exitPosition(superVaultId, subVaultId, { discount_bps = 0 } = {}) {
  const sv = supers.findById(superVaultId)
  if (!sv) return fail(404, 'Super vault not found.')

  const from = sv.allocations.find((a) => a.sub_vault_id === subVaultId)
  if (!from) return fail(404, 'That allocation is not part of this super vault.')
  if (from.status === 'exiting') return fail(409, 'This position is already listed for sale.')
  if (from.status === 'exited') return fail(409, 'This position has already been reallocated.')

  const account = loadAccount()
  if (!account) return fail(500, 'No deployment account configured. Run: npm run supervault-account')

  return withClient(async (client) => {
    const snap = await market.vaultSnapshot(client, subVaultId).catch(() => null)
    if (!snap) return fail(400, 'That sub-fund cannot be read on this network.')
    if (!snap.transferable) {
      return fail(400, `${from.sub_vault_name ?? 'This fund'} issued non-transferable shares, so the `
        + 'position can only be redeemed at maturity. It cannot be reallocated.')
    }

    const shares = await heldShares(client, account.address, snap.share_mpt_id)
    if (BigInt(shares) <= 0n) {
      return fail(400, 'The deployment account holds no shares in that fund, so there is nothing to sell.')
    }

    const priced = askFromNav({ shares, navDrops: snap.nav_drops, discountBps: discount_bps })
    if (!priced) return fail(400, 'Cannot price this position: the fund has no readable net asset value.')

    // Custody has to be able to receive the share token before it is sent one.
    const prep = await market.prepare(subVaultId)
    if (!prep.ok) return prep

    const wallet = xrpl.Wallet.fromSeed(account.seed)
    const signed = wallet.sign(await client.autofill({
      TransactionType: 'Payment', Account: wallet.address, Destination: prep.data.custody,
      Amount: { mpt_issuance_id: snap.share_mpt_id, value: shares },
    }))
    const sent = await client.submitAndWait(signed.tx_blob)
    const code = sent.result.meta?.TransactionResult
    if (code !== 'tesSUCCESS') return fail(400, `Moving the shares to custody failed: ${code}`)

    const listed = await market.createListing({
      vault_id: subVaultId, shares, ask_drops: priced.ask,
      transfer_hash: sent.result.hash, seller: account.address,
    })
    if (!listed.ok) return listed

    supers.markExiting(superVaultId, subVaultId, listed.data.id)
    return ok({
      listing: listed.data,
      shares,
      nav_drops_total: priced.navTotal,
      ask_drops: priced.ask,
      haircut_drops: priced.haircut,
      transfer_hash: sent.result.hash,
    })
  })
}

/** Put a listed position back where it was, if no buyer turned up. */
export async function abandonExit(superVaultId, subVaultId) {
  const sv = supers.findById(superVaultId)
  if (!sv) return fail(404, 'Super vault not found.')
  const from = sv.allocations.find((a) => a.sub_vault_id === subVaultId)
  if (from?.status !== 'exiting') return fail(409, 'That position is not currently listed.')

  const account = loadAccount()
  const cancelled = await market.cancelListing(from.listing_id, account?.address)
  if (!cancelled.ok) return cancelled
  return ok({ allocations: supers.cancelExit(superVaultId, subVaultId) })
}

/**
 * Deposit the sale proceeds into a different fund.
 *
 * The proceeds are the ask, because the buyer pays the seller directly and the
 * seller is the deployment account. Deliberately not "whatever the account
 * happens to hold": that balance also carries the float it was funded with.
 */
export async function redeployProceeds(superVaultId, { from_sub_vault_id, to_sub_vault_id }) {
  const sv = supers.findById(superVaultId)
  if (!sv) return fail(404, 'Super vault not found.')

  const from = sv.allocations.find((a) => a.sub_vault_id === from_sub_vault_id)
  const to = vaults.findById(String(to_sub_vault_id ?? '').toUpperCase())

  const errors = validateReallocation({
    from,
    to,
    context: {
      superVaultId,
      loanMaturity: sv.loan_maturity,
      superRedemption: sv.redemption_date,
      nowMs: Date.now(),
    },
  })
  if (errors.length) return fail(400, errors)

  const listing = listings.findById(from.listing_id)
  if (!listing) return fail(409, 'The listing for this position has gone missing.')
  if (listing.status !== 'sold') {
    return fail(409, listing.status === 'open'
      ? 'Nobody has bought this position yet. The proceeds do not exist until it sells.'
      : `That listing is ${listing.status}, so there are no proceeds to redeploy.`)
  }

  // A gated destination refuses an uncredentialed depositor; cheap and idempotent.
  await ensureZoneCredentials().catch(() => {})

  const out = await depositToVault(to.vault_id, listing.ask_drops)
  if (out.result_code !== 'tesSUCCESS') {
    return fail(400, `Depositing into ${to.name} failed: ${out.result_code}. `
      + 'The proceeds are still on the deployment account and can be redeployed again.')
  }

  return ok({
    result_code: out.result_code,
    hash: out.hash,
    moved_drops: listing.ask_drops,
    allocations: supers.completeReallocation(superVaultId, {
      from: from_sub_vault_id, to: to.vault_id, bps: from.target_bps, depositTx: out.hash,
    }),
  })
}
