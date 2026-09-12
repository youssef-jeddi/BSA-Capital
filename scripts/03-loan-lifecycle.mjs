/**
 * Full XLS-66 loan lifecycle, including the two-party LoanSet.
 *
 * A counterparty signature is NOT signed with the standard transaction prefix.
 * encodeForSigning() emits 0x53545800 ("STX"); the counterparty must sign the
 * same bytes with 0x43505400 ("CPT"). xrpl.js 5.2.0-beta.0 omitted this and so
 * always produced "Counterparty: Invalid signature"; 5.2.0-beta.1 fixes it, so
 * signLoanSetByCounterparty() is now used directly.
 */
import * as xrpl from 'xrpl'
import codec from 'ripple-binary-codec'
import fs from 'node:fs'
const { encode } = codec

const c = new xrpl.Client('wss://s.devnet.rippletest.net:51233/')
const EX = 'https://devnet.xrpl.org/transactions/'
const W = Object.fromEntries(
  Object.entries(JSON.parse(fs.readFileSync('data/accounts.json', 'utf8')))
    .map(([k, s]) => [k, xrpl.Wallet.fromSeed(s)]))

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (...a) => console.log(...a)

/** Sign a LoanSet as the counterparty (beta.1 applies the CPT prefix internally). */
export const signAsCounterparty = (signedBlob, wallet) =>
  xrpl.signLoanSetByCounterparty(wallet, signedBlob).tx

async function send(label, wallet, tx) {
  try {
    const r = await c.submitAndWait(wallet.sign(await c.autofill(tx)).tx_blob)
    const code = r.result.meta?.TransactionResult
    log(`  ${code === 'tesSUCCESS' ? 'OK  ' : 'FAIL'} ${label.padEnd(30)} ${code}`)
    if (code === 'tesSUCCESS') log(`       ${EX}${r.result.hash}`)
    return r.result
  } catch (e) {
    log(`  FAIL ${label.padEnd(30)} ${(e?.data?.error_exception ?? e.message).slice(0, 90)}`)
    return null
  }
}
const created = (r, t) => r?.meta?.AffectedNodes?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)
const ledgerNow = async () =>
  xrpl.rippleTimeToUnixTime((await c.request({ command: 'ledger', ledger_index: 'validated' })).result.ledger.close_time)

async function main() {
  await c.connect()
  for (const n of ['broker', 'borrower', 'lpA']) {
    await c.fundWallet(W[n]).catch(() => {})
    log(`${n.padEnd(9)} ${W[n].address}  ${await c.getXrpBalance(W[n].address)} XRP`)
  }

  const SUB_MIN = 2, RED_MIN = 40
  const t0 = Date.now()
  log(`\n── Vault: Subscription ${SUB_MIN}m, Redemption ${RED_MIN}m ──`)
  const vr = await send('VaultCreate', W.broker, {
    TransactionType: 'VaultCreate', Account: W.broker.address,
    Asset: { currency: 'XRP' }, VaultKind: 1, WithdrawalPolicy: 1,
    SubscriptionDate: xrpl.unixTimeToRippleTime(t0 + SUB_MIN * 60000),
    RedemptionDate: xrpl.unixTimeToRippleTime(t0 + RED_MIN * 60000),
    MPTokenMetadata: Buffer.from(JSON.stringify({
      ticker: 'BSAF1', name: 'BSA Fund I Shares', issuer_name: 'BSA Capital',
      asset_class: 'rwa', asset_subclass: 'private_credit', icon: 'https://bsa.capital/i.png',
    })).toString('hex').toUpperCase(),
  })
  const vaultId = created(vr, 'Vault')?.LedgerIndex
  log(`  VaultID ${vaultId}`)

  const br = await send('LoanBrokerSet', W.broker, {
    TransactionType: 'LoanBrokerSet', Account: W.broker.address,
    VaultID: vaultId, ManagementFeeRate: 100, DebtMaximum: xrpl.xrpToDrops('1000'),
  })
  const brokerId = created(br, 'LoanBroker')?.LedgerIndex
  log(`  LoanBrokerID ${brokerId}`)

  log('\n── Subscription: deposit ──')
  await send('VaultDeposit 60 XRP', W.lpA, {
    TransactionType: 'VaultDeposit', Account: W.lpA.address, VaultID: vaultId, Amount: xrpl.xrpToDrops('60'),
  })

  log('\n── Waiting for Investment phase ──')
  const subUnix = t0 + SUB_MIN * 60000
  while ((await ledgerNow()) < subUnix + 5000) {
    log(`  ${Math.round((subUnix - (await ledgerNow())) / 1000)}s…`); await wait(15000)
  }
  log('  Investment phase reached.')

  log('\n── Two-party LoanSet (CPT prefix) ──')
  const prepared = await c.autofill({
    TransactionType: 'LoanSet', Account: W.broker.address, Counterparty: W.borrower.address,
    LoanBrokerID: brokerId, PrincipalRequested: xrpl.xrpToDrops('20'),
    InterestRate: 5000, PaymentInterval: 120, PaymentTotal: 3, GracePeriod: 60, // 60s is the ledger floor
  })
  const legA = W.broker.sign(prepared).tx_blob          // originator signs first
  const full = signAsCounterparty(legA, W.borrower)     // counterparty signature
  let loanId
  try {
    const r = await c.submitAndWait(encode(full))
    const code = r.result.meta?.TransactionResult
    log(`  ${code === 'tesSUCCESS' ? 'OK  ' : 'FAIL'} LoanSet                        ${code}`)
    log(`       ${EX}${r.result.hash}`)
    loanId = created(r.result, 'Loan')?.LedgerIndex
    log(`  LoanID ${loanId}`)
  } catch (e) { log(`  FAIL LoanSet: ${(e?.data?.error_exception ?? e.message).slice(0, 120)}`) }

  if (loanId) {
    const loan = (await c.request({ command: 'ledger_entry', index: loanId })).result.node
    log(`  periodic payment ${loan.PeriodicPayment}  outstanding ${loan.TotalValueOutstanding}`)
    log('\n── LoanPay ──')
    const before = (await c.request({ command: 'ledger_entry', index: vaultId })).result.node
    // Loan.PeriodicPayment is stored with fractional precision (e.g. 333333.3967…);
    // an XRP Amount must be whole drops, so round up rather than underpay.
    const due = String(Math.ceil(Number(loan.PeriodicPayment)))
    log(`  PeriodicPayment ${loan.PeriodicPayment} -> paying ${due} drops`)
    await send('LoanPay', W.borrower, {
      TransactionType: 'LoanPay', Account: W.borrower.address, LoanID: loanId, Amount: due,
    })
    const after = (await c.request({ command: 'ledger_entry', index: vaultId })).result.node
    const iss = (await c.request({ command: 'ledger_entry', mpt_issuance: after.ShareMPTID })).result.node
    log(`  vault AssetsTotal ${before.AssetsTotal} -> ${after.AssetsTotal}`)
    log(`  PPS ${Number(before.AssetsTotal) / Number(iss.OutstandingAmount)} -> ${Number(after.AssetsTotal) / Number(iss.OutstandingAmount)}`)
  }
  log(`\nVaultID=${vaultId}\nLoanBrokerID=${brokerId}`)
  await c.disconnect()
}
main().catch(async (e) => { console.error('FATAL', e); await c.disconnect() })
