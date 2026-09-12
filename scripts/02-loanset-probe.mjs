/** Probe the XLS-66 two-party LoanSet signing order against an existing broker. */
import * as xrpl from 'xrpl'
import fs from 'node:fs'

const c = new xrpl.Client('wss://s.devnet.rippletest.net:51233/')
const seeds = JSON.parse(fs.readFileSync('data/accounts.json', 'utf8'))
const W = Object.fromEntries(Object.entries(seeds).map(([k, s]) => [k, xrpl.Wallet.fromSeed(s)]))

await c.connect()
const objs = await c.request({ command: 'account_objects', account: W.broker.address, type: 'loan_broker' })
const broker = objs.result.account_objects.at(-1)
console.log('LoanBrokerID:', broker.index, ' VaultID:', broker.VaultID)

const tx = {
  TransactionType: 'LoanSet', Account: W.broker.address,
  LoanBrokerID: broker.index, PrincipalRequested: xrpl.xrpToDrops('20'),
  Counterparty: W.borrower.address, InterestRate: 5000,
  PaymentInterval: 60, PaymentTotal: 3, GracePeriod: 30,
}

const prepared = await c.autofill(tx)
console.log('\n1. originator signs first...')
const first = W.broker.sign(prepared)
console.log('   -> keys:', Object.keys(first).join(', '))

console.log('2. counterparty signs...')
const cp = xrpl.signLoanSetByCounterparty(W.borrower, first.tx_blob)
console.log('   -> type:', typeof cp, '| keys:', typeof cp === 'object' ? Object.keys(cp).join(', ') : '(string)')

console.log('3. submit (no combine — that is multisign-only)...')
const res = await c.submitAndWait(cp.tx_blob)
const code = res.result.meta?.TransactionResult
console.log(`   ${code}  https://devnet.xrpl.org/transactions/${res.result.hash}`)
if (code === 'tesSUCCESS') {
  const loan = res.result.meta.AffectedNodes.map(n => n.CreatedNode).find(n => n?.LedgerEntryType === 'Loan')
  console.log('   LoanID:', loan?.LedgerIndex)
}
await c.disconnect()
