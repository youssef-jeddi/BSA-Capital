/**
 * Dev-only API for the Identity tab.
 *
 * It holds the two things the browser must never see — the Edel-ID organisation
 * CLIENT_SECRET and the master account seed — and exposes only what is public:
 * the URI to scan, the verified claims, and the issuance result. This mirrors
 * the role device-service plays in EdelCheck production.
 *
 * `apply: 'serve'` keeps it out of any build. It is not a production backend.
 */
import fs from 'node:fs'
import path from 'node:path'
import { ageFrom, flattenClaims } from '../scripts/lib/claims.mjs'
import * as eudi from '../scripts/lib/eudi.mjs'
import * as edelid from '../scripts/lib/edelid.mjs'
import { CREDENTIAL_TYPE, findCredential, issueCredential, master, toHex } from '../scripts/lib/issuer.mjs'
import {
  cancelListing, createListing, custody, eligibility, ensureCustodyOptedIn,
  listing, listings, settleListing, strandedShares, vaultSnapshot,
} from '../scripts/lib/marketplace.mjs'
import { runScenario } from '../scripts/lib/scenario.mjs'

/**
 * The scenario takes a couple of minutes — it funds five accounts and waits out a
 * real Subscription window — so it runs detached and the browser polls this log.
 */
const job = { running: false, log: [], summary: null, error: null, startedAt: null }

/**
 * Two ways to reach the same wallet. `eudi` talks to the EU reference verifier
 * directly — no auth, nothing to provision — and is the default. `edelid` goes
 * through the Edel-ID gateway, which adds the Swiss flow and an org API key.
 * Switch with VERIFY_PROVIDER=edelid in .env.
 */
const provider = () => (process.env.VERIFY_PROVIDER === 'edelid' ? edelid : eudi)
const providerName = () => (process.env.VERIFY_PROVIDER === 'edelid' ? 'edelid' : 'eudi')

/** The root .env holds the secrets; only Node ever reads it. */
function loadRootEnv(root) {
  const file = path.resolve(root, '../.env')
  if (!fs.existsSync(file)) return console.warn('[dev-api] no root .env — run: node scripts/10-master-account.mjs')
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
  }
}

const send = (res, code, body) => {
  res.statusCode = code
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')) } catch { resolve({}) } })
  })

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const seg = url.pathname.split('/').filter(Boolean)

  // GET /issuer — who signs, and the exact CredentialType hex the browser must
  // echo back in CredentialAccept. Hexing it in two places invites them to drift.
  if (req.method === 'GET' && seg[0] === 'issuer') {
    return send(res, 200, {
      address: master().address,
      credentialType: CREDENTIAL_TYPE,
      credentialTypeHex: toHex(CREDENTIAL_TYPE),
      claims: provider().KYC_CLAIMS,
      provider: providerName(),
    })
  }

  // POST /verification — start an EUDI presentation request.
  if (req.method === 'POST' && seg[0] === 'verification' && !seg[1]) {
    return send(res, 200, await provider().startVerification())
  }

  // GET /verification/:id — long-poll. PENDING means "keep asking", not "failed".
  if (req.method === 'GET' && seg[0] === 'verification' && seg[1]) {
    const result = await provider().pollResult(seg[1])
    const claims = flattenClaims(result.verifiedClaims)
    // The SD-JWT PID spells it `birthdate`; the mdoc PID spells it `birth_date`.
    const age = ageFrom(claims.birthdate ?? claims.birth_date)
    return send(res, 200, { state: result.state ?? 'PENDING', claims, age, over18: age !== null && age >= 18 })
  }

  // GET /credential?subject=r... — does this account already hold ours?
  if (req.method === 'GET' && seg[0] === 'credential') {
    const subject = url.searchParams.get('subject')
    if (!subject) return send(res, 400, { error: 'subject required' })
    const found = await findCredential(subject)
    return send(res, 200, { credential: found && { accepted: found.accepted, type: found.CredentialType } })
  }

  // POST /credential — the master issues; the subject accepts from their own wallet.
  if (req.method === 'POST' && seg[0] === 'credential') {
    const { subject, verificationId } = await readBody(req)
    if (!subject) return send(res, 400, { error: 'subject required' })
    // A pointer to the off-chain verification, never the claims themselves —
    // the ledger is permanent and public.
    const uri = verificationId ? `edel-id:eu:${verificationId}` : undefined
    return send(res, 200, await issueCredential({ subject, uri }))
  }

  // ── marketplace ────────────────────────────────────────

  // POST /market/scenario — start one; GET — follow it.
  if (req.method === 'POST' && seg[0] === 'market' && seg[1] === 'scenario') {
    if (job.running) return send(res, 409, { error: 'a scenario is already running' })
    const { holder } = await readBody(req)
    Object.assign(job, { running: true, log: [], summary: null, error: null, startedAt: Date.now() })
    runScenario({ holder: holder ?? null, log: (line) => { job.log.push(String(line)); console.log('[scenario]', line) } })
      .then((summary) => { job.summary = summary })
      .catch((e) => { job.error = e.message; job.log.push(`FAILED: ${e.message}`) })
      .finally(() => { job.running = false })
    return send(res, 200, { started: true })
  }
  if (req.method === 'GET' && seg[0] === 'market' && seg[1] === 'scenario') {
    return send(res, 200, { ...job, elapsedMs: job.startedAt ? Date.now() - job.startedAt : 0 })
  }

  // GET /market/stranded?vault= — shares custody holds with no open listing, the
  // residue of a transfer that landed while its listing was never recorded.
  if (req.method === 'GET' && seg[0] === 'market' && seg[1] === 'stranded') {
    const vaultId = url.searchParams.get('vault')
    if (!vaultId) return send(res, 400, { error: 'vault required' })
    const snap = await vaultSnapshot(vaultId)
    return send(res, 200, await strandedShares(snap.shareMPTID))
  }

  // GET /market — listings enriched with live NAV, so the discount is current
  // rather than whatever it was when the seller listed.
  if (req.method === 'GET' && seg[0] === 'market' && !seg[1]) {
    const rows = listings()
    const navs = new Map()
    for (const r of rows) {
      if (navs.has(r.vaultId)) continue
      try { navs.set(r.vaultId, await vaultSnapshot(r.vaultId)) } catch { navs.set(r.vaultId, null) }
    }
    return send(res, 200, {
      custody: custody().address,
      listings: rows.map((r) => {
        const snap = navs.get(r.vaultId)
        const navNow = snap?.navDrops ?? null
        const value = navNow === null ? null : Number(r.shares) * navNow
        return {
          ...r,
          navNow,
          valueAtNav: value,
          discountPct: value ? (1 - Number(r.askDrops) / value) * 100 : null,
          phase: snap?.phase ?? null,
        }
      }),
    })
  }

  // GET /market/vault/:id — NAV, phase and the share id, for pricing a new listing.
  if (req.method === 'GET' && seg[0] === 'market' && seg[1] === 'vault' && seg[2]) {
    return send(res, 200, await vaultSnapshot(seg[2]))
  }

  // GET /market/eligibility?vault=&account= — the two gates, checked separately.
  // An MPToken object proves nothing on its own: opt-in is permissionless.
  if (req.method === 'GET' && seg[0] === 'market' && seg[1] === 'eligibility') {
    const vaultId = url.searchParams.get('vault')
    const account = url.searchParams.get('account')
    if (!vaultId || !account) return send(res, 400, { error: 'vault and account required' })
    const snap = await vaultSnapshot(vaultId)
    const el = await eligibility(account, snap.shareMPTID, snap.domainID)
    return send(res, 200, { ...el, shareMPTID: snap.shareMPTID, domainID: snap.domainID })
  }

  // POST /market/prepare {vaultId} — custody opts in so a seller can pay it shares.
  if (req.method === 'POST' && seg[0] === 'market' && seg[1] === 'prepare') {
    const { vaultId } = await readBody(req)
    if (!vaultId) return send(res, 400, { error: 'vaultId required' })
    const snap = await vaultSnapshot(vaultId)
    const optIn = await ensureCustodyOptedIn(snap.shareMPTID)
    return send(res, 200, { custody: custody().address, ...snap, custodyOptIn: optIn })
  }

  // POST /market/listings {vaultId, shares, askDrops, transferHash}
  if (req.method === 'POST' && seg[0] === 'market' && seg[1] === 'listings') {
    const b = await readBody(req)
    for (const k of ['vaultId', 'shares', 'askDrops', 'transferHash'])
      if (!b[k]) return send(res, 400, { error: `${k} required` })
    return send(res, 200, await createListing(b))
  }

  // POST /market/listings/:id/settle {paymentHash} — custody releases the shares
  // only after the seller's payment is confirmed on-ledger.
  if (req.method === 'POST' && seg[0] === 'market' && seg[1] === 'listings' && seg[2] && seg[3] === 'settle') {
    const { paymentHash } = await readBody(req)
    if (!paymentHash) return send(res, 400, { error: 'paymentHash required' })
    return send(res, 200, await settleListing(seg[2], { paymentHash }))
  }

  // POST /market/listings/:id/cancel — custody returns the shares to the seller.
  if (req.method === 'POST' && seg[0] === 'market' && seg[1] === 'listings' && seg[2] && seg[3] === 'cancel') {
    return send(res, 200, await cancelListing(seg[2]))
  }

  if (req.method === 'GET' && seg[0] === 'market' && seg[1] === 'listings' && seg[2]) {
    const row = listing(seg[2])
    return row ? send(res, 200, row) : send(res, 404, { error: 'no such listing' })
  }

  send(res, 404, { error: `no route for ${req.method} ${url.pathname}` })
}

export default function devApi() {
  return {
    name: 'bsa-dev-api',
    apply: 'serve',
    configureServer(server) {
      loadRootEnv(server.config.root)
      server.middlewares.use('/dev-api', (req, res) => {
        route(req, res).catch((e) => {
          // Name the real cause; a bare 500 would read as our bug.
          console.error('[dev-api]', e.message)
          send(res, 502, { error: e.message })
        })
      })
    },
  }
}
