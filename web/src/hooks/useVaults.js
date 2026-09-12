import { useCallback, useEffect, useMemo, useState } from 'react'
import { listVaults } from '../lib/api.js'
import { fetchVault, ledgerNowMs, phaseOf, pricePerShare } from '../lib/ledger.js'
import { useBoundaryRefresh } from './useClock.js'

/**
 * Joins the off-chain vault index with live ledger state. The API knows which
 * vaults exist and who issued them; the ledger owns phase, balances and price
 * per share, so nothing financial is ever read from our database.
 */
async function enrich(record, nowMs) {
  try {
    const { vault, issuance } = await fetchVault(record.vault_id)
    return {
      ...record,
      onChain: true,
      vault,
      issuance,
      phase: phaseOf(vault, nowMs),
      pps: pricePerShare(vault, issuance),
    }
  } catch {
    // Indexed but not readable: wrong network, or deleted on-ledger.
    return { ...record, onChain: false, vault: null, issuance: null, phase: null, pps: null }
  }
}

export function useVaults({ company, pollMs = 8000 } = {}) {
  const [state, setState] = useState({ loading: true, vaults: [], error: null, nowMs: Date.now() })

  const refresh = useCallback(async () => {
    try {
      const [records, nowMs] = await Promise.all([listVaults(company), ledgerNowMs()])
      const vaults = await Promise.all(records.map((r) => enrich(r, nowMs)))
      setState({ loading: false, vaults, error: null, nowMs })
    } catch (e) {
      setState((p) => ({ ...p, loading: false, error: e.message }))
    }
  }, [company])

  useEffect(() => {
    refresh()
    const t = setInterval(refresh, pollMs)
    return () => clearInterval(t)
  }, [refresh, pollMs])

  // A countdown reaching zero means the phase changed: refetch immediately
  // rather than showing a stale phase until the next poll.
  const boundaries = useMemo(() => state.vaults.map((v) => v.phase?.endsAt).filter(Boolean), [state.vaults])
  useBoundaryRefresh(boundaries, refresh, state.nowMs)

  return { ...state, refresh }
}
