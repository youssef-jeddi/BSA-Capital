/**
 * Whole super vault lifecycle, headless, through the same API the UI calls.
 *
 *   sub-funds -> super vault -> depositor subscribes -> curator lends to the
 *   deployment account -> deployment account allocates across the sub-funds
 *
 * Proves the chain end to end before anyone clicks through it.
 */
import * as xrpl from 'xrpl'
import fs from 'node:fs'
import path from 'node:path'

const API = process.env.API ?? 'http://127.0.0.1:8787'
const ROOT = path.resolve(import.meta.dirname, '..')
const EX = 'https://devnet.xrpl.org/transactions/'

// sub redemption <= loan maturity < super redemption
const SUB_FUND = { sub: 20, red: 25 }
const SUPER = { sub: 3, loan: 30, red: 45 }

const client = new xrpl.Client('wss://s.devnet.rippletest.net:51233/')
const log = (...a) => console.log(...a)
const hex = (s) => Buffer.from(s).toString('hex').toUpperCase()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const W = Object.fromEntries(Object.entries(
  JSON.parse(fs.readFileSync(path.join(ROOT, 'data/accounts.json'), 'utf8')))
  .map(([k, s]) => [k, xrpl.Wallet.fromSeed(s)]))

async function api(pathname, body) {
  const res = await fetch(`${API}${pathname}`, body ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  } : undefined)
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.errors?.[0] ?? `HTTP ${res.status} on ${pathname}`)
  return json
}

async function send(label, wallet, tx) {
  const r = await client.submitAndWait(wallet.sign(await client.autofill(tx)).tx_blob)
  const code = r.result.meta?.TransactionResult
  log(`  ${code === 'tesSUCCESS' ? 'OK  ' : 'FAIL'} ${label.padEnd(34)} ${code}`)
  if (code !== 'tesSUCCESS') throw new Error(`${label}: ${code}`)
  return r.result
}
const created = (r, t) => r?.meta?.AffectedNodes?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)
const rippleAt = (min) => xrpl.unixTimeToRippleTime(T0 + min * 60_000)
const ledgerNow = async () =>
  xrpl.rippleTimeToUnixTime((await client.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger.close_time)

let T0

const meta = (ticker, name) => hex(JSON.stringify({
  ticker, name: `${name} Shares`, issuer_name: 'BSA Capital', asset_class: 'rwa',
  asset_subclass: 'private_credit', icon: 'https://bsa.capital/icon.png',
}))

async function main() {
  await client.connect()
  T0 = Date.now()
  for (const n of ['broker', 'lpA']) await client.fundWallet(W[n]).catch(() => {})

  const deployer = await api('/api/deployment-account')
  if (!deployer.configured) throw new Error('Run: npm run supervault-account')
  log(`Curator    ${W.broker.address}`)
  log(`Depositor  ${W.lpA.address}`)
  log(`Deployment ${deployer.address}\n`)

  await api('/api/companies', {
    address: W.broker.address, name: 'BSA Capital',
    activity: 'Private credit fund manager', country: 'FR',
  }).catch(() => {})

  log('── 1. Two sub-funds ──')
  const subs = []
  for (const [ticker, name] of [['E2EA', 'E2E Alpha Fund'], ['E2EB', 'E2E Beta Fund']]) {
    const r = await send(`VaultCreate ${name}`, W.broker, {
      TransactionType: 'VaultCreate', Account: W.broker.address, Asset: { currency: 'XRP' },
      VaultKind: 1, WithdrawalPolicy: 1,
      SubscriptionDate: rippleAt(SUB_FUND.sub), RedemptionDate: rippleAt(SUB_FUND.red),
      AssetsMaximum: xrpl.xrpToDrops('2000'), MPTokenMetadata: meta(ticker, name),
      Data: hex(JSON.stringify({ name })),
    })
    const id = created(r, 'Vault').LedgerIndex
    const br = await send('LoanBrokerSet', W.broker, {
      TransactionType: 'LoanBrokerSet', Account: W.broker.address, VaultID: id,
      ManagementFeeRate: 100, DebtMaximum: xrpl.xrpToDrops('2000'),
    })
    await api('/api/vaults', {
      vault_id: id, company_address: W.broker.address, name,
      loan_broker_id: created(br, 'LoanBroker')?.LedgerIndex,
      asset_code: 'XRP', subscription_date: rippleAt(SUB_FUND.sub), redemption_date: rippleAt(SUB_FUND.red),
    })
    subs.push({ id, name })
  }

  log('\n── 2. Super vault ──')
  const svRes = await send('VaultCreate (super)', W.broker, {
    TransactionType: 'VaultCreate', Account: W.broker.address, Asset: { currency: 'XRP' },
    VaultKind: 1, WithdrawalPolicy: 1,
    SubscriptionDate: rippleAt(SUPER.sub), RedemptionDate: rippleAt(SUPER.red),
    AssetsMaximum: xrpl.xrpToDrops('5000'), MPTokenMetadata: meta('E2ESV', 'E2E Diversified'),
    Data: hex(JSON.stringify({ name: 'E2E Diversified Credit', kind: 'super' })),
  })
  const superId = created(svRes, 'Vault').LedgerIndex
  const svBroker = await send('LoanBrokerSet (super)', W.broker, {
    TransactionType: 'LoanBrokerSet', Account: W.broker.address, VaultID: superId,
    ManagementFeeRate: 100, DebtMaximum: xrpl.xrpToDrops('5000'),
  })
  const superBrokerId = created(svBroker, 'LoanBroker').LedgerIndex

  await api('/api/super-vaults', {
    vault_id: superId, curator_address: W.broker.address, deployment_address: deployer.address,
    loan_broker_id: superBrokerId, name: 'E2E Diversified Credit',
    strategy: 'Two managers, equal weight',
    subscription_date: rippleAt(SUPER.sub), redemption_date: rippleAt(SUPER.red),
    loan_maturity: rippleAt(SUPER.loan),
    allocations: subs.map((s) => ({ sub_vault_id: s.id, target_bps: 5000 })),
  })
  log(`  indexed with a 50/50 allocation, cascade accepted`)

  log('\n── 3. Depositor subscribes ──')
  await send('VaultDeposit 120 XRP', W.lpA, {
    TransactionType: 'VaultDeposit', Account: W.lpA.address, VaultID: superId,
    Amount: xrpl.xrpToDrops('120'),
  })

  log('\n── 4. Waiting for the super vault Investment phase ──')
  const opensAt = T0 + SUPER.sub * 60_000
  while ((await ledgerNow()) < opensAt + 4000) {
    log(`  ${Math.max(0, Math.round((opensAt - (await ledgerNow())) / 1000))}s…`); await wait(15000)
  }

  log('\n── 5. Curator signs, deployment account counter-signs ──')
  const vaultNow = (await client.request({ command: 'ledger_entry', index: superId })).result.node
  const prepared = await client.autofill({
    TransactionType: 'LoanSet', Account: W.broker.address, Counterparty: deployer.address,
    LoanBrokerID: superBrokerId, PrincipalRequested: String(vaultNow.AssetsAvailable),
    InterestRate: 5000, PaymentInterval: 120, PaymentTotal: 2, GracePeriod: 60,
  })
  const halfSigned = xrpl.decode(W.broker.sign(prepared).tx_blob)
  const out = await api(`/api/super-vaults/${superId}/counter-sign`, { tx_json: halfSigned })
  log(`  ${out.result_code === 'tesSUCCESS' ? 'OK  ' : 'FAIL'} LoanSet via API${''.padEnd(19)} ${out.result_code}`)
  log(`       ${EX}${out.hash}`)
  if (out.result_code !== 'tesSUCCESS') throw new Error('counter-sign failed')
  log(`  LoanID ${out.loan_id}`)

  log('\n── 6. Deployment account allocates ──')
  const each = String(Math.floor(Number(vaultNow.AssetsAvailable) / 2))
  for (const s of subs) {
    const d = await api(`/api/super-vaults/${superId}/allocations/${s.id}/deposit`, { amount: each })
    log(`  ${d.result_code === 'tesSUCCESS' ? 'OK  ' : 'FAIL'} deposit -> ${s.name.padEnd(22)} ${d.result_code}`)
  }

  log('\n── 7. Final state ──')
  const final = await api(`/api/super-vaults/${superId}`)
  log(`  status ${final.status}  loan ${final.loan_id?.slice(0, 16)}…`)
  for (const a of final.allocations) {
    log(`   - ${(a.sub_vault_name ?? '').padEnd(18)} ${a.target_bps / 100}%  funded: ${a.deposited_tx ? 'yes' : 'no'}`)
  }
  log(`\nSuper vault ${superId}`)
  await client.disconnect()
}

main().catch(async (e) => {
  console.error(`\nFAILED: ${e.message}`)
  if (client.isConnected()) await client.disconnect()
  process.exitCode = 1
})
