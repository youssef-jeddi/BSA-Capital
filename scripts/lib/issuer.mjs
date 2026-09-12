/**
 * XRPL side of the identity flow: the hackathon master account issues the
 * on-chain KYC credential (XLS-70).
 *
 * MASTER_SEED is read only in Node. The browser asks this code to issue, then
 * signs CredentialAccept with the user's own wallet — the two halves are signed
 * by two different keys, which is the point.
 */
import { Client, Wallet } from 'xrpl'

export const WSS = 'wss://s.devnet.rippletest.net:51233/'
export const CREDENTIAL_TYPE = 'KYC_EUDI_18PLUS'
const LSF_ACCEPTED = 0x00010000

export const toHex = (s) => Buffer.from(s, 'utf8').toString('hex').toUpperCase()

export function master() {
  const seed = process.env.MASTER_SEED
  if (!seed) throw new Error('MASTER_SEED missing from .env — run: node scripts/10-master-account.mjs')
  return Wallet.fromSeed(seed)
}

let client
export async function ledger() {
  if (!client) client = new Client(WSS)
  if (!client.isConnected()) await client.connect()
  return client
}

/** The Credential object for (subject, master, type) if it exists, else null. */
export async function findCredential(subject, typeHex = toHex(CREDENTIAL_TYPE)) {
  const c = await ledger()
  let objects = []
  try {
    const r = await c.request({ command: 'account_objects', account: subject, type: 'credential' })
    objects = r.result.account_objects
  } catch {
    return null // account not funded yet, so it holds nothing
  }
  const found = objects.find((o) => o.Issuer === master().address && o.CredentialType === typeHex)
  return found ? { ...found, accepted: (found.Flags & LSF_ACCEPTED) !== 0 } : null
}

/**
 * CredentialCreate, signed by the master.
 *
 * `uri` must not carry personal data. It points at the off-chain Edel-ID
 * verification that justified the credential; it does not restate it. The
 * ledger is permanent and world-readable, so the name and birthdate stay off it.
 *
 * Re-issuing the same (Subject, Issuer, CredentialType) is tecDUPLICATE, so an
 * existing credential is reported rather than resubmitted — clicking twice is
 * normal and should not read as a failure.
 */
export async function issueCredential({ subject, credentialType = CREDENTIAL_TYPE, uri }) {
  const c = await ledger()
  const issuer = master()
  const typeHex = toHex(credentialType)

  const existing = await findCredential(subject, typeHex)
  if (existing) {
    return { already: true, accepted: existing.accepted, credentialType: typeHex, issuer: issuer.address }
  }

  const tx = {
    TransactionType: 'CredentialCreate',
    Account: issuer.address,
    Subject: subject,
    CredentialType: typeHex,
    ...(uri ? { URI: toHex(uri) } : {}),
  }
  const prepared = await c.autofill(tx)
  const res = await c.submitAndWait(issuer.sign(prepared).tx_blob)
  const code = res.result.meta?.TransactionResult
  if (code !== 'tesSUCCESS') throw new Error(`CredentialCreate ${code}`)

  return {
    already: false,
    accepted: false,
    credentialType: typeHex,
    issuer: issuer.address,
    hash: res.result.hash,
  }
}
