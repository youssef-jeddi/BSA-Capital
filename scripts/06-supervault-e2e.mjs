/**
 * Whole super vault lifecycle, headless, through the same API the UI calls.
 *
 *   sub-funds -> super vault -> depositor subscribes -> curator lends to the
 *   deployment account -> allocates across the sub-funds -> sub-funds redeem ->
 *   the curator loan is repaid -> price per share steps up
 *
 * Proves the chain end to end before anyone clicks through it. The unwind half
 * matters most: a curator loan that passes maturity can never be repaid, and the
 * capital is stranded with the deployment account with no way to reach depositors.
 *
 * Takes about 10 minutes of Devnet wall time.
 */
import * as xrpl from 'xrpl'
import fs from 'node:fs'
import path from 'node:path'
import { proveControl } from './lib/auth.mjs'
import { loanSchedule } from '../web/src/lib/superVault.js'

const API = process.env.API ?? 'http://127.0.0.1:8787'
const ROOT = path.resolve(import.meta.dirname, '..')
const EX = 'https://devnet.xrpl.org/transactions/'

/**
 * Minutes from start. Two orderings have to hold and neither is enforced by the
 * protocol: the super vault must close its subscription BEFORE the sub-funds
 * close theirs (or the deployment account cannot deposit), and every sub-fund
 * must redeem BEFORE the curator loan matures (or the loan cannot be repaid).
 *
 * The loan matures well after the sub-funds redeem so the first scheduled
 * instalment is not yet due when we repay in full — otherwise the test would be
 * measuring a missed payment rather than the unwind.
 */
const SUB_FUND = { sub: 5, red: 9 }
const SUPER = { sub: 3, loan: 21, red: 25 }

const client = new xrpl.Client('wss://s.devnet.rippletest.net:51233/')
const log = (...a) => console.log(...a)
const hex = (s) => Buffer.from(s).toString('hex').toUpperCase()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const W = Object.fromEntries(Object.entries(
  JSON.parse(fs.readFileSync(path.join(ROOT, 'data/accounts.json'), 'utf8')))
  .map(([k, s]) => [k, xrpl.Wallet.fromSeed(s)]))

async function api(pathname, body, wallet) {
  const payload = body && wallet ? { ...body, proof: await proveControl(API, wallet) } : body
  const res = await fetch(`${API}${pathname}`, payload ? {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
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
  }, W.broker).catch(() => {})

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
    }, W.broker)
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
  }, W.broker)
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
  // Same helper the UI uses: the last payment lands on the chosen maturity.
  const sched = loanSchedule({ maturityRippleTime: rippleAt(SUPER.loan), nowMs: Date.now() })
  if (sched.error) throw new Error(sched.error)
  log(`  schedule ${sched.PaymentTotal} x ${sched.PaymentInterval}s, grace ${sched.GracePeriod}s`)
  const prepared = await client.autofill({
    TransactionType: 'LoanSet', Account: W.broker.address, Counterparty: deployer.address,
    LoanBrokerID: superBrokerId, PrincipalRequested: String(vaultNow.AssetsAvailable),
    InterestRate: 5000,
    PaymentInterval: sched.PaymentInterval,
    PaymentTotal: sched.PaymentTotal,
    GracePeriod: sched.GracePeriod,
  })
  const halfSigned = xrpl.decode(W.broker.sign(prepared).tx_blob)
  const out = await api(`/api/super-vaults/${superId}/counter-sign`, { tx_json: halfSigned }, W.broker)
  log(`  ${out.result_code === 'tesSUCCESS' ? 'OK  ' : 'FAIL'} LoanSet via API${''.padEnd(19)} ${out.result_code}`)
  log(`       ${EX}${out.hash}`)
  if (out.result_code !== 'tesSUCCESS') throw new Error('counter-sign failed')
  log(`  LoanID ${out.loan_id}`)

  log('\n── 6. Deployment account allocates ──')
  const each = String(Math.floor(Number(vaultNow.AssetsAvailable) / 2))
  for (const s of subs) {
    const d = await api(`/api/super-vaults/${superId}/allocations/${s.id}/deposit`, { amount: each }, W.broker)
    log(`  ${d.result_code === 'tesSUCCESS' ? 'OK  ' : 'FAIL'} deposit -> ${s.name.padEnd(22)} ${d.result_code}`)
  }

  log('\n── 7. Deployed state ──')
  const deployed = await api(`/api/super-vaults/${superId}`)
  log(`  status ${deployed.status}  loan ${deployed.loan_id?.slice(0, 16)}…`)
  for (const a of deployed.allocations) {
    log(`   - ${(a.sub_vault_name ?? '').padEnd(18)} ${a.target_bps / 100}%  funded: ${a.deposited_tx ? 'yes' : 'no'}`)
  }

  // Price per share before anything is repaid, to compare against at the end.
  const ppsOf = async () => {
    const v = (await client.request({ command: 'ledger_entry', index: superId })).result.node
    const i = (await client.request({ command: 'ledger_entry', mpt_issuance: v.ShareMPTID })).result.node
    const out = Number(i.OutstandingAmount ?? 0)
    return { pps: out ? Number(v.AssetsTotal ?? 0) / out : null, assets: v.AssetsTotal, outstanding: out }
  }
  const before = await ppsOf()
  log(`  super vault assets ${before.assets} drops, price/share ${before.pps?.toFixed(8)}`)

  log('\n── 8. Waiting for the sub-funds to reach Redemption ──')
  const redeemAt = T0 + SUB_FUND.red * 60_000
  while ((await ledgerNow()) < redeemAt + 4000) {
    log(`  ${Math.max(0, Math.round((redeemAt - (await ledgerNow())) / 1000))}s…`); await wait(15000)
  }

  log('\n── 9. Deployment account redeems its sub-fund positions ──')
  let state = await api(`/api/super-vaults/${superId}/unwind`)
  if (!state.configured) throw new Error('unwind state says no deployment account is configured')
  for (const p of state.positions.filter((x) => Number(x.shares) > 0)) {
    const name = subs.find((s) => s.id === p.vault_id)?.name ?? p.vault_id.slice(0, 10)
    const w = await api(`/api/super-vaults/${superId}/allocations/${p.vault_id}/withdraw`,
      { shares: p.shares }, W.broker)
    log(`  ${w.result_code === 'tesSUCCESS' ? 'OK  ' : 'FAIL'} VaultWithdraw <- ${name.padEnd(18)} ${w.result_code}`)
    if (w.result_code !== 'tesSUCCESS') throw new Error(`redeem ${name}: ${w.result_code}`)
  }

  state = await api(`/api/super-vaults/${superId}/unwind`)
  const held = state.positions.filter((p) => Number(p.shares) > 0)
  log(`  deployment account holds ${state.balance} XRP, ${held.length} position(s) left`)

  log('\n── 10. Repay the curator loan ──')
  if (!state.loan) throw new Error('the loan is already gone before repayment')
  const dueMs = xrpl.rippleTimeToUnixTime(state.loan.next_due)
  log(`  outstanding ${state.loan.outstanding}, ${state.loan.remaining} payment(s) left,`
    + ` next due in ${Math.round((dueMs - (await ledgerNow())) / 1000)}s`)

  // Exactly what UnwindPanel sends: the whole outstanding, rounded up to a drop.
  const amount = String(Math.ceil(Number(state.loan.outstanding)))
  const rep = await api(`/api/super-vaults/${superId}/repay`, { amount }, W.broker)
  log(`  ${rep.result_code === 'tesSUCCESS' ? 'OK  ' : 'FAIL'} LoanPay ${amount} drops${''.padEnd(9)} ${rep.result_code}`)
  log(`       ${EX}${rep.hash}`)
  if (rep.result_code !== 'tesSUCCESS') throw new Error(`LoanPay: ${rep.result_code}`)

  log('\n── 11. What the depositor is left holding ──')
  const after = await ppsOf()
  const post = await api(`/api/super-vaults/${superId}/unwind`)
  log(`  super vault assets ${before.assets} -> ${after.assets} drops`)
  log(`  price per share    ${before.pps?.toFixed(8)} -> ${after.pps?.toFixed(8)}`)
  log(`  loan               ${post.loan ? `still ${post.loan.outstanding} outstanding` : 'repaid and closed'}`)
  if (after.pps <= before.pps) {
    log('  WARNING price per share did not rise: the repayment did not reach the vault')
  }
  log(`\nSuper vault ${superId}`)
  await client.disconnect()
}

main().catch(async (e) => {
  console.error(`\nFAILED: ${e.message}`)
  if (client.isConnected()) await client.disconnect()
  process.exitCode = 1
})
