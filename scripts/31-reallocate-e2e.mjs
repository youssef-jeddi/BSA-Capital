/**
 * A curator rebalances a super vault mid-term, through our own secondary market.
 *
 * The point being proven: a sub-fund position locked in Investment cannot be
 * withdrawn, but it can be sold, and the proceeds can be deposited into a fund
 * that is still raising. The lock is asserted on the way, so the run fails if
 * the premise ever stops being true.
 *
 *   A  source fund, closes early so it is locked when we come to move it
 *   C  destination fund, still raising
 *
 * Takes about 8 minutes of Devnet wall time.
 */
import * as xrpl from 'xrpl'
import fs from 'node:fs'
import path from 'node:path'
import { proveControl } from './lib/auth.mjs'

const API = process.env.API ?? 'http://127.0.0.1:8787'
const ROOT = path.resolve(import.meta.dirname, '..')
const EX = 'https://devnet.xrpl.org/transactions/'
const c = new xrpl.Client('wss://s.devnet.rippletest.net:51233/')

const log = (...a) => console.log(...a)
const hex = (s) => Buffer.from(s).toString('hex').toUpperCase()
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const xrpOf = (drops) => (Number(drops) / 1e6).toFixed(6).replace(/\.?0+$/, '')

// A closes before the super vault's loan matures; C is still raising when we
// come to redeploy. Both must redeem before the loan matures, or the cascade
// check refuses the move.
const A = { sub: 4, red: 34 }
const C = { sub: 25, red: 34 }
const SV = { sub: 3, loan: 40, red: 50 }

async function api(p, body, method = 'POST', wallet) {
  const payload = body && wallet ? { ...body, proof: await proveControl(API, wallet) } : body
  const res = await fetch(API + p, payload
    ? { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }
    : undefined)
  const j = await res.json().catch(() => null)
  if (!res.ok) throw new Error(j?.errors?.[0] ?? `HTTP ${res.status} ${p}`)
  return j
}

async function send(label, w, tx, expect = 'tesSUCCESS') {
  let code, hash, result
  try {
    const r = await c.submitAndWait(w.sign(await c.autofill(tx)).tx_blob)
    code = r.result.meta?.TransactionResult; hash = r.result.hash; result = r.result
  } catch (e) {
    code = /\b(te[cflms][A-Z_]+)/.exec(e?.data?.error_exception ?? e.message)?.[1] ?? 'ERROR'
  }
  const good = code === expect
  log(`  ${good ? 'OK  ' : 'FAIL'} ${label.padEnd(44)} ${code}${good ? '' : `  (expected ${expect})`}`)
  if (!good) throw new Error(`${label}: ${code}, expected ${expect}`)
  return { code, hash, result }
}

const created = (r, t) => r?.meta?.AffectedNodes?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)
const ledgerNow = async () =>
  xrpl.rippleTimeToUnixTime((await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger.close_time)

async function until(ms, label) {
  while ((await ledgerNow()) < ms + 4000) {
    log(`  ${Math.max(0, Math.round((ms - (await ledgerNow())) / 1000))}s… (${label})`)
    await wait(15000)
  }
}

const shareBalance = (account, mpt) => c.request({
  command: 'ledger_entry', mptoken: { mpt_issuance_id: mpt, account },
}).then((r) => String(r.result.node.MPTAmount ?? '0')).catch(() => '0')

const meta = (ticker, name) => hex(JSON.stringify({
  ticker, name: `${name} Shares`, issuer_name: 'BSA Capital', asset_class: 'rwa',
  asset_subclass: 'private_credit', icon: 'https://bsa.capital/icon.png',
}))

let T0
const rt = (min) => xrpl.unixTimeToRippleTime(T0 + min * 60_000)

async function main() {
  await c.connect()
  T0 = Date.now()

  const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/accounts.json'), 'utf8'))
  const curator = xrpl.Wallet.fromSeed(seeds.broker)
  const depositor = xrpl.Wallet.fromSeed(seeds.lpA)
  for (const w of [curator, depositor]) await c.fundWallet(w).catch(() => {})
  const buyer = (await c.fundWallet()).wallet

  const deployer = await api('/api/deployment-account', null, 'GET')
  if (!deployer.configured) throw new Error('Run: npm run supervault-account')
  log(`Curator    ${curator.address}`)
  log(`Depositor  ${depositor.address}`)
  log(`Deployment ${deployer.address}`)
  log(`Buyer      ${buyer.address}\n`)

  await api('/api/companies', {
    address: curator.address, name: 'BSA Capital',
    activity: 'Private credit fund manager', country: 'FR',
  }, 'POST', curator).catch(() => {})

  // The deployment account must be able to deposit into a gated fund later.
  const cred = await api('/api/deployment-account/credentials', {})
  log(`Deployment account zones: ${cred.zones.map((z) => z.zone).join(', ')}\n`)

  log('── 1. Source fund A and destination fund C ──')
  const funds = {}
  for (const [key, spec, ticker, name] of [
    ['A', A, 'E2EA', 'Reallocate Source A'],
    ['C', C, 'E2EC', 'Reallocate Target C'],
  ]) {
    const r = await send(`VaultCreate ${name}`, curator, {
      TransactionType: 'VaultCreate', Account: curator.address, Asset: { currency: 'XRP' },
      VaultKind: 1, WithdrawalPolicy: 1,
      SubscriptionDate: rt(spec.sub), RedemptionDate: rt(spec.red),
      AssetsMaximum: xrpl.xrpToDrops('2000'), MPTokenMetadata: meta(ticker, name),
      Data: hex(JSON.stringify({ name })),
    })
    const id = created(r.result, 'Vault').LedgerIndex
    const br = await send(`LoanBrokerSet ${key}`, curator, {
      TransactionType: 'LoanBrokerSet', Account: curator.address, VaultID: id,
      ManagementFeeRate: 100, DebtMaximum: xrpl.xrpToDrops('2000'),
    })
    await api('/api/vaults', {
      vault_id: id, company_address: curator.address, name,
      loan_broker_id: created(br.result, 'LoanBroker')?.LedgerIndex,
      asset_code: 'XRP', subscription_date: rt(spec.sub), redemption_date: rt(spec.red),
    }, 'POST', curator)
    funds[key] = { id, name }
  }

  log('\n── 2. Super vault, 100% into A ──')
  const svr = await send('VaultCreate (super)', curator, {
    TransactionType: 'VaultCreate', Account: curator.address, Asset: { currency: 'XRP' },
    VaultKind: 1, WithdrawalPolicy: 1,
    SubscriptionDate: rt(SV.sub), RedemptionDate: rt(SV.red),
    AssetsMaximum: xrpl.xrpToDrops('5000'), MPTokenMetadata: meta('E2ERA', 'Reallocating Super'),
    Data: hex(JSON.stringify({ name: 'Reallocating Super Vault', kind: 'super' })),
  })
  const superId = created(svr.result, 'Vault').LedgerIndex
  const svb = await send('LoanBrokerSet (super)', curator, {
    TransactionType: 'LoanBrokerSet', Account: curator.address, VaultID: superId,
    ManagementFeeRate: 100, DebtMaximum: xrpl.xrpToDrops('5000'),
  })
  await api('/api/super-vaults', {
    vault_id: superId, curator_address: curator.address, deployment_address: deployer.address,
    loan_broker_id: created(svb.result, 'LoanBroker').LedgerIndex,
    name: 'Reallocating Super Vault', strategy: 'One fund, then another',
    subscription_date: rt(SV.sub), redemption_date: rt(SV.red), loan_maturity: rt(SV.loan),
    allocations: [{ sub_vault_id: funds.A.id, target_bps: 10000 }],
  }, 'POST', curator)
  log('  indexed, 100% allocated to A')

  log('\n── 3. Depositor subscribes ──')
  await send('VaultDeposit 100 XRP', depositor, {
    TransactionType: 'VaultDeposit', Account: depositor.address, VaultID: superId,
    Amount: xrpl.xrpToDrops('100'),
  })

  log('\n── 4. Wait for the super vault to reach Investment ──')
  await until(T0 + SV.sub * 60_000, 'super vault locks')

  log('\n── 5. Curator lends to the deployment account, which funds A ──')
  const svNode = (await c.request({ command: 'ledger_entry', index: superId })).result.node
  const { loanSchedule } = await import('../web/src/lib/superVault.js')
  const sched = loanSchedule({ maturityRippleTime: rt(SV.loan), nowMs: Date.now() })
  if (sched.error) throw new Error(sched.error)
  const prepared = await c.autofill({
    TransactionType: 'LoanSet', Account: curator.address, Counterparty: deployer.address,
    LoanBrokerID: created(svb.result, 'LoanBroker').LedgerIndex,
    PrincipalRequested: String(svNode.AssetsAvailable), InterestRate: 5000,
    PaymentInterval: sched.PaymentInterval, PaymentTotal: sched.PaymentTotal,
    GracePeriod: sched.GracePeriod,
  })
  const half = xrpl.decode(curator.sign(prepared).tx_blob)
  const loan = await api(`/api/super-vaults/${superId}/counter-sign`, { tx_json: half }, 'POST', curator)
  log(`  OK   LoanSet${''.padEnd(37)} ${loan.result_code}`)
  if (loan.result_code !== 'tesSUCCESS') throw new Error(`LoanSet: ${loan.result_code}`)

  const dep = await api(`/api/super-vaults/${superId}/allocations/${funds.A.id}/deposit`,
    { amount: String(svNode.AssetsAvailable) }, 'POST', curator)
  log(`  OK   deposit -> A${''.padEnd(29)} ${dep.result_code}`)
  if (dep.result_code !== 'tesSUCCESS') throw new Error(`deposit: ${dep.result_code}`)

  const aVault = (await c.request({ command: 'ledger_entry', index: funds.A.id })).result.node
  const aMpt = aVault.ShareMPTID
  const heldBefore = await shareBalance(deployer.address, aMpt)
  log(`  deployment account holds ${heldBefore} shares of A`)

  log('\n── 6. Wait for A to lock, and prove it ──')
  await until(T0 + A.sub * 60_000, 'fund A locks')
  // Through the API, so the deployment account's own key signs it. This is the
  // premise of the whole feature: the position cannot be withdrawn, only sold.
  const locked = await api(`/api/super-vaults/${superId}/allocations/${funds.A.id}/withdraw`,
    { shares: heldBefore }, 'POST', curator)
  const lockOk = locked.result_code === 'tecTOO_SOON'
  log(`  ${lockOk ? 'OK  ' : 'FAIL'} VaultWithdraw refused${''.padEnd(23)} ${locked.result_code}`)
  if (!lockOk) throw new Error(`expected tecTOO_SOON, got ${locked.result_code} — the position is not locked`)

  log('\n── 7. Curator exits A onto the secondary market ──')
  const exit = await api(`/api/super-vaults/${superId}/allocations/${funds.A.id}/exit`,
    { discount_bps: 200 }, 'POST', curator)
  log(`  listed ${exit.listing.id} · ${exit.shares} shares`)
  log(`  nav ${xrpOf(exit.nav_drops_total)} XRP, ask ${xrpOf(exit.ask_drops)} XRP,`
    + ` haircut ${xrpOf(exit.haircut_drops)} XRP`)
  log(`  ${EX}${exit.transfer_hash}`)
  if ((await shareBalance(deployer.address, aMpt)) !== '0') {
    throw new Error('the shares did not leave the deployment account')
  }
  log('  deployment account now holds 0 shares of A')

  log('\n── 8. Redeploying before the sale is refused ──')
  await api(`/api/super-vaults/${superId}/reallocate`,
    { from_sub_vault_id: funds.A.id, to_sub_vault_id: funds.C.id }, 'POST', curator)
    .then(() => { throw new Error('redeploy should have been refused before the sale') })
    .catch((e) => {
      if (!/Nobody has bought/.test(e.message)) throw e
      log(`  OK   refused: ${e.message}`)
    })

  log('\n── 9. A buyer takes the position ──')
  const el = () => api(`/api/market/eligibility?vault=${funds.A.id}&account=${buyer.address}`, null, 'GET')
  await send('MPTokenAuthorize (buyer)', buyer, {
    TransactionType: 'MPTokenAuthorize', Account: buyer.address, MPTokenIssuanceID: aMpt,
  })
  const ready = await el()
  log(`  eligibility: credentialed=${ready.credentialed} opted_in=${ready.opted_in} ready=${ready.ready}`)
  if (!ready.ready) throw new Error('buyer is not eligible; fund A should be ungated in this run')

  const pay = await send('Payment buyer -> deployment account', buyer, {
    TransactionType: 'Payment', Account: buyer.address, Destination: deployer.address,
    Amount: String(exit.ask_drops),
  })
  const sold = await api(`/api/market/listings/${exit.listing.id}/settle`,
    { payment_hash: pay.hash }, 'POST', buyer)
  log(`  OK   settled -> ${sold.status}, delivery ${sold.delivery_hash?.slice(0, 12)}…`)
  log(`  buyer now holds ${await shareBalance(buyer.address, aMpt)} shares of A`)

  log('\n── 10. Curator redeploys the proceeds into C ──')
  const moved = await api(`/api/super-vaults/${superId}/reallocate`,
    { from_sub_vault_id: funds.A.id, to_sub_vault_id: funds.C.id }, 'POST', curator)
  log(`  OK   VaultDeposit -> C${''.padEnd(23)} ${moved.result_code}`)
  log(`  moved ${xrpOf(moved.moved_drops)} XRP`)
  log(`  ${EX}${moved.hash}`)

  log('\n── 11. Final state ──')
  const cVault = (await c.request({ command: 'ledger_entry', index: funds.C.id })).result.node
  const inA = await shareBalance(deployer.address, aMpt)
  const inC = await shareBalance(deployer.address, cVault.ShareMPTID)
  log(`  shares of A: ${inA}   shares of C: ${inC}`)

  const final = await api(`/api/super-vaults/${superId}`, null, 'GET')
  for (const a of final.allocations) {
    log(`   - ${(a.sub_vault_name ?? '?').padEnd(22)} ${String(a.status).padEnd(8)}`
      + ` ${a.target_bps / 100}%${a.replaced_by ? ` -> ${a.replaced_by.slice(0, 8)}…` : ''}`)
  }

  const unwind = await api(`/api/super-vaults/${superId}/unwind`, null, 'GET')
  log(`  unwind now tracks ${unwind.positions.length} position(s):`
    + ` ${unwind.positions.map((p) => `${p.vault_id.slice(0, 8)}…=${p.shares}`).join(' ')}`)

  const problems = []
  if (inA !== '0') problems.push(`still holding ${inA} shares of A`)
  if (BigInt(inC) <= 0n) problems.push('holds no shares of C')
  const rowA = final.allocations.find((a) => a.sub_vault_id === funds.A.id)
  const rowC = final.allocations.find((a) => a.sub_vault_id === funds.C.id)
  if (rowA?.status !== 'exited') problems.push(`A is ${rowA?.status}, expected exited`)
  if (rowA?.replaced_by !== funds.C.id) problems.push('A does not record what replaced it')
  if (rowC?.status !== 'active') problems.push(`C is ${rowC?.status}, expected active`)
  if (rowC?.target_bps !== 10000) problems.push(`C carries ${rowC?.target_bps} bps, expected 10000`)
  if (unwind.positions.some((p) => p.vault_id === funds.A.id)) problems.push('unwind still tracks A')

  if (problems.length) {
    log(`\nFAILED assertions:\n  - ${problems.join('\n  - ')}`)
    throw new Error(`${problems.length} assertion(s) failed`)
  }
  log('\nReallocation complete: A sold on the secondary market, proceeds deposited into C.')
  log(`Super vault ${superId}`)
  await c.disconnect()
}

main().catch(async (e) => {
  console.error(`\nFAILED: ${e.message}`)
  if (c.isConnected()) await c.disconnect()
  process.exitCode = 1
})
