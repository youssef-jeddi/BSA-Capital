/**
 * The dedicated super-vault deployment account.
 *
 * DEVNET ONLY. Holding a seed server-side is acceptable here because it is a
 * throwaway Devnet account whose sole job is to counter-sign the curator loan
 * and hold sub-fund positions, so a demo does not require switching wallets
 * mid-flow. Never do this with a key that controls real value.
 */
import fs from 'node:fs'
import path from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as xrpl from 'xrpl'
import { ZONES, toHex } from '../lib/zones.js'
import { issueZoneCredential, publicAdmin } from './platformAdmin.js'

const here = dirname(fileURLToPath(import.meta.url))
const FILE = process.env.SUPERVAULT_ACCOUNT ?? path.join(here, '../../data/supervault-account.json')
const WSS = process.env.XRPL_WSS ?? 'wss://s.devnet.rippletest.net:51233/'

export function loadAccount() {
  if (!fs.existsSync(FILE)) return null
  try {
    const { address, seed } = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return address && seed ? { address, seed } : null
  } catch { return null }
}

/** Public view: never returns the seed. */
export function publicAccount() {
  const account = loadAccount()
  return account ? { address: account.address, configured: true } : { address: null, configured: false }
}

async function withClient(fn) {
  const client = new xrpl.Client(WSS)
  await client.connect()
  try { return await fn(client) } finally { await client.disconnect().catch(() => {}) }
}

/**
 * Submit without throwing away a transaction that already applied.
 *
 * submitAndWait can throw after the ledger accepted the transaction — a dropped
 * socket, an expired LastLedgerSequence. Assuming failure there is how value gets
 * stranded, so the hash is fixed at signing and the ledger is asked what happened.
 */
async function submitSafely(client, wallet, tx) {
  const signed = wallet.sign(await client.autofill(tx))
  try {
    const res = await client.submitAndWait(signed.tx_blob)
    return { code: res.result.meta?.TransactionResult, hash: res.result.hash, result: res.result }
  } catch (e) {
    for (let i = 0; i < 4; i += 1) {
      try {
        const r = (await client.request({ command: 'tx', transaction: signed.hash })).result
        const code = (r.meta ?? r.metaData)?.TransactionResult
        if (code) return { code, hash: signed.hash, result: r, recovered: true }
      } catch { /* not validated yet */ }
      await new Promise((res) => setTimeout(res, 2000))
    }
    const msg = e.data?.error_message ?? e.message
    return { code: /\b(te[cflms][A-Z_]+)/.exec(msg)?.[1] ?? 'REJECTED', hash: signed.hash, error: msg }
  }
}

/**
 * Add the counterparty signature to a half-signed LoanSet and submit it.
 * The SDK applies the CPT signing prefix that counterparty signatures require.
 */
export async function counterSignLoan(txJson) {
  const account = loadAccount()
  if (!account) throw new Error('No deployment account configured. Run: npm run supervault-account')

  const wallet = xrpl.Wallet.fromSeed(account.seed)
  if (txJson.Counterparty !== wallet.address) {
    throw new Error(`This loan names ${txJson.Counterparty} as counterparty, not the deployment account ${wallet.address}.`)
  }

  const signed = xrpl.signLoanSetByCounterparty(wallet, txJson)
  return withClient(async (client) => {
    const res = await client.submitAndWait(signed.tx_blob)
    const loan = res.result.meta?.AffectedNodes
      ?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === 'Loan')
    return {
      result_code: res.result.meta?.TransactionResult,
      hash: res.result.hash,
      loan_id: loan?.LedgerIndex ?? null,
    }
  })
}

/** Deposit into a sub-vault as the deployment account. */
/**
 * Hold an accepted credential for every zone.
 *
 * A domain's AcceptedCredentials are OR, not AND, so one account credentialed
 * for all three zones can deposit into any sub-fund whatever its gating. Without
 * this the deployment account cannot fund a gated sub-fund at all: VaultDeposit
 * returns tecNO_AUTH, which broke initial allocation as well as reallocation.
 * Mirrors what setupCustody already does for the custody account. Idempotent.
 */
export async function ensureZoneCredentials() {
  const account = loadAccount()
  if (!account) throw new Error('No deployment account configured. Run: npm run supervault-account')
  const admin = publicAdmin()
  if (!admin.configured) throw new Error('Platform account missing. Run: npm run setup-zones')
  const wallet = xrpl.Wallet.fromSeed(account.seed)

  return withClient(async (client) => {
    const held = await client.request({
      command: 'account_objects', account: wallet.address, type: 'credential',
    }).then((r) => r.result.account_objects ?? []).catch(() => [])

    const zones = []
    for (const zone of ZONES) {
      const type = toHex(zone.credentialType)
      const existing = held.find((o) => o.Issuer === admin.address && o.CredentialType === type)
      // lsfAccepted = 0x00010000: issued but not yet accepted is not enough.
      if (existing && (existing.Flags & 0x00010000)) { zones.push({ zone: zone.code, already: true }); continue }

      if (!existing) {
        const issued = await issueZoneCredential(wallet.address, zone.code)
        if (issued.result_code !== 'tesSUCCESS' && issued.result_code !== 'tecDUPLICATE') {
          throw new Error(`issue ${zone.code}: ${issued.result_code}`)
        }
      }
      const accept = await submitSafely(client, wallet, {
        TransactionType: 'CredentialAccept', Account: wallet.address,
        Issuer: admin.address, CredentialType: type,
      })
      if (accept.code !== 'tesSUCCESS') throw new Error(`accept ${zone.code}: ${accept.code}`)
      zones.push({ zone: zone.code, already: false })
    }
    return { address: wallet.address, zones }
  })
}

export async function depositToVault(vaultId, amountDrops) {
  const account = loadAccount()
  if (!account) throw new Error('No deployment account configured. Run: npm run supervault-account')
  const wallet = xrpl.Wallet.fromSeed(account.seed)

  return withClient(async (client) => {
    const out = await submitSafely(client, wallet, {
      TransactionType: 'VaultDeposit', Account: wallet.address,
      VaultID: vaultId, Amount: String(amountDrops),
    })
    return { result_code: out.code, hash: out.hash, recovered: out.recovered }
  })
}

/** Repay part or all of the curator loan, as the deployment account. */
export async function repayLoan(loanId, amountDrops) {
  const account = loadAccount()
  if (!account) throw new Error('No deployment account configured. Run: npm run supervault-account')
  const wallet = xrpl.Wallet.fromSeed(account.seed)

  return withClient(async (client) => {
    const out = await submitSafely(client, wallet, {
      TransactionType: 'LoanPay', Account: wallet.address,
      LoanID: loanId, Amount: String(amountDrops),
    })
    return { result_code: out.code, hash: out.hash, recovered: out.recovered }
  })
}

/** Redeem the deployment account's shares in one sub-fund back to assets. */
export async function withdrawFromVault(vaultId, shares) {
  const account = loadAccount()
  if (!account) throw new Error('No deployment account configured. Run: npm run supervault-account')
  const wallet = xrpl.Wallet.fromSeed(account.seed)

  return withClient(async (client) => {
    const vault = (await client.request({ command: 'ledger_entry', index: vaultId })).result.node
    const held = shares ?? (await client.request({
      command: 'ledger_entry',
      mptoken: { mpt_issuance_id: vault.ShareMPTID, account: wallet.address },
    })).result.node.MPTAmount

    const out = await submitSafely(client, wallet, {
      TransactionType: 'VaultWithdraw', Account: wallet.address, VaultID: vaultId,
      Amount: { mpt_issuance_id: vault.ShareMPTID, value: String(held) },
    })
    return { result_code: out.code, hash: out.hash, shares: String(held), recovered: out.recovered }
  })
}

/** What the deployment account currently owes and holds. */
export async function unwindState(loanId, subVaultIds) {
  const account = loadAccount()
  if (!account) return { configured: false }
  const wallet = xrpl.Wallet.fromSeed(account.seed)

  return withClient(async (client) => {
    let loan = null
    if (loanId) {
      try {
        const node = (await client.request({ command: 'ledger_entry', index: loanId })).result.node
        // A fully repaid loan is NOT deleted: the entry survives with every
        // balance field absent and only a stale PeriodicPayment left. Measured
        // on Devnet, LoanPay 9F832C36…, so presence alone means nothing.
        loan = node.TotalValueOutstanding == null ? null : {
          outstanding: node.TotalValueOutstanding,
          principal: node.PrincipalOutstanding,
          periodic: node.PeriodicPayment,
          remaining: node.PaymentRemaining,
          next_due: node.NextPaymentDueDate,
        }
      } catch { /* repaid and deleted */ }
    }

    const positions = []
    for (const id of subVaultIds ?? []) {
      try {
        const vault = (await client.request({ command: 'ledger_entry', index: id })).result.node
        const held = await client.request({
          command: 'ledger_entry',
          mptoken: { mpt_issuance_id: vault.ShareMPTID, account: wallet.address },
        }).then((r) => r.result.node.MPTAmount).catch(() => '0')
        positions.push({ vault_id: id, shares: String(held) })
      } catch { positions.push({ vault_id: id, shares: '0' }) }
    }

    return {
      configured: true,
      address: wallet.address,
      balance: await client.getXrpBalance(wallet.address),
      loan,
      positions,
    }
  })
}
