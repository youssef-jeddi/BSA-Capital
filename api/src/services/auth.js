/**
 * Proof of key control, without a login.
 *
 * The API signs transactions with real keys and moves other people's shares, so
 * "who is calling" cannot be a field in the request body. The wallet only exposes
 * xrpl_signTransaction, so the proof is a signed but NEVER SUBMITTED AccountSet
 * carrying a server-issued nonce in a memo: it costs no fee, writes nothing to the
 * ledger, and is cryptographically bound to the account.
 */
import { randomBytes } from 'node:crypto'
import { decode, verifySignature } from 'xrpl'

const TTL_MS = 5 * 60_000
const SESSION_MS = 30 * 60_000

/**
 * Off by default.
 *
 * This API signs with real keys, so in production the caller must prove who they
 * are. On a Devnet demo bound to localhost the only reachable attacker is the
 * person running it, and a wallet approval before every write costs far more than
 * it protects. The implementation stays, one env var turns it on:
 *
 *   REQUIRE_AUTH=1 npm run api
 *
 * With it off, the acting address is taken from the request — which is exactly
 * why it must be on anywhere the API is reachable by someone else.
 */
export const AUTH_REQUIRED = process.env.REQUIRE_AUTH === '1' || process.env.REQUIRE_AUTH === 'true'
const MEMO_TYPE = Buffer.from('bsa-auth', 'utf8').toString('hex').toUpperCase()

/** Nonces live in memory: they are single-use and short-lived by design. */
const nonces = new Map()

const sweep = () => {
  const now = Date.now()
  for (const [nonce, issued] of nonces) if (now - issued.at > TTL_MS) nonces.delete(nonce)
}

export function issueChallenge(address) {
  sweep()
  const nonce = randomBytes(24).toString('hex')
  nonces.set(nonce, { address, at: Date.now() })

  // The wallet renders the memo, and a bare nonce reads like a mystery
  // transaction. Say what it is, so the approval dialog explains itself.
  const label = `BSA Capital sign-in - proves you control this account - NOT submitted - ${nonce}`

  return {
    nonce,
    memo_type: MEMO_TYPE,
    expires_in_seconds: TTL_MS / 1000,
    // What the client signs, with submit: false. Nothing reaches the ledger.
    tx_json: {
      TransactionType: 'AccountSet',
      Account: address,
      Memos: [{ Memo: { MemoType: MEMO_TYPE, MemoData: Buffer.from(label, 'utf8').toString('hex').toUpperCase() } }],
    },
  }
}

const memoNonce = (tx) => {
  const memo = (tx.Memos ?? []).map((m) => m.Memo).find((m) => m?.MemoType === MEMO_TYPE)
  if (!memo?.MemoData) return null
  try {
    const text = Buffer.from(memo.MemoData, 'hex').toString('utf8')
    return text.split(' ').pop()   // the nonce is the last token of the label
  } catch { return null }
}

/**
 * Returns the proven address, or throws. The nonce is consumed on success so a
 * captured proof cannot be replayed.
 */
export function verifyProof(proof) {
  if (!proof) throw new Error('This action needs a signed proof of account control.')

  const tx = typeof proof === 'string' ? decode(proof) : proof
  const blob = typeof proof === 'string' ? proof : null

  if (!verifySignature(blob ?? tx)) throw new Error('Signature does not verify.')

  const nonce = memoNonce(tx)
  if (!nonce) throw new Error('Proof carries no challenge nonce.')

  const issued = nonces.get(nonce)
  if (!issued) throw new Error('Challenge is unknown or has already been used. Request a new one.')
  if (Date.now() - issued.at > TTL_MS) { nonces.delete(nonce); throw new Error('Challenge has expired.') }
  if (issued.address !== tx.Account) throw new Error('Proof was signed by a different account.')

  nonces.delete(nonce)
  return tx.Account
}

/* ── sessions ──────────────────────────────────────────────
 * One signature buys thirty minutes.
 *
 * Signing per request meant a wallet approval for every write, which is both
 * exhausting and desensitising: a user clicking through a stream of dialogs stops
 * reading them. A proof is exchanged once for a bearer token held in memory.
 */
const sessions = new Map()

export function openSession(proof) {
  const address = verifyProof(proof)
  const token = randomBytes(32).toString('hex')
  sessions.set(token, { address, at: Date.now() })
  return { token, address, expires_in_seconds: SESSION_MS / 1000 }
}

function addressForToken(token) {
  const found = sessions.get(token)
  if (!found) return null
  if (Date.now() - found.at > SESSION_MS) { sessions.delete(token); return null }
  return found.address
}

const bearer = (req) => {
  const header = req.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7) : null
}

/**
 * Fastify preHandler. `owner` extracts the address the request claims to act as;
 * the proof must match it. Without `owner` it only proves control of some account,
 * which it then puts on the request for the handler to use.
 */
export const requireProof = (owner) => async (req, reply) => {
  if (!AUTH_REQUIRED) {
    // Trust the request. Fine on a local Devnet demo, unsafe anywhere else.
    req.provedAddress = (owner ? await owner(req) : null) ?? req.body?.address ?? null
    return
  }
  try {
    // A session token where there is one, a raw proof otherwise: scripts and the
    // first call of a browser session use the proof directly.
    const token = bearer(req)
    const proved = token ? addressForToken(token) : verifyProof(req.body?.proof ?? req.headers['x-bsa-proof'])
    if (!proved) throw new Error('Your session has expired. Sign in again.')
    req.provedAddress = proved
    if (owner) {
      const expected = await owner(req)
      if (expected && expected !== proved) {
        return reply.code(403).send({ errors: [`This action belongs to ${expected}, not ${proved}.`] })
      }
    }
  } catch (e) {
    return reply.code(401).send({ errors: [e.message] })
  }
}
