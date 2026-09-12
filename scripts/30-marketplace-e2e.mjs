/**
 * Whole marketplace flow against the running API, on Devnet.
 *
 * Builds a zone-gated vault, locks an LP into Investment, proves the lock, then sells
 * the position to a second investor through custody. Every negative case the ledger
 * enforces is asserted on the way.
 */
import * as xrpl from 'xrpl'
import fs from 'node:fs'
import path from 'node:path'

const API = process.env.API ?? 'http://127.0.0.1:8787'
const ROOT = path.resolve(import.meta.dirname, '..')
const c = new xrpl.Client('wss://s.devnet.rippletest.net:51233/')
const log = (...a) => console.log(...a)
const hex = (s) => Buffer.from(s).toString('hex').toUpperCase()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(p, body, method = 'POST') {
  const res = await fetch(API + p, body ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined)
  const j = await res.json().catch(() => null)
  if (!res.ok) throw new Error(j?.errors?.[0] ?? `HTTP ${res.status} ${p}`)
  return j
}
async function send(label, w, tx, expect = 'tesSUCCESS') {
  let code
  try {
    const r = await c.submitAndWait(w.sign(await c.autofill(tx)).tx_blob)
    code = r.result.meta?.TransactionResult
    var hash = r.result.hash, result = r.result
  } catch (e) { code = /\b(te[cflms][A-Z_]+)/.exec(e?.data?.error_exception ?? e.message)?.[1] ?? 'ERROR' }
  const good = code === expect
  log(`  ${good ? 'OK  ' : 'FAIL'} ${label.padEnd(46)} ${code}${good ? '' : `  (expected ${expect})`}`)
  if (!good && expect === 'tesSUCCESS') throw new Error(`${label}: ${code}`)
  return { code, hash, result }
}
const created = (r, t) => r?.meta?.AffectedNodes?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)

async function main() {
  await c.connect()
  const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/accounts.json'), 'utf8'))
  const broker = xrpl.Wallet.fromSeed(seeds.broker)
  const seller = (await c.fundWallet()).wallet
  const buyer = (await c.fundWallet()).wallet
  const custody = (await api('/api/market/custody', null, 'GET')).address
  log(`seller  ${seller.address}\nbuyer   ${buyer.address}\ncustody ${custody}\n`)

  await api('/api/companies', { address: broker.address, name: 'BSA Capital', activity: 'Private credit', country: 'FR' }).catch(() => {})
  const { domain_id } = await api('/api/zones/domain', { zones: ['EU'] })

  log('── vault gated to EU, Investment in 3 min ──')
  const t0 = Date.now(), rt = (m) => xrpl.unixTimeToRippleTime(t0 + m * 60000)
  const vr = await send('VaultCreate (EU-gated)', broker, {
    TransactionType: 'VaultCreate', Account: broker.address, Asset: { currency: 'XRP' },
    VaultKind: 1, WithdrawalPolicy: 1, SubscriptionDate: rt(3), RedemptionDate: rt(60),
    Flags: xrpl.VaultCreateFlags.tfVaultPrivate, DomainID: domain_id,
    MPTokenMetadata: hex(JSON.stringify({ ticker: 'MKT', name: 'Market Test Shares', issuer_name: 'BSA Capital', asset_class: 'rwa', asset_subclass: 'private_credit', icon: 'https://b.co/i.png' })),
    Data: hex(JSON.stringify({ name: 'Marketplace Test Fund' })),
  })
  const vaultId = created(vr.result, 'Vault').LedgerIndex
  await api('/api/vaults', { vault_id: vaultId, company_address: broker.address, name: 'Marketplace Test Fund', zones: ['EU'], domain_id, is_private: true, subscription_date: rt(3), redemption_date: rt(60) })

  log('\n── seller gets an EU credential and subscribes ──')
  const iss = await api('/api/zones/credentials', { address: seller.address, zone: 'EU' })
  await send('CredentialAccept (seller)', seller, { TransactionType: 'CredentialAccept', Account: seller.address, Issuer: iss.issuer, CredentialType: iss.credential_type })
  await send('VaultDeposit 50 XRP', seller, { TransactionType: 'VaultDeposit', Account: seller.address, VaultID: vaultId, Amount: xrpl.xrpToDrops('50') })

  log('\n── wait for Investment, then prove the lock ──')
  const opens = t0 + 3 * 60000
  while (Date.now() < opens + 6000) { log(`  ${Math.round((opens - Date.now()) / 1000)}s…`); await wait(20000) }
  await send('VaultWithdraw during Investment', seller, { TransactionType: 'VaultWithdraw', Account: seller.address, VaultID: vaultId, Amount: xrpl.xrpToDrops('10') }, 'tecTOO_SOON')

  log('\n── list 50,000,000 shares for 45 XRP (10% discount) ──')
  const prep = await api('/api/market/prepare', { vault_id: vaultId })
  log(`  custody opted in: ${prep.already ? 'already' : prep.hash?.slice(0, 12) + '…'}`)
  const xfer = await send('Payment shares -> custody', seller, {
    TransactionType: 'Payment', Account: seller.address, Destination: custody,
    Amount: { mpt_issuance_id: prep.share_mpt_id, value: '50000000' },
  })
  const listing = await api('/api/market/listings', { vault_id: vaultId, shares: '50000000', ask_drops: xrpl.xrpToDrops('45'), transfer_hash: xfer.hash })
  log(`  listing ${listing.id} · ask 45 XRP`)
  const board = await api('/api/market?status=open', null, 'GET')
  const mine = board.find((b) => b.id === listing.id)
  log(`  board shows discount ${mine.discount_pct?.toFixed(2)}% vs NAV`)

  log('\n── buyer: both gates, in order ──')
  let el = await api(`/api/market/eligibility?vault=${vaultId}&account=${buyer.address}`, null, 'GET')
  log(`  no credential, no opt-in     -> credentialed=${el.credentialed} opted_in=${el.opted_in} ready=${el.ready}`)

  await send('MPTokenAuthorize by uncredentialed buyer', buyer, { TransactionType: 'MPTokenAuthorize', Account: buyer.address, MPTokenIssuanceID: prep.share_mpt_id })
  el = await api(`/api/market/eligibility?vault=${vaultId}&account=${buyer.address}`, null, 'GET')
  log(`  opted in but no credential   -> credentialed=${el.credentialed} opted_in=${el.opted_in} ready=${el.ready}   <- opt-in proves nothing`)

  const bi = await api('/api/zones/credentials', { address: buyer.address, zone: 'EU' })
  await send('CredentialAccept (buyer)', buyer, { TransactionType: 'CredentialAccept', Account: buyer.address, Issuer: bi.issuer, CredentialType: bi.credential_type })
  el = await api(`/api/market/eligibility?vault=${vaultId}&account=${buyer.address}`, null, 'GET')
  log(`  both gates                   -> credentialed=${el.credentialed} opted_in=${el.opted_in} ready=${el.ready}`)

  log('\n── settle ──')
  const pay = await send('Payment 45 XRP buyer -> seller', buyer, { TransactionType: 'Payment', Account: buyer.address, Destination: seller.address, Amount: xrpl.xrpToDrops('45') })
  try { await api(`/api/market/listings/${listing.id}/settle`, { payment_hash: 'A'.repeat(64) }); log('  FAIL bogus hash accepted') }
  catch (e) { log(`  OK   bogus payment hash rejected: ${e.message.slice(0, 52)}…`) }
  const sold = await api(`/api/market/listings/${listing.id}/settle`, { payment_hash: pay.hash })
  log(`  OK   settled -> ${sold.status}, delivery ${sold.delivery_hash?.slice(0, 12)}…`)

  const held = (await c.request({ command: 'ledger_entry', mptoken: { mpt_issuance_id: prep.share_mpt_id, account: buyer.address } })).result.node
  log(`\nbuyer now holds ${held.MPTAmount} shares`)
  const str = await api(`/api/market/stranded?share_mpt_id=${prep.share_mpt_id}`, null, 'GET')
  log(`custody residue: held ${str.held}, listed ${str.listed}, stranded ${str.stranded}`)
  await c.disconnect()
}
main().catch(async (e) => { console.error(`\nFAILED: ${e.message}`); if (c.isConnected()) await c.disconnect(); process.exitCode = 1 })
