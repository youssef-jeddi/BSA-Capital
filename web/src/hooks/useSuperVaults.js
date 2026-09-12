import { useCallback, useEffect, useMemo, useState } from 'react'
import { listSuperVaults } from '../lib/api.js'
import { fetchPosition, fetchVault, ledgerNowMs, phaseOf, pricePerShare } from '../lib/ledger.js'
import { useBoundaryRefresh } from './useClock.js'

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
        // Nothing deposited yet is a value of zero. Only a position we cannot
        // read is genuinely unvalued, and an empty sub-fund has no price per
        // share at all (zero shares outstanding), which is not an error.
        value: shares === 0 ? 0 : (pps == null ? null : Math.floor(shares * pps)),
        fundable: null,
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

  // A countdown reaching zero means the phase changed: refetch immediately
  // rather than showing a stale phase until the next poll.
  const boundaries = useMemo(() => state.superVaults.map((s) => s.own?.phase?.endsAt).filter(Boolean), [state.superVaults])
  useBoundaryRefresh(boundaries, refresh, state.nowMs)

  return { ...state, refresh }
}
