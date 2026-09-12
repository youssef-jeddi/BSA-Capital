/**
 * Sign a server challenge to prove key control.
 *
 * The proof is a signed but never-submitted AccountSet carrying a one-shot nonce:
 * no fee, nothing written to the ledger. Scripts and the browser use the same
 * flow; the browser signs through the wallet with submit: false.
 */
export async function proveControl(api, wallet) {
  const res = await fetch(`${api}/api/auth/challenge`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address: wallet.address }),
  })
  const challenge = await res.json()
  if (!res.ok) throw new Error(challenge.errors?.[0] ?? 'challenge failed')
  return wallet.sign({ ...challenge.tx_json, Fee: '10', Sequence: 0 }).tx_blob
}

/** POST with a fresh proof attached. */
export async function postSigned(api, wallet, path, body = {}) {
  const proof = await proveControl(api, wallet)
  const res = await fetch(api + path, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, proof }),
  })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(json?.errors?.[0] ?? `HTTP ${res.status} ${path}`)
  return json
}
