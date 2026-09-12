/** Thin client for the onboarding API. One function per endpoint, no state. */
const BASE = '/api'

export class ApiError extends Error {
  constructor(errors, status) {
    super(errors[0] ?? 'Request failed')
    this.errors = errors
    this.status = status
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
const put = (path, data) => request(path, { method: 'PUT', body: JSON.stringify(data) })

export const getProfile = (address) => request(`/profile/${address}`)

export const listCompanies = (status) =>
  request(`/companies${status ? `?status=${status}` : ''}`)
export const getCompany = (address) => request(`/companies/${address}`)
export const registerCompany = (data) => post('/companies', data)
export const updateCompany = (address, data) => put(`/companies/${address}`, data)

export const listUsers = (status) => request(`/users${status ? `?status=${status}` : ''}`)
export const registerUser = (data) => post('/users', data)
export const updateUser = (address, data) => put(`/users/${address}`, data)

export const listVaults = (company) =>
  request(`/vaults${company ? `?company=${company}` : ''}`)
export const getVault = (vaultId) => request(`/vaults/${vaultId}`)
export const recordVault = (data) => post('/vaults', data)

export const listSuperVaults = (curator) =>
  request(`/super-vaults${curator ? `?curator=${curator}` : ''}`)
export const getSuperVault = (id) => request(`/super-vaults/${id}`)
export const createSuperVault = (data) => post('/super-vaults', data)
export const markSuperVaultDeployed = (id, loan_id) => post(`/super-vaults/${id}/deploy`, { loan_id })
export const markAllocationFunded = (id, subId, tx_hash) =>
  post(`/super-vaults/${id}/allocations/${subId}/funded`, { tx_hash })

export const getDeploymentAccount = () => request('/deployment-account')
export const counterSignWithDeployer = (superVaultId, tx_json) =>
  post(`/super-vaults/${superVaultId}/counter-sign`, { tx_json })
export const depositAsDeployer = (superVaultId, subVaultId, amount) =>
  post(`/super-vaults/${superVaultId}/allocations/${subVaultId}/deposit`, { amount })

export const getUnwindState = (superVaultId) => request(`/super-vaults/${superVaultId}/unwind`)
export const repayCuratorLoan = (superVaultId, amount) =>
  post(`/super-vaults/${superVaultId}/repay`, { amount })
export const withdrawFromSubFund = (superVaultId, subVaultId, shares) =>
  post(`/super-vaults/${superVaultId}/allocations/${subVaultId}/withdraw`, { shares })

export const getZones = () => request('/zones')
export const getHolderZones = (address) => request(`/zones/holder/${address}`)
export const requestZoneCredential = (address, zone) => post('/zones/credentials', { address, zone })
export const resolveZoneDomain = (zones) => post('/zones/domain', { zones })
