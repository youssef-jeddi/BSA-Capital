/** Thin client for the onboarding API. One function per endpoint, no state. */
const BASE = '/api'

export class ApiError extends Error {
  constructor(errors, status) {
    super(errors[0] ?? 'Request failed')
    this.errors = errors
    this.status = status
  }
}

/**
 * Prove control of an account without a login.
 *
 * The API signs real transactions on our behalf, so the caller cannot simply
 * assert who they are. We sign a server nonce with submit:false — no fee, nothing
 * on the ledger — and send that as the proof.
 */
let signer = null
let onPending = null

export const setProofSigner = (fn) => { signer = fn }

/** The app subscribes so it can tell the user a wallet approval is waiting. */
export const setProofListener = (fn) => { onPending = fn }

const SIGN_TIMEOUT_MS = 120_000

/**
 * One signature per session, not per write.
 *
 * Asking the wallet to sign on every action produced a stream of AccountSet
 * approvals: exhausting, and desensitising — a user clicking through dialogs
 * stops reading them. The proof is exchanged once for a token held in memory
 * only, so it dies with the tab.
 */
let session = null

export const clearAuthSession = () => { session = null }

/** Null when the server does not require auth, so nothing asks the wallet to sign. */
let authRequired = null
const authMode = async () => {
  if (authRequired === null) {
    authRequired = await request('/auth/mode').then((m) => m.required).catch(() => false)
  }
  return authRequired
}

async function ensureSession(address) {
  if (!(await authMode())) return null
  if (session?.address === address && session.expiresAt > Date.now() + 30_000) return session.token
  const proof = await proveControl(address)
  const opened = await post('/auth/session', { proof })
  session = {
    address,
    token: opened.token,
    expiresAt: Date.now() + opened.expires_in_seconds * 1000,
  }
  return session.token
}

export async function proveControl(address) {
  if (!signer) throw new Error('Connect a wallet before doing that.')
  const challenge = await post('/auth/challenge', { address })

  onPending?.(true)
  try {
    // The wallet extension does not always bring its popup to the front, so a
    // request can sit unanswered with nothing on screen. Time out with an
    // instruction rather than spinning forever.
    const res = await Promise.race([
      signer(challenge.tx_json),
      new Promise((_, reject) => setTimeout(
        () => reject(new Error('No answer from your wallet. Open the extension — a signature request is waiting.')),
        SIGN_TIMEOUT_MS)),
    ])
    const tx = res?.tx_json ?? res
    if (!tx?.TxnSignature) throw new Error('The wallet did not return a signed proof.')
    return tx
  } finally {
    onPending?.(false)
  }
}

async function request(path, options = {}) {
  const res = await fetch(BASE + path, {
    headers: { 'content-type': 'application/json' },
    ...options,
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) throw new ApiError(body?.errors ?? [`Request failed (${res.status})`], res.status)
  return body
}

const post = (path, data) => request(path, { method: 'POST', body: JSON.stringify(data) })

/** POST with a freshly signed proof of control for `address`. */
/** POST authenticated by the session token, signing only when one is needed. */
const authed = async (address) => {
  const token = await ensureSession(address)
  return token ? { Authorization: `Bearer ${token}` } : {}
}

const postAs = async (address, path, data = {}) =>
  request(path, { method: 'POST', headers: await authed(address), body: JSON.stringify(data) })

const putAs = async (address, path, data = {}) =>
  request(path, { method: 'PUT', headers: await authed(address), body: JSON.stringify(data) })
const put = (path, data) => request(path, { method: 'PUT', body: JSON.stringify(data) })

export const getProfile = (address) => request(`/profile/${address}`)

export const listCompanies = (status) =>
  request(`/companies${status ? `?status=${status}` : ''}`)
export const getCompany = (address) => request(`/companies/${address}`)
export const registerCompany = (data) => postAs(data.address, '/companies', data)
export const updateCompany = (address, data) => putAs(address, `/companies/${address}`, data)

export const listUsers = (status) => request(`/users${status ? `?status=${status}` : ''}`)
export const registerUser = (data) => postAs(data.address, '/users', data)
export const updateUser = (address, data) => putAs(address, `/users/${address}`, data)

export const listVaults = (company) =>
  request(`/vaults${company ? `?company=${company}` : ''}`)
export const getVault = (vaultId) => request(`/vaults/${vaultId}`)
export const recordVault = (data) => postAs(data.company_address, '/vaults', data)

export const listSuperVaults = (curator) =>
  request(`/super-vaults${curator ? `?curator=${curator}` : ''}`)
export const getSuperVault = (id) => request(`/super-vaults/${id}`)
export const createSuperVault = (data) => postAs(data.curator_address, '/super-vaults', data)
export const markSuperVaultDeployed = (id, loan_id, curator) =>
  postAs(curator, `/super-vaults/${id}/deploy`, { loan_id })
export const markAllocationFunded = (id, subId, tx_hash, curator) =>
  postAs(curator, `/super-vaults/${id}/allocations/${subId}/funded`, { tx_hash })

export const getDeploymentAccount = () => request('/deployment-account')
export const counterSignWithDeployer = (superVaultId, tx_json, curator) =>
  postAs(curator, `/super-vaults/${superVaultId}/counter-sign`, { tx_json })
export const depositAsDeployer = (superVaultId, subVaultId, amount, curator) =>
  postAs(curator, `/super-vaults/${superVaultId}/allocations/${subVaultId}/deposit`, { amount })

export const getUnwindState = (superVaultId) => request(`/super-vaults/${superVaultId}/unwind`)
export const repayCuratorLoan = (superVaultId, amount, curator) =>
  postAs(curator, `/super-vaults/${superVaultId}/repay`, { amount })
export const withdrawFromSubFund = (superVaultId, subVaultId, shares, curator) =>
  postAs(curator, `/super-vaults/${superVaultId}/allocations/${subVaultId}/withdraw`, { shares })

export const getZones = () => request('/zones')
export const getHolderZones = (address) => request(`/zones/holder/${address}`)
export const requestZoneCredential = (address, zone) => postAs(address, '/zones/credentials', { address, zone })
export const resolveZoneDomain = (zones) => post('/zones/domain', { zones })

export const getCustody = () => request('/market/custody')
export const getMarket = (params = {}) => {
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v)).toString()
  return request(`/market${q ? `?${q}` : ''}`)
}
export const getMarketVault = (vaultId) => request(`/market/vault/${vaultId}`)
export const getEligibility = (vault, account) =>
  request(`/market/eligibility?vault=${vault}&account=${account}`)
export const prepareListing = (vault_id) => post('/market/prepare', { vault_id })
export const createListing = (data, seller) => postAs(seller, '/market/listings', data)
export const settleListing = (id, payment_hash, buyer) =>
  postAs(buyer, `/market/listings/${id}/settle`, { payment_hash })
export const cancelListing = (id, seller) => postAs(seller, `/market/listings/${id}/cancel`)
