/**
 * WalletConnect v2 client for the XRPL Dev Wallet extension.
 *
 * The extension exposes no injected provider — pairing happens by the user
 * pasting the `wc:` URI into the extension popup. It approves exactly two
 * methods and, importantly, `events: []` — so we must require no events or
 * the WalletConnect SDK rejects the session as unsatisfiable.
 */
import SignClient from '@walletconnect/sign-client'

export const CHAIN = 'xrpl:2' // 0 = mainnet, 1 = testnet, 2 = devnet
export const METHODS = ['xrpl_signTransaction', 'xrpl_signTransactionFor']

const METADATA = {
  name: 'BSA Capital',
  description: 'Compliant secondary market for closed-ended lending-fund shares',
  url: window.location.origin,
  icons: [],
}

let client = null

export async function getClient(projectId) {
  if (client) return client
  client = await SignClient.init({ projectId, metadata: METADATA })
  return client
}

export function accountOf(session) {
  const acct = session?.namespaces?.xrpl?.accounts?.[0]
  return acct ? acct.split(':')[2] : null
}

/** Returns { uri, approval } — show the uri, await approval() for the session. */
export async function startPairing(projectId) {
  const c = await getClient(projectId)
  return c.connect({
    requiredNamespaces: {
      xrpl: { chains: [CHAIN], methods: METHODS, events: [] },
    },
  })
}

export function allSessions() {
  return client ? client.session.getAll() : []
}

export function restoreSession() {
  const all = allSessions()
  return all.length ? all[all.length - 1] : null
}

export async function disconnect(session) {
  if (!client || !session) return
  await client.disconnect({
    topic: session.topic,
    reason: { code: 6000, message: 'User disconnected' },
  })
}

/**
 * Ask the wallet to sign a transaction.
 * Default: the wallet autofills, signs, submits and waits, returning
 * { tx_json (full validated result), tx_blob, hash }.
 * With submit:false it signs only and returns { tx_json }.
 */
export async function signAsCounterparty(session, tx_json) {
  const c = await getClient()
  return c.request({
    topic: session.topic,
    chainId: CHAIN,
    request: {
      method: 'xrpl_signTransactionFor',
      params: { tx_json, signature_target: 'Counterparty' },
    },
  })
}

export async function signTransaction(session, tx_json, { submit = true } = {}) {
  const c = await getClient()
  return c.request({
    topic: session.topic,
    chainId: CHAIN,
    request: { method: 'xrpl_signTransaction', params: { tx_json, submit } },
  })
}
