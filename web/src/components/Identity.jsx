import { useCallback, useEffect, useRef, useState } from 'react'
import { signTransaction } from '../wallet.js'
import Steps from './Steps.jsx'

/**
 * Identity tab — a testbed for the onboarding flow, deliberately standalone.
 *
 *   1. verify with an EUDI wallet (Edel-ID gateway)  → given_name, family_name, birthdate
 *   2. derive the age here; the EUDI PID has no age_over_18 flag, only the date
 *   3. the master account issues an XLS-70 credential; the user accepts it themselves
 *
 * The secrets live in the dev middleware (web/dev-api.js), never in this bundle.
 */

const API = '/dev-api'

const DEMO_CLAIMS = { given_name: 'Demo', family_name: 'User', birthdate: '1995-03-21' }

// Bound by wall clock, not iteration count: the Edel-ID provider blocks ~25 s per
// poll while the direct EUDI one answers at once, so a fixed count would mean two
// wildly different deadlines. An abandoned verification stops after five minutes
// instead of polling for as long as the tab stays open.
const DEADLINE_MS = 5 * 60 * 1000
const GAP_MS = 2000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function api(path, init) {
  const r = await fetch(`${API}${path}`, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
  return body
}

/**
 * The gateway ships the QR as a bitmap of '0'/'1' rows, so no QR library is
 * needed: one canvas pixel per module, scaled up by CSS to stay crisp.
 */
function Qr({ bitmap, px = 4 }) {
  const ref = useRef(null)
  const size = bitmap?.rows?.length ?? 0

  useEffect(() => {
    if (!size || !ref.current) return
    const c = ref.current
    c.width = size
    c.height = size
    const g = c.getContext('2d')
    g.fillStyle = '#fff'
    g.fillRect(0, 0, size, size)
    g.fillStyle = '#000'
    bitmap.rows.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) if (row[x] === '1') g.fillRect(x, y, 1, 1)
    })
  }, [bitmap, size])

  if (!size) return null
  return <canvas ref={ref} className="qr" style={{ width: size * px, height: size * px }} />
}

export default function Identity({ session, address }) {
  const [issuer, setIssuer] = useState(null)
  const [verification, setVerification] = useState(null) // { id, uri, qr }
  const [waiting, setWaiting] = useState(false)
  const [identity, setIdentity] = useState(null)          // { claims, age, over18, source }
  const [credential, setCredential] = useState(null)      // on-ledger state
  const [steps, setSteps] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // Lets an in-flight poll know it has been superseded or cancelled.
  const run = useRef(0)

  const providerLabel = issuer?.provider === 'edelid' ? 'Edel-ID gateway' : 'EUDI verifier (direct)'

  useEffect(() => { api('/issuer').then(setIssuer).catch((e) => setError(e.message)) }, [])

  const refreshCredential = useCallback(async () => {
    if (!address) return
    try {
      const { credential } = await api(`/credential?subject=${address}`)
      setCredential(credential)
    } catch (e) { setError(e.message) }
  }, [address])

  useEffect(() => { refreshCredential() }, [refreshCredential])

  function reset() {
    run.current += 1
    setVerification(null); setWaiting(false); setIdentity(null); setSteps([]); setError('')
  }

  /** Each poll waits up to ~25 s server-side, so this is a slow loop, not a spinner. */
  async function startVerification() {
    reset()
    const token = run.current
    setBusy(true)
    try {
      const v = await api('/verification', { method: 'POST' })
      setVerification(v); setWaiting(true)
      const until = Date.now() + DEADLINE_MS
      while (Date.now() < until) {
        if (run.current !== token) return
        const r = await api(`/verification/${encodeURIComponent(v.id)}`)
        if (r.state === 'SUCCESS') {
          setIdentity({ ...r, source: providerLabel }); setWaiting(false); return
        }
        if (r.state === 'FAILED') {
          setError(r.error ?? 'The wallet declined or the presentation failed.')
          setWaiting(false); return
        }
        await sleep(GAP_MS)
      }
      setError('Verification expired before the wallet answered — start again.')
      setWaiting(false)
    } catch (e) {
      if (run.current === token) { setError(e.message); setWaiting(false) }
    } finally { setBusy(false) }
  }

  /** The gateway is not always reachable; this exercises the on-chain half alone. */
  function useDemoClaims() {
    reset()
    // Same calendar arithmetic as ageFrom() in scripts/lib/edelid.mjs, which is
    // Node-side and cannot be imported here. Subtracting years alone is wrong for
    // anyone whose birthday has not yet come round this year.
    const [y, mo, d] = DEMO_CLAIMS.birthdate.split('-').map(Number)
    const now = new Date()
    const before = now.getMonth() + 1 < mo || (now.getMonth() + 1 === mo && now.getDate() < d)
    const age = now.getFullYear() - y - (before ? 1 : 0)
    setIdentity({ claims: DEMO_CLAIMS, age, over18: age >= 18, source: 'demo (not verified)' })
  }

  async function issue() {
    setBusy(true); setError(''); setSteps([{ label: 'CredentialCreate (master issues)', state: 'pending' }])
    try {
      const r = await api('/credential', {
        method: 'POST',
        body: JSON.stringify({ subject: address, verificationId: verification?.id }),
      })
      setSteps([{
        label: r.already ? 'Credential already issued to this account' : 'CredentialCreate (master issues)',
        state: r.already ? 'info' : 'ok',
        hash: r.hash,
      }])
      await refreshCredential()
    } catch (e) {
      setSteps([{ label: 'CredentialCreate (master issues)', state: 'fail', error: e.message }])
    } finally { setBusy(false) }
  }

  async function accept() {
    if (!issuer) return
    const label = 'CredentialAccept (you sign)'
    setBusy(true); setSteps((s) => [...s, { label, state: 'pending' }])
    try {
      const res = await signTransaction(session, {
        TransactionType: 'CredentialAccept',
        Account: address,
        Issuer: issuer.address,
        // Echo the hex the middleware actually used, rather than re-deriving it.
        CredentialType: issuer.credentialTypeHex,
      })
      const code = res?.tx_json?.meta?.TransactionResult
      setSteps((s) => [...s.slice(0, -1), {
        label, state: code === 'tesSUCCESS' ? 'ok' : 'fail', code, hash: res.hash,
      }])
      await refreshCredential()
    } catch (e) {
      // The wallet throws on any non-tesSUCCESS; the ledger code is in the message.
      const code = /\b(te[cflms][A-Z_]+)/.exec(e.message)?.[1]
      setSteps((s) => [...s.slice(0, -1), {
        label, state: 'fail', code,
        error: code === 'tecINSUFFICIENT_RESERVE'
          ? 'Accepting moves the 2 XRP owner reserve to your account — top it up and retry.'
          : e.message,
      }])
    } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <h2>Identity onboarding</h2>
      <p className="lede">
        Prove you are over 18 with a European Digital Identity wallet, then take an
        on-chain KYC credential from us. Sandbox flow — nothing here touches the vaults.
        {issuer && <> Verifier: <span className="mono">{providerLabel}</span>.</>}
      </p>

      {/* ── 1. verify ─────────────────────────────────────── */}
      <fieldset>
        <legend>1 · Verify identity</legend>
        {!identity ? (
          <>
            <p className="dim">
              Requests <span className="mono">given_name</span>, <span className="mono">family_name</span> and{' '}
              <span className="mono">birthdate</span> from your wallet. The EUDI PID carries no
              <span className="mono"> age_over_18</span> flag, so the age is computed from the date.
            </p>
            <div className="row">
              <button className="primary" onClick={startVerification} disabled={busy || waiting}>
                {waiting ? 'Waiting for the wallet…' : 'Start verification'}
              </button>
              <button className="ghost" onClick={useDemoClaims} disabled={busy}>Use demo claims</button>
            </div>

            {verification && (
              <div className="qrbox">
                <Qr bitmap={verification.qr} />
                <div>
                  <p>Scan with your EUDI wallet, or open the deep link on this device:</p>
                  <a className="mono brk" href={verification.uri}>{verification.uri}</a>
                  <p className="dim">Verification id <span className="mono">{verification.id}</span></p>
                  <button className="ghost sm" onClick={reset}>Cancel</button>
                </div>
              </div>
            )}
          </>
        ) : (
          <>
            <div className="stats">
              <div><span>Given name</span><b>{identity.claims.given_name ?? '—'}</b></div>
              <div><span>Family name</span><b>{identity.claims.family_name ?? '—'}</b></div>
              <div><span>Date of birth</span><b>{identity.claims.birthdate ?? '—'}</b></div>
              <div><span>Age</span><b>{identity.age ?? '—'}</b></div>
            </div>
            <p className={identity.over18 ? 'verdict ok' : 'verdict no'}>
              {identity.over18
                ? `✓ Verification OK — over 18 (${identity.age}), via ${identity.source}`
                // An unreadable date is not the same answer as "under 18", and
                // showing it as one would look like the age maths is broken.
                : identity.age === null
                  ? `⚠ Could not read the date of birth — the wallet returned `
                    + `"${identity.claims.birthdate ?? '(nothing)'}", which is not YYYY-MM-DD. `
                    + `Age not verified.`
                  : `✕ Under 18 (${identity.age}) — not eligible`}
            </p>
            <button className="ghost sm" onClick={reset}>Start over</button>
          </>
        )}
      </fieldset>

      {/* ── 2. credential ─────────────────────────────────── */}
      <fieldset disabled={!identity?.over18}>
        <legend>2 · On-chain KYC credential</legend>
        {!identity?.over18 ? (
          <p className="dim">Complete a successful 18+ verification first.</p>
        ) : (
          <>
            <p className="dim">
              We issue an XLS-70 credential of type <span className="mono">{issuer?.credentialType}</span> to{' '}
              <span className="mono">{address}</span>, and you accept it from your own wallet. Only a
              pointer to the verification goes on-ledger — never your name or birthdate.
            </p>
            {credential ? (
              <p className="verdict ok">
                ✓ Credential held{credential.accepted ? ' and accepted' : ' — not accepted yet'}
              </p>
            ) : null}
            <div className="row">
              <button className="primary" onClick={issue} disabled={busy || credential?.accepted}>
                {credential ? 'Re-check issuance' : 'Issue credential to me'}
              </button>
              <button className="ghost" onClick={accept} disabled={busy || !credential || credential.accepted}>
                Accept in my wallet
              </button>
            </div>
            <p className="dim">Issuer (master): <span className="mono">{issuer?.address ?? '…'}</span></p>
          </>
        )}
      </fieldset>

      <Steps steps={steps} />
      {error && <p className="status err">{error}</p>}
    </div>
  )
}
