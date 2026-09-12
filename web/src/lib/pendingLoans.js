/**
 * Holds a half-signed loan between its two signatures.
 *
 * Used by both the super vault deployment and the borrower flow: a LoanSet needs
 * signatures from both parties, but a WalletConnect session is bound to one
 * account, so one party signs, the user switches account, and the other
 * counter-signs. Switching account remounts the panel, so this cannot live in
 * component state; it is persisted per loan, per browser.
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

export const getPendingLoan = (key) => readAll()[key] ?? null

/** Every half-signed loan waiting on this account's counter-signature. */
export function pendingFor(address) {
  return Object.entries(readAll())
    .filter(([, v]) => v.txJson?.Counterparty === address)
    .map(([key, v]) => ({ key, ...v }))
}

export function clearPendingLoan(superVaultId) {
  const all = readAll()
  delete all[superVaultId]
  writeAll(all)
}
