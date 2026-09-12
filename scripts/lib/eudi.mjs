/**
 * EUDI verifier, called directly — no Edel-ID gateway, no OAuth, no API key.
 *
 * `verifier-backend.eudiw.dev` is the EU reference verifier that Edel-ID itself
 * wraps, so this is the same wallet interaction one layer lower. What the gateway
 * used to do for us and we now do here: build the DCQL query, assemble the deep
 * link, render the QR, and decode the SD-JWT disclosures.
 *
 * Contract verified live on 2026-09-12:
 *   POST /ui/presentations        → { transaction_id, client_id, request_uri, request_uri_method }
 *   GET  /ui/presentations/{id}   → 400 (empty) until the wallet answers, then the VP token
 */
import QRCode from 'qrcode'

const base = () => process.env.EUDI_VERIFIER_URL || 'https://verifier-backend.eudiw.dev'

// The PID exposes `birthdate`, not an age_over_18 flag, so the age is derived.
export const KYC_CLAIMS = ['given_name', 'family_name', 'birthdate']

const PID_VCT = 'urn:eudi:pid:1'

// The verifier requires a relying-party registration certificate; referencing one
// of its published intended uses satisfies that. Without it: MissingRegistrationCertificate.
const INTENDED_USE = () => process.env.EUDI_INTENDED_USE_ID || 'TEST-01'

/**
 * How the wallet returns the presentation.
 *
 * The verifier defaults to `direct_post.jwt`, which obliges the wallet to encrypt
 * its response (JARM, ECDH-ES + A128/256GCM) to the key in `client_metadata`. A
 * wallet that cannot do that gets as far as building the presentation and then
 * fails POSTing it — the verifier answers 400 and the wallet reports only
 * "sharing failed" (Procivis: BR_0395). Plain `direct_post` sends a form POST
 * over TLS instead and is far more interoperable, so it is our default.
 *
 * Set EUDI_RESPONSE_MODE=direct_post.jwt to get end-to-end encrypted responses
 * back, once the wallet in play is known to support them.
 */
const RESPONSE_MODE = () => process.env.EUDI_RESPONSE_MODE || 'direct_post'

/**
 * Deep-link scheme. The EUDI reference wallet registers four —  `openid4vp`,
 * `eudi-openid4vp`, `mdoc-openid4vp`, `haip-vp` — and other wallets register
 * their own, so it is worth being able to vary this without a code change.
 */
const SCHEME = () => process.env.EUDI_SCHEME || 'openid4vp'

// Claims the SD-JWT carries as plumbing rather than identity.
const JWT_METADATA = new Set(['_sd', '_sd_alg', 'iss', 'iat', 'exp', 'nbf', 'vct', 'cnf', 'sub', 'status'])

/**
 * A QR bitmap in the shape the Edel-ID gateway used to return, so the browser
 * renders it the same way regardless of which provider produced it.
 */
async function qrBitmap(text, quietZone = 4) {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const n = modules.size
  const size = n + quietZone * 2
  const rows = []
  for (let y = 0; y < size; y++) {
    let row = ''
    for (let x = 0; x < size; x++) {
      const inside = y >= quietZone && y < quietZone + n && x >= quietZone && x < quietZone + n
      row += inside && modules.data[(y - quietZone) * n + (x - quietZone)] ? '1' : '0'
    }
    rows.push(row)
  }
  return { size, quietZone, errorCorrection: 'M', rows }
}

/** POST /ui/presentations → { id, uri, url, qr }. `uri` is the deep link to scan. */
export async function startVerification(claims = KYC_CLAIMS) {
  const body = {
    dcql_query: {
      credentials: [{
        id: crypto.randomUUID(),
        format: 'dc+sd-jwt',
        meta: { vct_values: [PID_VCT] },
        // "place_of_birth.locality" → ["place_of_birth","locality"] (DCQL paths).
        claims: claims.map((name) => ({ path: name.split('.') })),
      }],
    },
    nonce: crypto.randomUUID(),
    request_uri_method: 'get',
    profile: 'openid4vp',
    response_mode: RESPONSE_MODE(),
    // Documented field name; `authorization_request_uri` (what the Edel-ID
    // gateway sent) is not read by the current verifier.
    authorization_request_scheme: SCHEME(),
    intended_use_id: INTENDED_USE(),
  }

  let r
  try {
    r = await fetch(`${base()}/ui/presentations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    })
  } catch (e) {
    throw new Error(`cannot reach ${base()} (${e.cause?.code ?? e.message})`)
  }
  if (!r.ok) throw new Error(`presentations ${r.status}: ${(await r.text()).slice(0, 300)}`)

  const b = await r.json()
  // The verifier returns the pieces; the deep link is ours to assemble.
  const uri = `${SCHEME()}://?client_id=${encodeURIComponent(b.client_id)}`
    + `&request_uri=${encodeURIComponent(b.request_uri)}`
    + `&request_uri_method=${b.request_uri_method}`

  return { id: b.transaction_id, uri, url: b.request_uri, qr: await qrBitmap(uri) }
}

const fromB64Url = (s) => Buffer.from(s, 'base64url').toString('utf8')

/**
 * Pull the disclosed claims out of an SD-JWT presentation.
 *
 * Wire format is `<jwt>~<disclosure>~…~[key-binding jwt]`, where each disclosure
 * is base64url of `[salt, name, value]`. Array-element disclosures are `[salt,
 * value]` — length 2, no name — so they are skipped rather than mis-keyed.
 */
export function decodeSdJwt(sdJwt) {
  const [jwt, ...rest] = sdJwt.split('~')
  const out = {}

  // Claims the issuer chose not to make selectively disclosable sit in the payload.
  try {
    const payload = JSON.parse(fromB64Url(jwt.split('.')[1]))
    for (const [k, v] of Object.entries(payload)) if (!JWT_METADATA.has(k)) out[k] = v
  } catch { /* not a readable JWT; disclosures may still be */ }

  for (const d of rest) {
    if (!d) continue
    try {
      const parts = JSON.parse(fromB64Url(d))
      if (Array.isArray(parts) && parts.length >= 3) out[parts[1]] = parts[2]
    } catch { /* the key-binding JWT is not a disclosure — ignore it */ }
  }
  return out
}

/** The first SD-JWT in a vp_token, whatever key the verifier filed it under. */
function findSdJwt(vpToken) {
  for (const value of Object.values(vpToken ?? {})) {
    for (const entry of [].concat(value)) {
      if (typeof entry === 'string' && entry.includes('~')) return entry
    }
  }
  return null
}

/**
 * GET /ui/presentations/{id}. The verifier answers 400 with an empty body until
 * the wallet has responded — that is its "not ready" signal, not an error, so it
 * maps to PENDING. Polled by the caller; there is no stream on this endpoint.
 */
export async function pollResult(id, budgetMs = 8000) {
  let r
  try {
    r = await fetch(`${base()}/ui/presentations/${encodeURIComponent(id)}`, {
      signal: AbortSignal.timeout(budgetMs),
    })
  } catch (e) {
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return { state: 'PENDING' }
    throw new Error(`cannot reach ${base()} (${e.cause?.code ?? e.message})`)
  }

  if (r.status === 400) return { state: 'PENDING' }
  if (!r.ok) throw new Error(`presentation ${r.status}: ${(await r.text()).slice(0, 200)}`)

  const body = await r.json()
  const sdJwt = findSdJwt(body.vp_token)
  if (!sdJwt) {
    // Answered, but not as an SD-JWT — an mdoc/CBOR presentation needs the
    // verifier's own decoder, which we deliberately do not request.
    return { state: 'FAILED', error: 'no SD-JWT in vp_token' }
  }
  return { state: 'SUCCESS', verifiedClaims: decodeSdJwt(sdJwt) }
}
