import { useCallback, useEffect, useState } from 'react'
import { listSuperVaults } from '../lib/api.js'
import { fetchPosition, fetchVault, ledgerNowMs, phaseOf, pricePerShare } from '../lib/ledger.js'

/**
 * Super vault records joined with live ledger state, both for the super vault
 * itself and for every sub-vault position the deployment account holds.
 */
async function enrich(record, nowMs) {
  let own = null
  try {
    const { vault, issuance } = await fetchVault(record.vault_id)
    own = { vault, issuance, phase: phaseOf(vault, nowMs), pps: pricePerShare(vault, issuance) }
  } catch { /* not readable on this network */ }

  const positions = await Promise.all(record.allocations.map(async (a) => {
    try {
      const { vault, issuance } = await fetchVault(a.sub_vault_id)
      const pps = pricePerShare(vault, issuance)
      const held = await fetchPosition(record.deployment_address, vault.ShareMPTID)
      const shares = Number(held?.MPTAmount ?? 0)
      return {
        ...a, vault, issuance, pps, shares,
        phase: phaseOf(vault, nowMs),
        value: pps == null ? null : Math.floor(shares * pps),
        lastLedger: vault.PreviousTxnLgrSeq ?? null,
      }
    } catch {
      return { ...a, vault: null, pps: null, shares: 0, value: null, phase: null, lastLedger: null }
    }
  }))

  return { ...record, own, positions }
}

export function useSuperVaults({ curator, pollMs = 8000 } = {}) {
  const [state, setState] = useState({ loading: true, superVaults: [], error: null, nowMs: Date.now() })

  const refresh = useCallback(async () => {
    try {
      const [records, nowMs] = await Promise.all([listSuperVaults(curator), ledgerNowMs()])
      const superVaults = await Promise.all(records.map((r) => enrich(r, nowMs)))
      setState({ loading: false, superVaults, error: null, nowMs })
    } catch (e) {
      setState((p) => ({ ...p, loading: false, error: e.message }))
    }
  }, [curator])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, pollMs)
    return () => clearInterval(t)
  }, [refresh, pollMs])

  return { ...state, refresh }
}
