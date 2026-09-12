/**
 * Edel-ID Verifier API client — EUDI (European Digital Identity) flow.
 *
 * The organisation CLIENT_SECRET must never reach a browser, so everything here
 * runs in Node: the dev-only middleware (web/dev-api.js) exposes just the scan
 * URI and the verified claims. Same split as PDG/edelcheck/scripts/test-eudi.py.
 *
 * Contract: PDG/api-gateway_poc/HOWTO.md + API-INTERNALS.md.
 */

// Read lazily: .env is loaded after this module is imported (ESM hoisting).
const authUrl = () => process.env.EDEL_AUTH_URL || 'https://auth.edel-id.app'
const apiUrl = () => process.env.EDEL_API_URL || 'https://api.edel-id.app'

// The EUDI PID carries `birthdate`, not an age_over_18 boolean — the CH/SWIYU
// flow is the one with a ready-made flag. So we ask for the date and derive the
// age ourselves. Names here are plain, not JSONPath: `$.given_name` on the EU
// endpoint gets a 400 with no useful explanation.
export const KYC_CLAIMS = ['given_name', 'family_name', 'birthdate']

/** `fetch failed` names neither the host nor the reason; both matter here. */
async function call(url, init, what) {
  try {
    return await fetch(url, init)
  } catch (e) {
    if (isTimeout(e)) throw e
    const cause = e.cause?.code ?? e.cause?.message ?? e.message
    throw new Error(`cannot reach ${new URL(url).origin} for ${what} (${cause}) — is the Edel-ID gateway up?`)
  }
}

/** Budget expiry is expected and means PENDING; anything else is a real fault. */
const isTimeout = (e) => e?.name === 'TimeoutError' || e?.name === 'AbortError'

let cached = { token: null, expires: 0 }

export async function token() {
  if (cached.token && Date.now() < cached.expires) return cached.token

  const id = process.env.EDEL_CLIENT_ID
  const secret = process.env.EDEL_CLIENT_SECRET
  if (!id || !secret) throw new Error('EDEL_CLIENT_ID / EDEL_CLIENT_SECRET missing from .env')

  const r = await call(`${authUrl()}/oauth/v2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials&scope=openid',
    signal: AbortSignal.timeout(15000),
  }, 'a token')
  if (!r.ok) throw new Error(`token ${r.status}: ${(await r.text()).slice(0, 200)}`)

  const body = await r.json()
  // Lives 12 h in practice; keep it rather than minting one per click.
  cached = { token: body.access_token, expires: Date.now() + (body.expires_in ?? 300) * 1000 - 60_000 }
  return cached.token
}

/** POST /api/verification/eu → { id, uri, url, qr }. `uri` is what gets scanned. */
export async function startVerification(claims = KYC_CLAIMS) {
  const r = await call(`${apiUrl()}/api/verification/eu`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ verificationClaims: claims }),
    signal: AbortSignal.timeout(30000),
  }, 'a new verification')
  if (!r.ok) throw new Error(`verification ${r.status}: ${(await r.text()).slice(0, 300)}`)

  const b = await r.json()
  return { id: b.id ?? b.transactionId, uri: b.verificationUri, url: b.verificationUrl, qr: b.qrCodeBitMap }
}

/**
 * Reads the gateway's SSE stream for at most `budgetMs`. The contract emits a
 * single `verification-complete` event then closes; if the user has not scanned
 * within the budget we return PENDING so the caller can ask again and keep the
 * UI honest about still waiting.
 */
export async function pollResult(id, budgetMs = 25000) {
  let r
  try {
    r = await call(`${apiUrl()}/api/verification/eu/${encodeURIComponent(id)}/stream`, {
      headers: { Authorization: `Bearer ${await token()}`, Accept: 'text/event-stream' },
      signal: AbortSignal.timeout(budgetMs),
    }, 'the result stream')
  } catch (e) {
    if (isTimeout(e)) return { state: 'PENDING' } // budget spent before the wallet answered
    throw e
  }
  if (!r.ok) throw new Error(`stream ${r.status}: ${(await r.text()).slice(0, 200)}`)

  const reader = r.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let data = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop()
      for (const raw of lines) {
        const line = raw.replace(/\r$/, '')
        if (line.startsWith('data:')) data += line.slice(5).trim()
        // A blank line terminates the event.
        else if (line === '' && data) {
          reader.cancel().catch(() => {})
          return JSON.parse(data)
        }
      }
    }
  } catch (e) {
    if (!isTimeout(e)) throw e
    /* budget spent mid-stream — fall through to whatever we accumulated */
  }
  // The budget can expire mid-event, leaving `data` as partial JSON. Treat that
  // as PENDING: the next poll opens a fresh stream and reads the whole thing.
  try {
    return data ? JSON.parse(data) : { state: 'PENDING' }
  } catch {
    return { state: 'PENDING' }
  }
}
