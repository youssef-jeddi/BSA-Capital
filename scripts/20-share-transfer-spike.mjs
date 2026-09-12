#!/usr/bin/env node
/**
 * Can a locked LP sell their vault shares? — the premise of the liquidity marketplace.
 *
 * A closed-ended vault freezes its LPs during the Investment phase: no deposit, no
 * withdraw. The shares still exist and still have a computable value. This script
 * asks the ledger four questions that decide whether a secondary market is possible
 * at all, and it answers them with transaction hashes rather than by reading flags:
 *
 *   1. Is the LP genuinely locked?          VaultWithdraw during Investment
 *   2. Can the share MPT move anyway?       Payment(shares) seller -> custody
 *   3. Can an OUTSIDER receive the shares?  Payment(shares) -> uncredentialed account
 *   4. How is a third party authorised?      the share MPT has lsfMPTRequireAuth, but the
 *                                            issuer is the vault's keyless pseudo-account
 *
 * Question 4 is the one nobody could answer from the specs: with RequireAuth set, a
 * holder normally needs the ISSUER to authorise them, and a pseudo-account can never
 * sign. If domain membership substitutes for that, a marketplace works. If not, it
 * cannot be built this way.
 *
 *   node scripts/20-share-transfer-spike.mjs
 */
import * as xrpl from 'xrpl'

const WSS = 'wss://s.devnet.rippletest.net:51233/'
const EXPLORER = 'https://devnet.xrpl.org/transactions/'
const KYC_TYPE = Buffer.from('KYC_EUDI_18PLUS').toString('hex').toUpperCase()

// Closed-ended vaults need RedemptionDate - SubscriptionDate >= 180s; keep the
// Subscription window just long enough to deposit in.
const SUB_SECONDS = 35
const RED_SECONDS = SUB_SECONDS + 200

const client = new xrpl.Client(WSS)
const log = (...a) => console.log(...a)
const findings = []

/** Submit and never throw; the failure codes are the results we are here for. */
async function submit(intent, wallet, tx) {
  try {
    const prepared = await client.autofill(tx)
    const res = await client.submitAndWait(wallet.sign(prepared).tx_blob)
    const code = res.result.meta?.TransactionResult
    log(`   ${intent.padEnd(52)} ${code}`)
    if (code !== 'tesSUCCESS') log(`      ${EXPLORER}${res.result.hash}`)
    return { ok: code === 'tesSUCCESS', code, hash: res.result.hash, result: res.result }
  } catch (e) {
    const msg = e.data?.error_message ?? e.message
    const code = /\b(te[cflms][A-Z_]+)/.exec(msg)?.[1] ?? 'REJECTED'
    log(`   ${intent.padEnd(52)} ${code}  ${msg.slice(0, 60)}`)
    return { ok: false, code, msg }
  }
}

const created = (res, type) => res?.meta?.AffectedNodes
  ?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === type)

const shares = (id, value) => ({ mpt_issuance_id: id, value: String(value) })

async function phaseNow(vault) {
  const r = await client.request({ command: 'ledger', ledger_index: 'validated' })
  const nowMs = xrpl.rippleTimeToUnixTime(r.result.ledger.close_time)
  const sub = xrpl.rippleTimeToUnixTime(vault.SubscriptionDate)
  const red = xrpl.rippleTimeToUnixTime(vault.RedemptionDate)
  const phase = nowMs < sub ? 'Subscription' : nowMs < red ? 'Investment' : 'Redemption'
  return { phase, nowMs, sub, red }
}

async function main() {
  await client.connect()
  log(`Connected to Devnet, ledger ${await client.getLedgerIndex()}\n`)

  log('── 0. Cast ──')
  const names = ['broker', 'seller', 'custody', 'buyer', 'outsider']
  const W = {}
  for (const n of names) {
    const { wallet } = await client.fundWallet()
    W[n] = wallet
    log(`   ${n.padEnd(9)} ${wallet.address}`)
  }
  log('   (outsider deliberately gets NO credential)')

  log('\n── 1. Credentials + permissioned domain ──')
  for (const who of ['broker', 'seller', 'custody', 'buyer']) {
    await submit(`CredentialCreate -> ${who}`, W.broker, {
      TransactionType: 'CredentialCreate', Account: W.broker.address,
      Subject: W[who].address, CredentialType: KYC_TYPE,
    })
    await submit(`CredentialAccept by ${who}`, W[who], {
      TransactionType: 'CredentialAccept', Account: W[who].address,
      Issuer: W.broker.address, CredentialType: KYC_TYPE,
    })
  }
  const dom = await submit('PermissionedDomainSet', W.broker, {
    TransactionType: 'PermissionedDomainSet', Account: W.broker.address,
    AcceptedCredentials: [{ Credential: { Issuer: W.broker.address, CredentialType: KYC_TYPE } }],
  })
  const domainID = created(dom.result, 'PermissionedDomain')?.LedgerIndex
  log(`   DomainID   = ${domainID}`)

  log('\n── 2. Private closed-ended vault ──')
  const t0 = Date.now()
  const vc = await submit('VaultCreate (closed + private + DomainID)', W.broker, {
    TransactionType: 'VaultCreate', Account: W.broker.address,
    Asset: { currency: 'XRP' },
    VaultKind: 1,
    Flags: xrpl.VaultCreateFlags.tfVaultPrivate,
    DomainID: domainID,
    SubscriptionDate: xrpl.unixTimeToRippleTime(t0 + SUB_SECONDS * 1000),
    RedemptionDate: xrpl.unixTimeToRippleTime(t0 + RED_SECONDS * 1000),
    WithdrawalPolicy: 1,
  })
  if (!vc.ok) { log('\nVaultCreate failed — stopping.'); return }
  const vaultID = created(vc.result, 'Vault')?.LedgerIndex
  let vault = (await client.request({ command: 'ledger_entry', index: vaultID })).result.node
  const MPT = vault.ShareMPTID
  log(`   VaultID      = ${vaultID}`)
  log(`   pseudo-acct  = ${vault.Account}   <- the share ISSUER; it has no keys`)
  log(`   ShareMPTID   = ${MPT}`)

  const iss = (await client.request({ command: 'ledger_entry', mpt_issuance: MPT })).result.node
  log(`   share Flags  = ${iss.Flags}  (0x04 RequireAuth | 0x08 CanEscrow | 0x10 CanTrade | 0x20 CanTransfer)`)
  log(`   issuance DomainID = ${iss.DomainID ?? '(none)'}`)

  log('\n── 3. Seller subscribes (Subscription phase) ──')
  log(`   phase = ${(await phaseNow(vault)).phase}`)
  await submit('VaultDeposit 50 XRP by seller', W.seller, {
    TransactionType: 'VaultDeposit', Account: W.seller.address,
    VaultID: vaultID, Amount: xrpl.xrpToDrops('50'),
  })
  const pos = await client.request({
    command: 'ledger_entry', mptoken: { mpt_issuance_id: MPT, account: W.seller.address },
  }).catch(() => null)
  const held = pos?.result.node.MPTAmount
  log(`   seller holds ${held} shares`)

  log('\n── 4. Wait for the Investment phase (the lock-up) ──')
  for (;;) {
    const p = await phaseNow(vault)
    if (p.phase !== 'Subscription') { log(`   phase = ${p.phase}`); break }
    log(`   still Subscription, ${Math.ceil((p.sub - p.nowMs) / 1000)}s to go…`)
    await new Promise((r) => setTimeout(r, 5000))
  }

  log('\n── Q1. Is the LP actually locked? ──')
  const wd = await submit('VaultWithdraw 10 XRP by seller', W.seller, {
    TransactionType: 'VaultWithdraw', Account: W.seller.address,
    VaultID: vaultID, Amount: xrpl.xrpToDrops('10'),
  })
  findings.push(['Q1 VaultWithdraw during Investment', wd.code,
    wd.ok ? 'NOT locked — premise is wrong' : 'locked, as designed'])

  log('\n── Q2. Can the share MPT move anyway? ──')
  const ca = await submit('custody MPTokenAuthorize (opt in)', W.custody, {
    TransactionType: 'MPTokenAuthorize', Account: W.custody.address, MPTokenIssuanceID: MPT,
  })
  findings.push(['Q4a custody (credentialed) opt-in', ca.code, ''])
  const half = String(Math.floor(Number(held) / 2))
  const mv = await submit(`Payment ${half} shares seller -> custody`, W.seller, {
    TransactionType: 'Payment', Account: W.seller.address,
    Destination: W.custody.address, Amount: shares(MPT, half),
  })
  findings.push(['Q2 share Payment during Investment', mv.code,
    mv.ok ? 'MARKETPLACE IS POSSIBLE' : 'blocked — no marketplace this way'])
  if (mv.ok) log(`      ${EXPLORER}${mv.hash}`)

  log('\n── Q3. Can an OUTSIDER (no credential) receive shares? ──')
  const oa = await submit('outsider MPTokenAuthorize (opt in)', W.outsider, {
    TransactionType: 'MPTokenAuthorize', Account: W.outsider.address, MPTokenIssuanceID: MPT,
  })
  findings.push(['Q3a outsider opt-in to the share MPT', oa.code,
    oa.ok ? 'opt-in allowed; gate must be on payment' : 'gate is at opt-in'])
  const op = await submit('Payment shares custody -> outsider', W.custody, {
    TransactionType: 'Payment', Account: W.custody.address,
    Destination: W.outsider.address, Amount: shares(MPT, '1000'),
  })
  findings.push(['Q3b share Payment -> uncredentialed', op.code,
    op.ok ? 'NO GATE — compliance story breaks' : 'refused, as required'])

  log('\n── Q4. Does a credentialed buyer still need to opt in? ──')
  const nb = await submit('Payment shares -> buyer who has NOT opted in', W.custody, {
    TransactionType: 'Payment', Account: W.custody.address,
    Destination: W.buyer.address, Amount: shares(MPT, '1000'),
  })
  findings.push(['Q4b credentialed buyer, no opt-in', nb.code,
    nb.ok ? 'credential alone is enough' : 'opt-in also required'])
  await submit('buyer MPTokenAuthorize (opt in)', W.buyer, {
    TransactionType: 'MPTokenAuthorize', Account: W.buyer.address, MPTokenIssuanceID: MPT,
  })
  const bp = await submit('Payment shares custody -> buyer (opted in)', W.custody, {
    TransactionType: 'Payment', Account: W.custody.address,
    Destination: W.buyer.address, Amount: shares(MPT, '1000'),
  })
  findings.push(['Q4c credentialed buyer, opted in', bp.code,
    bp.ok ? 'domain membership satisfies the pseudo-account issuer' : 'still blocked'])

  log('\n── 5. Settlement leg: buyer pays the seller ──')
  vault = (await client.request({ command: 'ledger_entry', index: vaultID })).result.node
  const issNow = (await client.request({ command: 'ledger_entry', mpt_issuance: MPT })).result.node
  const nav = Number(vault.AssetsTotal) / Number(issNow.OutstandingAmount)
  log(`   AssetsTotal ${vault.AssetsTotal} / Outstanding ${issNow.OutstandingAmount} = ${nav} drops/share`)
  const ask = Math.floor(1000 * nav * 0.9)
  log(`   1000 shares at NAV = ${Math.floor(1000 * nav)} drops; asking -10% = ${ask} drops`)
  await submit(`Payment ${ask} drops buyer -> seller`, W.buyer, {
    TransactionType: 'Payment', Account: W.buyer.address,
    Destination: W.seller.address, Amount: String(ask),
  })

  log('\n══ FINDINGS ══')
  for (const [q, code, note] of findings) log(`   ${q.padEnd(40)} ${String(code).padEnd(22)} ${note}`)
  log(`\n   VaultID ${vaultID}\n   ShareMPTID ${MPT}\n   DomainID ${domainID}`)
}

main().catch((e) => console.error(e)).finally(() => client.disconnect())
