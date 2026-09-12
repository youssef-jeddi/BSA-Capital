/**
 * The custody account: the settlement leg of the marketplace.
 *
 * MPTs cannot be traded on the DEX — OfferCreate with an MPT TakerGets returns
 * temDISABLED even with a DomainID, so the permissioned DEX is out despite
 * lsfMPTCanTrade being set. And Batch is absent on Devnet, so a buy cannot be
 * atomic. Hence an account that holds the shares between the two legs.
 *
 * It only ever holds SHARES, never cash: the buyer pays the seller directly.
 *
 * DEVNET ONLY. The seed lives in a gitignored file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as xrpl from 'xrpl'
import { nowIso } from '../db/index.js'
import { ZONES, toHex } from '../lib/zones.js'
import { issueZoneCredential, publicAdmin } from './platformAdmin.js'

const here = dirname(fileURLToPath(import.meta.url))
const FILE = process.env.CUSTODY_ACCOUNT ?? path.join(here, '../../data/custody-account.json')
const WSS = process.env.XRPL_WSS ?? 'wss://s.devnet.rippletest.net:51233/'

export function loadCustody() {
  if (!fs.existsSync(FILE)) return null
  try {
    const { address, seed } = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return address && seed ? { address, seed } : null
  } catch { return null }
}

export const publicCustody = () => {
  const c = loadCustody()
  return c ? { address: c.address, configured: true } : { address: null, configured: false }
}

export const custodyWallet = () => {
  const c = loadCustody()
  if (!c) throw new Error('Custody account not set up. Run: npm run setup-custody')
  return xrpl.Wallet.fromSeed(c.seed)
}

export async function withLedger(fn) {
  const client = new xrpl.Client(WSS)
  await client.connect()
  try { return await fn(client) } finally { await client.disconnect().catch(() => {}) }
}

/**
 * Submit and never throw; ledger codes are information, not exceptions.
 *
 * submitAndWait can throw AFTER the transaction has applied — a dropped socket, an
 * expired LastLedgerSequence. In a marketplace that is the worst ambiguity: shares
 * move, no listing is recorded, and they strand in custody. The hash is fixed at
 * signing, so on any error we ask the ledger what actually happened instead of
 * assuming failure.
 */
export async function submit(client, wallet, tx) {
  const signed = wallet.sign(await client.autofill(tx))
  try {
    const res = await client.submitAndWait(signed.tx_blob)
    const code = res.result.meta?.TransactionResult
    return { ok: code === 'tesSUCCESS', code, hash: res.result.hash, result: res.result }
  } catch (e) {
    const landed = await lookUp(client, signed.hash)
    if (landed) return { ...landed, recovered: true }
    const msg = e.data?.error_message ?? e.message
    return { ok: false, code: /\b(te[cflms][A-Z_]+)/.exec(msg)?.[1] ?? 'REJECTED', error: msg, hash: signed.hash }
  }
}

/** Did this hash land? Retried, because validation lags the throw. */
async function lookUp(client, hash, tries = 4) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = (await client.request({ command: 'tx', transaction: hash })).result
      const code = (r.meta ?? r.metaData)?.TransactionResult
      if (code) return { ok: code === 'tesSUCCESS', code, hash, result: r }
    } catch { /* not validated yet */ }
    await new Promise((res) => setTimeout(res, 2000))
  }
  return null
}

/**
 * Create, fund and credential the custody account.
 *
 * A domain's AcceptedCredentials are OR, not AND, so holding all three zone
 * credentials lets one custody account settle for every zone combination.
 */
export async function setupCustody() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  const admin = publicAdmin()
  if (!admin.configured) throw new Error('Platform account missing. Run: npm run setup-zones')

  return withLedger(async (client) => {
    let record = loadCustody()
    let wallet
    if (record) {
      wallet = xrpl.Wallet.fromSeed(record.seed)
    } else {
      const funded = await client.fundWallet()
      wallet = funded.wallet
      record = { address: wallet.address, seed: wallet.seed, createdAt: nowIso() }
      fs.writeFileSync(FILE, JSON.stringify(record, null, 2))
    }
    if (Number(await client.getXrpBalance(wallet.address)) < 150) {
      await client.fundWallet(wallet).catch(() => {})
    }

    const held = await client.request({
      command: 'account_objects', account: wallet.address, type: 'credential',
    }).then((r) => r.result.account_objects ?? []).catch(() => [])

    const zones = []
    for (const zone of ZONES) {
      const type = toHex(zone.credentialType)
      const existing = held.find((o) => o.Issuer === admin.address && o.CredentialType === type)
      if (existing && (existing.Flags & 0x00010000)) { zones.push({ zone: zone.code, already: true }); continue }

      if (!existing) {
        const issued = await issueZoneCredential(wallet.address, zone.code)
        if (issued.result_code !== 'tesSUCCESS' && issued.result_code !== 'tecDUPLICATE') {
          throw new Error(`issue ${zone.code}: ${issued.result_code}`)
        }
      }
      const accept = await submit(client, wallet, {
        TransactionType: 'CredentialAccept', Account: wallet.address,
        Issuer: admin.address, CredentialType: type,
      })
      if (!accept.ok) throw new Error(`accept ${zone.code}: ${accept.code}`)
      zones.push({ zone: zone.code, already: false })
    }

    return {
      address: wallet.address,
      balance: await client.getXrpBalance(wallet.address),
      zones,
    }
  })
}

/**
 * Custody must opt in to a share MPT before a seller can pay it.
 *
 * MPTokenAuthorize is signed by the RECIPIENT with no Holder field, like a TrustSet.
 * There is no issuer-side authorize for vault shares and there never can be: the
 * issuer is the vault's keyless pseudo-account. Idempotent.
 */
export async function ensureCustodyOptedIn(client, shareMptId) {
  const wallet = custodyWallet()
  try {
    await client.request({
      command: 'ledger_entry', mptoken: { mpt_issuance_id: shareMptId, account: wallet.address },
    })
    return { already: true }
  } catch { /* no MPToken yet */ }

  const r = await submit(client, wallet, {
    TransactionType: 'MPTokenAuthorize', Account: wallet.address, MPTokenIssuanceID: shareMptId,
  })
  if (!r.ok) throw new Error(`custody MPTokenAuthorize: ${r.code}`)
  return { already: false, hash: r.hash }
}
