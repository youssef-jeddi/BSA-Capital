/**
 * Holds a half-signed curator loan between the two signatures.
 *
 * A LoanSet needs both parties, but a WalletConnect session is bound to one
 * account, so the curator signs, the user switches account, and the deployment
 * account counter-signs. Switching account remounts the tab, so this cannot
 * live in component state: it is persisted per super vault, per browser.
 */
const KEY = 'bsa_pending_curator_loans'

const readAll = () => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '{}') } catch { return {} }
}

const writeAll = (all) => {
  try { localStorage.setItem(KEY, JSON.stringify(all)) } catch { /* private mode */ }
}

export function savePendingLoan(superVaultId, txJson) {
  writeAll({ ...readAll(), [superVaultId]: { txJson, savedAt: Date.now() } })
}

export const getPendingLoan = (superVaultId) => readAll()[superVaultId] ?? null

export function clearPendingLoan(superVaultId) {
  const all = readAll()
  delete all[superVaultId]
  writeAll(all)
}
