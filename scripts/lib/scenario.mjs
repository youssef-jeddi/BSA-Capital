/**
 * Builds a complete liquidity-marketplace scenario on Devnet.
 *
 * Callable from the CLI (scripts/22-demo-scenario.mjs) or from the dev middleware so
 * the UI can stand one up on demand. `log` receives one line per step.
 *
 * The order below is forced by the ledger, not chosen: deposits only work during
 * Subscription, loans only during Investment, and share transfers only once someone
 * holds shares.
 */
import * as xrpl from 'xrpl'
import codec from 'ripple-binary-codec'
import { ledger, master, toHex, CREDENTIAL_TYPE } from './issuer.mjs'
import {
  createListing, custody, eligibility, ensureCustodyOptedIn, sharesAmount, submit, vaultSnapshot,
} from './marketplace.mjs'

const TYPE = toHex(CREDENTIAL_TYPE)
const SUB_SECONDS = 45
const RED_SECONDS = 1800

/**
 * NAV stays at 1.0 in this scenario, and that is a ledger constraint rather than a gap
 * in the setup. Measured on Devnet:
 *
 *   - `InterestRate` is capped at 100000 = 10% annual (1/10th bps); above it the ledger
 *     returns "InterestRate must be between 0 and 100000 inclusive".
 *   - `periodicRate = (rate/1e6) × PaymentInterval / 31_536_000`, so at the cap a
 *     20-minute loan on 40 XRP accrues interest that rounds to 0 drops.
 *   - Stretching `PaymentInterval` to 30 or 365 days is refused `tecNO_PERMISSION`: the
 *     loan may not outlive the vault's RedemptionDate.
 *   - `LoanOriginationFee` goes to the broker, not the vault — AssetsTotal is unchanged.
 *
 * A 1% NAV rise therefore needs roughly 91 days of loan term at the rate ceiling. The
 * mechanism is proven separately in scripts/03-loan-lifecycle.mjs, which observed
 * 1 -> 1.0000000833333333 over a 40-minute vault. None of this affects the marketplace:
 * the discount is quoted against whatever NAV the vault reports.
 */
const LOAN = {
  principalXrp: '40',
  InterestRate: 100_000,   // the ceiling: 10% annual
  PaymentInterval: 600,
  PaymentTotal: 2,
  GracePeriod: 60,
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const created = (r, t) => (r?.result ?? r)?.meta?.AffectedNodes
  ?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === t)

export async function runScenario({ log = console.log, holder = null } = {}) {
  const c = await ledger()
  log(`master  ${master().address}`)
  log(`custody ${custody().address}`)

  log('── 1. Cast ──')
  const W = {}
  for (const n of ['alice', 'bob', 'carol', 'borrower', 'outsider']) {
    const { wallet } = await c.fundWallet()
    W[n] = wallet
    log(`   ${n.padEnd(9)} ${wallet.address}`)
  }
  log('   outsider stays uncredentialed on purpose')

  log('── 2. Credentials + permissioned domain ──')
  for (const n of ['alice', 'bob', 'carol', 'borrower']) {
    await submit(master(), {
      TransactionType: 'CredentialCreate', Account: master().address,
      Subject: W[n].address, CredentialType: TYPE,
    })
    await submit(W[n], {
      TransactionType: 'CredentialAccept', Account: W[n].address,
      Issuer: master().address, CredentialType: TYPE,
    })
  }
  if (holder) {
    const r = await submit(master(), {
      TransactionType: 'CredentialCreate', Account: master().address,
      Subject: holder, CredentialType: TYPE,
    })
    log(`   credential issued to your wallet ${holder} (${r.code}) — accept it in the Identity tab`)
  }
  const dom = await submit(master(), {
    TransactionType: 'PermissionedDomainSet', Account: master().address,
    AcceptedCredentials: [{ Credential: { Issuer: master().address, CredentialType: TYPE } }],
  })
  const domainID = created(dom, 'PermissionedDomain')?.LedgerIndex
  log(`   DomainID ${domainID}`)

  log('── 3. Private closed-ended vault ──')
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
      icon: 'https://bsa.capital/icon.png',
    })).toString('hex').toUpperCase(),
  })
  if (!vc.ok) throw new Error(`VaultCreate ${vc.code}`)
  const vaultId = created(vc, 'Vault')?.LedgerIndex
  let snap = await vaultSnapshot(vaultId)
  log(`   VaultID    ${vaultId}`)
  log(`   ShareMPTID ${snap.shareMPTID}`)

  log('── 4. LPs subscribe ──')
  for (const [who, xrp] of Object.entries({ alice: '50', bob: '30', carol: '20' })) {
    const r = await submit(W[who], {
      TransactionType: 'VaultDeposit', Account: W[who].address,
      VaultID: vaultId, Amount: xrpl.xrpToDrops(xrp),
    })
    log(`   ${who.padEnd(6)} deposits ${xrp.padStart(3)} XRP  ${r.code}`)
  }

  log('── 5. Waiting for the Investment phase ──')
  for (;;) {
    snap = await vaultSnapshot(vaultId)
    if (snap.phase !== 'Subscription') break
    log(`   Subscription, ${Math.ceil((snap.subscriptionMs - snap.nowMs) / 1000)}s to go…`)
    await wait(5000)
  }
  log(`   phase ${snap.phase}`)
  const wd = await submit(W.alice, {
    TransactionType: 'VaultWithdraw', Account: W.alice.address,
    VaultID: vaultId, Amount: xrpl.xrpToDrops('5'),
  })
  log(`   alice tries VaultWithdraw 5 XRP -> ${wd.code}   <- locked in, this is the problem`)

  log('── 6. Broker puts the capital to work ──')
  const br = await submit(master(), {
    TransactionType: 'LoanBrokerSet', Account: master().address,
    VaultID: vaultId, ManagementFeeRate: 100, DebtMaximum: xrpl.xrpToDrops('1000'),
  })
  const brokerId = created(br, 'LoanBroker')?.LedgerIndex
  log(`   LoanBrokerID ${brokerId} ${br.code}`)

  const navBefore = (await vaultSnapshot(vaultId)).navDrops
  // Two-party LoanSet: originator signs first, then the counterparty signs the same
  // blob with the CPT prefix (needs xrpl.js >= 5.2.0-beta.1).
  let loanId
  try {
    const prepared = await c.autofill({
      TransactionType: 'LoanSet', Account: master().address, Counterparty: W.borrower.address,
      LoanBrokerID: brokerId, PrincipalRequested: xrpl.xrpToDrops(LOAN.principalXrp),
      InterestRate: LOAN.InterestRate, PaymentInterval: LOAN.PaymentInterval,
      PaymentTotal: LOAN.PaymentTotal, GracePeriod: LOAN.GracePeriod,
    })
    const full = xrpl.signLoanSetByCounterparty(W.borrower, master().sign(prepared).tx_blob).tx
    const r = await c.submitAndWait(codec.encode(full))
    log(`   LoanSet ${LOAN.principalXrp} XRP -> borrower  ${r.result.meta?.TransactionResult}`)
    loanId = created({ result: r.result }, 'Loan')?.LedgerIndex
  } catch (e) {
    log(`   LoanSet failed: ${(e?.data?.error_exception ?? e.message).slice(0, 110)}`)
  }
  const afterOrigination = await vaultSnapshot(vaultId)
  log(`   capital deployed: AssetsAvailable now ${afterOrigination.assetsAvailable} of ${afterOrigination.assetsTotal}`)
  log(`   NAV ${navBefore} -> ${afterOrigination.navDrops}`)

  if (loanId) {
    const loan = (await c.request({ command: 'ledger_entry', index: loanId })).result.node
    // PeriodicPayment is stored as fractional drops; an XRP Amount must be whole
    // drops, so round up rather than underpay.
    const due = String(Math.ceil(Number(loan.PeriodicPayment)))
    const r = await submit(W.borrower, {
      TransactionType: 'LoanPay', Account: W.borrower.address, LoanID: loanId, Amount: due,
    })
    log(`   LoanPay ${due} drops  ${r.code}`)
  }
  snap = await vaultSnapshot(vaultId)
  log(`   NAV now ${snap.navDrops} drops/share  (AssetsTotal ${snap.assetsTotal} / ${snap.outstanding} shares)`)
  if (snap.navDrops === 1) {
    log('   NAV is still 1.0 — at the 10% annual rate cap, minutes of loan term accrue')
    log('   sub-drop interest. See the comment in scripts/lib/scenario.mjs. The discount')
    log('   below is quoted against this NAV, so the marketplace behaves identically.')
  }

  log('── 7. Custody opts in, LPs list shares ──')
  const oi = await ensureCustodyOptedIn(snap.shareMPTID)
  log(`   custody MPTokenAuthorize ${oi.already ? '(already)' : oi.hash}`)

  const created_ = []
  for (const { who, shares, discount } of [
    { who: 'alice', shares: 20_000_000, discount: 0.08 },
    { who: 'bob', shares: 10_000_000, discount: 0.15 },
  ]) {
    const nav = (await vaultSnapshot(vaultId)).navDrops
    const askDrops = Math.floor(shares * nav * (1 - discount))
    const mv = await submit(W[who], {
      TransactionType: 'Payment', Account: W[who].address, Destination: custody().address,
      Amount: sharesAmount(snap.shareMPTID, shares),
    })
    if (!mv.ok) { log(`   ${who} -> custody FAILED ${mv.code} ${mv.error ?? ''}`); continue }
    const row = await createListing({ vaultId, shares, askDrops, transferHash: mv.hash })
    created_.push(row)
    log(`   ${who.padEnd(6)} listed ${shares.toLocaleString()} shares at -${discount * 100}% -> ask ${askDrops} drops (id ${row.id})`)
  }

  snap = await vaultSnapshot(vaultId)
  const summary = {
    vaultId, shareMPTID: snap.shareMPTID, domainID,
    navDrops: snap.navDrops, phase: snap.phase,
    listings: created_.map((l) => l.id),
    carol: W.carol.address, outsider: W.outsider.address,
    holder: holder ? await eligibility(holder, snap.shareMPTID, domainID) : null,
  }
  log('══ READY ══')
  log(`   VaultID ${vaultId}`)
  log(`   NAV     ${snap.navDrops} drops/share   phase ${snap.phase}`)
  log(`   listings ${created_.length}`)
  return summary
}
