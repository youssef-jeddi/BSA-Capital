/**
 * Create the two sub-funds a reallocation demo needs, so the manual run starts
 * at the interesting part.
 *
 *   A  closes soon, so it is locked by the time you want to move it
 *   C  stays open long enough to still accept the proceeds
 *
 * Both are ungated, so the buyer only needs an MPTokenAuthorize and not a
 * credential. Owned by the scripted broker company, not yours: a curator
 * allocating across another manager's funds is the realistic shape.
 */
import * as xrpl from 'xrpl'
import fs from 'node:fs'
import path from 'node:path'
import { proveControl } from './lib/auth.mjs'

const API = process.env.API ?? 'http://127.0.0.1:8787'
const ROOT = path.resolve(import.meta.dirname, '..')
const c = new xrpl.Client('wss://s.devnet.rippletest.net:51233/')
const hex = (s) => Buffer.from(s).toString('hex').toUpperCase()
const log = (...a) => console.log(...a)

// A locks at +12 so there is room to build the super vault first; C stays open
// until +45 so the proceeds have somewhere to go.
const A = { sub: 12, red: 50, ticker: 'DEMOA', name: 'Ravello Trade Finance' }
const C = { sub: 45, red: 50, ticker: 'DEMOC', name: 'Halden Equipment Leasing' }

const pad = (n) => String(n).padStart(2, '0')
const field = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

async function api(p, body, wallet) {
  const payload = body && wallet ? { ...body, proof: await proveControl(API, wallet) } : body
  const res = await fetch(API + p, payload
    ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
    : undefined)
  const j = await res.json().catch(() => null)
  if (!res.ok) throw new Error(j?.errors?.[0] ?? `HTTP ${res.status} ${p}`)
  return j
}

async function send(label, w, tx) {
  const r = await c.submitAndWait(w.sign(await c.autofill(tx)).tx_blob)
  const code = r.result.meta?.TransactionResult
  log(`  ${code === 'tesSUCCESS' ? 'OK  ' : 'FAIL'} ${label.padEnd(38)} ${code}`)
  if (code !== 'tesSUCCESS') throw new Error(`${label}: ${code}`)
  return r.result
}
const created = (r, t) => r?.meta?.AffectedNodes?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)

async function main() {
  await c.connect()
  const t0 = Math.ceil(Date.now() / 60_000) * 60_000
  const rt = (min) => xrpl.unixTimeToRippleTime(t0 + min * 60_000)

  const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/accounts.json'), 'utf8'))
  const broker = xrpl.Wallet.fromSeed(seeds.broker)
  await c.fundWallet(broker).catch(() => {})

  await api('/api/companies', {
    address: broker.address, name: 'BSA Capital',
    activity: 'Private credit fund manager', country: 'FR',
  }, broker).catch(() => {})

  log(`Issuer ${broker.address} (BSA Capital)\n`)

  const out = []
  for (const f of [A, C]) {
    const vr = await send(`VaultCreate ${f.name}`, broker, {
      TransactionType: 'VaultCreate', Account: broker.address, Asset: { currency: 'XRP' },
      VaultKind: 1, WithdrawalPolicy: 1,
      SubscriptionDate: rt(f.sub), RedemptionDate: rt(f.red),
      AssetsMaximum: xrpl.xrpToDrops('2000'),
      MPTokenMetadata: hex(JSON.stringify({
        ticker: f.ticker, name: `${f.name} Shares`, issuer_name: 'BSA Capital',
        asset_class: 'rwa', asset_subclass: 'private_credit', icon: 'https://bsa.capital/icon.png',
      })),
      Data: hex(JSON.stringify({ name: f.name })),
    })
    const id = created(vr, 'Vault').LedgerIndex
    const br = await send('LoanBrokerSet', broker, {
      TransactionType: 'LoanBrokerSet', Account: broker.address, VaultID: id,
      ManagementFeeRate: 100, DebtMaximum: xrpl.xrpToDrops('2000'),
    })
    await api('/api/vaults', {
      vault_id: id, company_address: broker.address, name: f.name,
      loan_broker_id: created(br, 'LoanBroker')?.LedgerIndex,
      asset_code: 'XRP', subscription_date: rt(f.sub), redemption_date: rt(f.red),
      target_apy: f === A ? 9400 : 8200,
    }, broker)
    out.push({ ...f, id })
  }

  log(`\nBoth funds are live and indexed.\n`)
  for (const f of out) {
    log(`  ${f.name}`)
    log(`    closes    ${clock(t0 + f.sub * 60_000)}   redeems ${clock(t0 + f.red * 60_000)}`)
  }

  log(`\nNow create the super vault with these dates:\n`)
  log(`    Subscription closes   ${field(t0 + 8 * 60_000)}   ${clock(t0 + 8 * 60_000)}`)
  log(`    Loan maturity         ${field(t0 + 55 * 60_000)}   ${clock(t0 + 55 * 60_000)}`)
  log(`    Redemption opens      ${field(t0 + 60 * 60_000)}   ${clock(t0 + 60 * 60_000)}`)
  log(`\n  Allocate 100% to ${A.name}. Leave ${C.name} unticked: it is where you`)
  log(`  reallocate to later.\n`)
  log(`  ${clock(t0 + 8 * 60_000)}  super vault locks, deploy capital into ${A.name}`)
  log(`  ${clock(t0 + 12 * 60_000)}  ${A.name} locks, its position can only be sold`)
  log(`  after that  Reallocate on that row, a third wallet buys, redeploy into ${C.name}`)
  log(`  ${clock(t0 + 45 * 60_000)}  ${C.name} closes, so redeploy before then\n`)

  await c.disconnect()
}

main().catch(async (e) => {
  console.error(`\nFAILED: ${e.message}`)
  if (c.isConnected()) await c.disconnect()
  process.exitCode = 1
})
