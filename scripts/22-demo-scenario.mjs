#!/usr/bin/env node
/**
 * Stands up a complete liquidity-marketplace scenario on Devnet, ready to trade in
 * the Marketplace tab.
 *
 * The story it builds, in order, because the ledger enforces that order:
 *   1. KYC credentials + a permissioned domain accepting them
 *   2. a private closed-ended vault gated on that domain
 *   3. three LPs subscribe (only possible during Subscription)
 *   4. the phase flips to Investment — LPs are now locked, VaultWithdraw is tecTOO_SOON
 *   5. the broker puts the capital to work: LoanBrokerSet + a two-party LoanSet.
 *      This raises AssetsTotal by InterestDue immediately, so NAV per share rises
 *      above 1 and a discount becomes meaningful rather than cosmetic.
 *   6. two LPs list shares with custody at different discounts
 *
 * Then a buyer in the browser needs a credential (Identity tab) and an MPTokenAuthorize
 * opt-in before they can receive shares — the ledger refuses otherwise.
 *
 *   node scripts/22-demo-scenario.mjs
 *   node scripts/22-demo-scenario.mjs --holder rYOURADDRESS   # also credential your wallet
 */
import * as xrpl from 'xrpl'
import codec from 'ripple-binary-codec'
import { ledger, master, toHex, CREDENTIAL_TYPE } from './lib/issuer.mjs'
import {
  custody, submit, ensureCustodyOptedIn, vaultSnapshot, createListing,
  sharesAmount, eligibility,
} from './lib/marketplace.mjs'

const SUB_SECONDS = 45
const RED_SECONDS = 900
const TYPE = toHex(CREDENTIAL_TYPE)
const EX = 'https://devnet.xrpl.org/transactions/'

const log = (...a) => console.log(...a)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const created = (r, t) => r?.result?.meta?.AffectedNodes
  ?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)

const holderArg = () => {
  const i = process.argv.indexOf('--holder')
  return i > 0 ? process.argv[i + 1] : null
}

async function credential(subject, wallet) {
  const r = await submit(master(), {
    TransactionType: 'CredentialCreate', Account: master().address,
    Subject: subject, CredentialType: TYPE,
  })
  if (!r.ok && r.code !== 'tecDUPLICATE') log(`   CredentialCreate -> ${subject} ${r.code}`)
  if (!wallet) return
  const a = await submit(wallet, {
    TransactionType: 'CredentialAccept', Account: subject,
    Issuer: master().address, CredentialType: TYPE,
  })
  if (!a.ok && a.code !== 'tecDUPLICATE') log(`   CredentialAccept by ${subject} ${a.code}`)
}

async function main() {
  const c = await ledger()
  log(`Devnet ledger ${await c.getLedgerIndex()}`)
  log(`master  ${master().address}`)
  log(`custody ${custody().address}\n`)

  log('── 1. Cast ──')
  const roles = ['alice', 'bob', 'carol', 'borrower', 'outsider']
  const W = {}
  for (const n of roles) {
    const { wallet } = await c.fundWallet()
    W[n] = wallet
    log(`   ${n.padEnd(9)} ${wallet.address}`)
  }
  log('   (outsider stays uncredentialed on purpose)')

  log('\n── 2. Credentials + domain ──')
  for (const n of ['alice', 'bob', 'carol', 'borrower']) await credential(W[n].address, W[n])
  const holder = holderArg()
  if (holder) {
    // Issued but not accepted — the browser wallet signs CredentialAccept itself.
    await credential(holder, null)
    log(`   credential issued to your wallet ${holder} (accept it in the Identity tab)`)
  }
  const dom = await submit(master(), {
    TransactionType: 'PermissionedDomainSet', Account: master().address,
    AcceptedCredentials: [{ Credential: { Issuer: master().address, CredentialType: TYPE } }],
  })
  const domainID = created(dom, 'PermissionedDomain')?.LedgerIndex
  log(`   DomainID ${domainID}`)

  log('\n── 3. Private closed-ended vault ──')
  const t0 = Date.now()
  const vc = await submit(master(), {
    TransactionType: 'VaultCreate', Account: master().address,
    Asset: { currency: 'XRP' }, VaultKind: 1, WithdrawalPolicy: 1,
    Flags: xrpl.VaultCreateFlags.tfVaultPrivate,
    DomainID: domainID,
    SubscriptionDate: xrpl.unixTimeToRippleTime(t0 + SUB_SECONDS * 1000),
    RedemptionDate: xrpl.unixTimeToRippleTime(t0 + RED_SECONDS * 1000),
    MPTokenMetadata: Buffer.from(JSON.stringify({
      ticker: 'BSAF2', name: 'BSA Fund II Shares', issuer_name: 'BSA Capital',
      asset_class: 'rwa', asset_subclass: 'private_credit',
    })).toString('hex').toUpperCase(),
  })
  if (!vc.ok) throw new Error(`VaultCreate ${vc.code}`)
  const vaultId = created(vc, 'Vault')?.LedgerIndex
  let snap = await vaultSnapshot(vaultId)
  log(`   VaultID    ${vaultId}`)
  log(`   ShareMPTID ${snap.shareMPTID}`)
  log(`   phase      ${snap.phase}`)

  log('\n── 4. LPs subscribe ──')
  const deposits = { alice: '50', bob: '30', carol: '20' }
  for (const [who, xrp] of Object.entries(deposits)) {
    const r = await submit(W[who], {
      TransactionType: 'VaultDeposit', Account: W[who].address,
      VaultID: vaultId, Amount: xrpl.xrpToDrops(xrp),
    })
    log(`   ${who.padEnd(6)} deposits ${xrp.padStart(3)} XRP  ${r.code}`)
  }

  log('\n── 5. Wait for the Investment phase ──')
  for (;;) {
    snap = await vaultSnapshot(vaultId)
    if (snap.phase !== 'Subscription') { log(`   phase ${snap.phase}`); break }
    log(`   Subscription, ${Math.ceil((snap.subscriptionMs - snap.nowMs) / 1000)}s to go…`)
    await wait(5000)
  }
  const wd = await submit(W.alice, {
    TransactionType: 'VaultWithdraw', Account: W.alice.address,
    VaultID: vaultId, Amount: xrpl.xrpToDrops('5'),
  })
  log(`   alice tries VaultWithdraw 5 XRP -> ${wd.code}   <- she is locked in`)

  log('\n── 6. Broker puts the capital to work ──')
  const br = await submit(master(), {
    TransactionType: 'LoanBrokerSet', Account: master().address,
    VaultID: vaultId, ManagementFeeRate: 100, DebtMaximum: xrpl.xrpToDrops('1000'),
  })
  const brokerId = created(br, 'LoanBroker')?.LedgerIndex
  log(`   LoanBrokerID ${brokerId}  ${br.code}`)

  const navBefore = (await vaultSnapshot(vaultId)).navDrops
  // Two-party LoanSet: the originator signs first, then the counterparty signs the
  // same blob with the CPT prefix. Needs xrpl.js >= 5.2.0-beta.1.
  const prepared = await c.autofill({
    TransactionType: 'LoanSet', Account: master().address, Counterparty: W.borrower.address,
    LoanBrokerID: brokerId, PrincipalRequested: xrpl.xrpToDrops('40'),
    InterestRate: 5000, PaymentInterval: 120, PaymentTotal: 3, GracePeriod: 60,
  })
  const full = xrpl.signLoanSetByCounterparty(W.borrower, master().sign(prepared).tx_blob).tx
  let loanId
  try {
    const r = await c.submitAndWait(codec.encode(full))
    log(`   LoanSet 40 XRP -> borrower   ${r.result.meta?.TransactionResult}`)
    log(`      ${EX}${r.result.hash}`)
    loanId = created({ result: r.result }, 'Loan')?.LedgerIndex
  } catch (e) {
    log(`   LoanSet failed: ${(e?.data?.error_exception ?? e.message).slice(0, 110)}`)
  }
  snap = await vaultSnapshot(vaultId)
  log(`   NAV ${navBefore} -> ${snap.navDrops} drops/share   (LoanSet adds InterestDue to AssetsTotal)`)

  log('\n── 7. Custody opts in, LPs list shares ──')
  const oi = await ensureCustodyOptedIn(snap.shareMPTID)
  log(`   custody MPTokenAuthorize ${oi.already ? '(already)' : oi.hash}`)

  const plan = [{ who: 'alice', shares: 20_000_000, discount: 0.08 },
                { who: 'bob', shares: 10_000_000, discount: 0.15 }]
  for (const { who, shares, discount } of plan) {
    const nav = (await vaultSnapshot(vaultId)).navDrops
    const askDrops = Math.floor(shares * nav * (1 - discount))
    const mv = await submit(W[who], {
      TransactionType: 'Payment', Account: W[who].address, Destination: custody().address,
      Amount: sharesAmount(snap.shareMPTID, shares),
    })
    if (!mv.ok) { log(`   ${who} transfer to custody ${mv.code}`); continue }
    const row = await createListing({ vaultId, shares, askDrops, transferHash: mv.hash })
    log(`   ${who.padEnd(6)} listed ${shares.toLocaleString()} shares  -${discount * 100}%  ask ${askDrops} drops  id ${row.id}`)
  }

  log('\n══ READY ══')
  log(`   VaultID     ${vaultId}`)
  log(`   ShareMPTID  ${snap.shareMPTID}`)
  log(`   DomainID    ${domainID}`)
  log(`   NAV         ${(await vaultSnapshot(vaultId)).navDrops} drops/share`)
  log(`   phase       ${(await vaultSnapshot(vaultId)).phase}  (Investment until ${new Date(snap.redemptionMs).toLocaleTimeString()})`)
  log(`   carol still holds unlisted shares: ${W.carol.address}`)
  log(`   uncredentialed outsider:           ${W.outsider.address}`)
  if (holder) {
    const el = await eligibility(holder, snap.shareMPTID, domainID)
    log(`\n   your wallet ${holder}`)
    log(`     credential accepted? ${el.credentialed}   opted in? ${el.optedIn}`)
  }
  log(`\n   Open the Marketplace tab and buy one. You will need a credential`)
  log(`   (Identity tab) and an MPTokenAuthorize opt-in first.`)
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(async () => (await ledger()).disconnect())
