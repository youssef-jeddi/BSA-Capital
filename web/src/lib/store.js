/**
 * There is no global vault index on-ledger, so remember the ones we create or
 * are told about. Per-browser only.
 */
const KEY = 'bsa_known_vaults'

export const knownVaults = () => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
}

export function rememberVault(entry) {
  const all = knownVaults().filter((v) => v.id !== entry.id)
  const next = [{ ...entry, at: Date.now() }, ...all].slice(0, 25)
  localStorage.setItem(KEY, JSON.stringify(next))
  return next
}

export function forgetVault(id) {
  const next = knownVaults().filter((v) => v.id !== id)
  localStorage.setItem(KEY, JSON.stringify(next))
  return next
}
