/**
 * Stage 1 spike — Track 2, public XRPL Devnet, xrpl.js 5.2.0-beta.0
 *
 * Answers, with real tx hashes:
 *   1. Does VaultCreate accept VaultKind=closed + Subscription/RedemptionDate?
 *   2. Which MPT flags does the vault put on its share issuance?
 *   3. Does a private vault + DomainID actually gate deposits on credentials?
 *   4. Is LoanSet rejected during the Subscription phase, and with what code?
 *
 * Every submission is appended to data/tx-log.jsonl.
 */
import * as xrpl from 'xrpl'
import fs from 'node:fs'
import path from 'node:path'

const WSS       = 'wss://s.devnet.rippletest.net:51233/'
const EXPLORER  = 'https://devnet.xrpl.org/transactions/'
const ROOT      = path.resolve(import.meta.dirname, '..')
const ACCOUNTS  = path.join(ROOT, 'data/accounts.json')
const TXLOG     = path.join(ROOT, 'data/tx-log.jsonl')

// Compressed lifecycle. Subscription runs from now until SUB_MINUTES from now.
const SUB_MINUTES = Number(process.env.SUB_MINUTES ?? 6)
const RED_MINUTES = Number(process.env.RED_MINUTES ?? 20)

const KYC_TYPE = Buffer.from('KYC_TIER1').toString('hex').toUpperCase()
const client   = new xrpl.Client(WSS)

const log = (...a) => console.log(...a)
const hx  = (s) => `${s}\n     ${EXPLORER}${s}`

/** Submit and never throw: returns {ok, code, hash, result}. Records everything. */
async function submit(intent, wallet, tx) {
  const started = Date.now()
  let entry = { intent, account: wallet.address, type: tx.TransactionType, at: new Date().toISOString() }
  try {
    const prepared = await client.autofill(tx)
    const signed   = wallet.sign(prepared)
    const res      = await client.submitAndWait(signed.tx_blob)
    const code     = res.result.meta?.TransactionResult
    entry = { ...entry, ok: code === 'tesSUCCESS', code, hash: res.result.hash, ms: Date.now() - started }
    fs.appendFileSync(TXLOG, JSON.stringify(entry) + '\n')
    log(`  ${entry.ok ? 'OK  ' : 'FAIL'} ${intent.padEnd(38)} ${code}`)
    if (entry.hash) log(`       ${EXPLORER}${entry.hash}`)
    return { ...entry, result: res.result }
  } catch (e) {
    // Pre-flight rejections (tem*, validation errors) land here, not on the ledger.
    const code = e?.data?.result?.engine_result ?? e?.message ?? String(e)
    entry = { ...entry, ok: false, code, error: true, ms: Date.now() - started }
    fs.appendFileSync(TXLOG, JSON.stringify(entry) + '\n')
    log(`  FAIL ${intent.padEnd(38)} ${code}`)
    return entry
  }
}

/** LoanSet needs BOTH parties. Counterparty approves the prepared terms, then the originator signs. */
async function submitLoanSet(intent, originator, counterparty, tx) {
  const started = Date.now()
  let entry = { intent, account: originator.address, type: 'LoanSet', at: new Date().toISOString() }
  try {
    const prepared = await client.autofill(tx)
    const cpSigned = xrpl.signLoanSetByCounterparty(counterparty, prepared)
    const combined = xrpl.combineLoanSetCounterpartySigners([cpSigned])
    const full = typeof combined === 'object' && combined.CounterpartySignature
      ? { ...prepared, CounterpartySignature: combined.CounterpartySignature }
      : { ...prepared, ...(typeof combined === 'object' ? combined : {}) }
    const signed = originator.sign(full)
    const res = await client.submitAndWait(signed.tx_blob)
    const code = res.result.meta?.TransactionResult
    entry = { ...entry, ok: code === 'tesSUCCESS', code, hash: res.result.hash, ms: Date.now() - started }
    fs.appendFileSync(TXLOG, JSON.stringify(entry) + '\n')
    log(`  ${entry.ok ? 'OK  ' : 'FAIL'} ${intent.padEnd(38)} ${code}`)
    if (entry.hash) log(`       ${EXPLORER}${entry.hash}`)
    return { ...entry, result: res.result }
  } catch (e) {
    const code = e?.data?.result?.engine_result ?? e?.message ?? String(e)
    entry = { ...entry, ok: false, code, error: true, ms: Date.now() - started }
    fs.appendFileSync(TXLOG, JSON.stringify(entry) + '\n')
    log(`  FAIL ${intent.padEnd(38)} ${code}`)
    return entry
  }
}

async function accounts() {
  if (fs.existsSync(ACCOUNTS)) {
    const saved = JSON.parse(fs.readFileSync(ACCOUNTS, 'utf8'))
    log('Reusing accounts from data/accounts.json')
    return Object.fromEntries(Object.entries(saved).map(([k, seed]) => [k, xrpl.Wallet.fromSeed(seed)]))
  }
  log('Funding 4 accounts from the Devnet faucet...')
  const names = ['issuer', 'broker', 'lpA', 'borrower', 'outsider']
  const out = {}
  for (const n of names) {
    const { wallet } = await client.fundWallet()
    out[n] = wallet
    log(`  ${n.padEnd(9)} ${wallet.address}`)
  }
  fs.writeFileSync(ACCOUNTS, JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, w]) => [k, w.seed])), null, 2))
  return out
}

/** Pull the first ledger entry of a given type created by a transaction. */
const created = (res, type) => res?.meta?.AffectedNodes
  ?.map((n) => n.CreatedNode)
  .find((n) => n?.LedgerEntryType === type)

async function main() {
  await client.connect()
  log(`Connected. Ledger ${(await client.getLedgerIndex())}\n`)

  const a = await accounts()

  log('\n── 1. Credentials (XLS-70) ──')
  for (const who of ['broker', 'lpA', 'borrower']) {
    await submit(`CredentialCreate -> ${who}`, a.issuer, {
      TransactionType: 'CredentialCreate', Account: a.issuer.address,
      Subject: a[who].address, CredentialType: KYC_TYPE,
    })
    await submit(`CredentialAccept by ${who}`, a[who], {
      TransactionType: 'CredentialAccept', Account: a[who].address,
      Issuer: a.issuer.address, CredentialType: KYC_TYPE,
    })
  }
  log('  (outsider deliberately gets NO credential)')

  log('\n── 2. Permissioned domain (XLS-80) ──')
  const dom = await submit('PermissionedDomainSet', a.issuer, {
    TransactionType: 'PermissionedDomainSet', Account: a.issuer.address,
    AcceptedCredentials: [{ Credential: { Issuer: a.issuer.address, CredentialType: KYC_TYPE } }],
  })
  const domainID = created(dom.result, 'PermissionedDomain')?.LedgerIndex
  log(`  DomainID = ${domainID}`)

  log('\n── 3. Closed-ended private vault (XLS-65) ──')
  const now = Math.floor(Date.now() / 1000)
  const subscriptionDate = xrpl.unixTimeToRippleTime((now + SUB_MINUTES * 60) * 1000)
  const redemptionDate   = xrpl.unixTimeToRippleTime((now + RED_MINUTES * 60) * 1000)
  log(`  Subscription ends ${new Date((now + SUB_MINUTES * 60) * 1000).toLocaleTimeString()}  (ripple ${subscriptionDate})`)
  log(`  Redemption  opens ${new Date((now + RED_MINUTES * 60) * 1000).toLocaleTimeString()}  (ripple ${redemptionDate})`)

  const vc = await submit('VaultCreate (closed + private)', a.broker, {
    TransactionType: 'VaultCreate', Account: a.broker.address,
    Asset: { currency: 'XRP' },
    VaultKind: 1,                       // vaultKindClosed
    Flags: xrpl.VaultCreateFlags.tfVaultPrivate,
    DomainID: domainID,
    SubscriptionDate: subscriptionDate,
    RedemptionDate: redemptionDate,
    AssetsMaximum: xrpl.xrpToDrops('5000'),
    WithdrawalPolicy: 1,
    Data: Buffer.from(JSON.stringify({ name: 'BSA Capital Test Fund I' })).toString('hex').toUpperCase(),
  })
  if (!vc.ok) { log('\nVaultCreate failed — stopping here. This is the headline finding.'); return finish() }

  const vaultID = created(vc.result, 'Vault')?.LedgerIndex
  const vault   = (await client.request({ command: 'ledger_entry', index: vaultID })).result.node
  log(`  VaultID    = ${vaultID}`)
  log(`  pseudo-acct= ${vault.Account}`)
  log(`  ShareMPTID = ${vault.ShareMPTID}`)
  log(`  VaultKind  = ${vault.VaultKind}   Sub=${vault.SubscriptionDate}  Red=${vault.RedemptionDate}`)

  log('\n── 4. What flags did the vault put on the share MPT? ──')
  const iss = (await client.request({ command: 'ledger_entry', mpt_issuance: vault.ShareMPTID })).result.node
  const F = { lsfMPTLocked: 1, lsfMPTCanLock: 2, lsfMPTRequireAuth: 4, lsfMPTCanEscrow: 8,
              lsfMPTCanTrade: 16, lsfMPTCanTransfer: 32, lsfMPTCanClawback: 64 }
  const set = Object.entries(F).filter(([, v]) => (iss.Flags & v) === v).map(([k]) => k)
  log(`  Flags = ${iss.Flags} -> ${set.join(', ') || '(none)'}`)
  log(`  CanTransfer: ${set.includes('lsfMPTCanTransfer')}   CanTrade: ${set.includes('lsfMPTCanTrade')}   RequireAuth: ${set.includes('lsfMPTRequireAuth')}`)

  log('\n── 5. Deposit during Subscription ──')
  await submit('VaultDeposit 50 XRP (credentialed)', a.lpA, {
    TransactionType: 'VaultDeposit', Account: a.lpA.address,
    VaultID: vaultID, Amount: xrpl.xrpToDrops('50'),
  })

  log('\n── 6. REJECTION TESTS ──')
  await submit('VaultDeposit by UNCREDENTIALED acct', a.outsider, {
    TransactionType: 'VaultDeposit', Account: a.outsider.address,
    VaultID: vaultID, Amount: xrpl.xrpToDrops('10'),
  })
  const lb = await submit('LoanBrokerSet', a.broker, {
    TransactionType: 'LoanBrokerSet', Account: a.broker.address,
    VaultID: vaultID, ManagementFeeRate: 1000, DebtMaximum: xrpl.xrpToDrops('5000'),
  })
  const brokerID = created(lb.result, 'LoanBroker')?.LedgerIndex
  log(`  LoanBrokerID = ${brokerID}`)
  if (brokerID) {
    await submitLoanSet('LoanSet during SUBSCRIPTION (must fail)', a.broker, a.borrower, {
      TransactionType: 'LoanSet', Account: a.broker.address,
      LoanBrokerID: brokerID, PrincipalRequested: xrpl.xrpToDrops('20'),
      Counterparty: a.borrower.address, InterestRate: 5000,
      PaymentInterval: 60, PaymentTotal: 3, GracePeriod: 30,
    })
  }

  log('\n── 7. Vault state ──')
  const v2 = (await client.request({ command: 'ledger_entry', index: vaultID })).result.node
  const iss2 = (await client.request({ command: 'ledger_entry', mpt_issuance: vault.ShareMPTID })).result.node
  log(`  AssetsTotal=${v2.AssetsTotal}  AssetsAvailable=${v2.AssetsAvailable}  LossUnrealized=${v2.LossUnrealized ?? '0'}`)
  log(`  shares outstanding = ${iss2.OutstandingAmount}`)
  log(`  PPS = AssetsTotal / OutstandingAmount = ${Number(v2.AssetsTotal) / Number(iss2.OutstandingAmount || 1)}`)

  log(`\nSaved: data/accounts.json, data/tx-log.jsonl`)
  log(`VaultID for stage 2: ${vaultID}`)
  finish()
}

async function finish() { await client.disconnect(); }
main().catch(async (e) => { console.error('\nFATAL:', e); await finish(); process.exitCode = 1 })
