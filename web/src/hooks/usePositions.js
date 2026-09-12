import { useCallback, useEffect, useState } from 'react'
import { listVaults, listSuperVaults } from '../lib/api.js'
import {
  fetchPosition, fetchVault, isXrpVault, ledgerNowMs, phaseOf, pricePerShare,
} from '../lib/ledger.js'

/**
 * Everywhere this wallet holds shares.
 *
 * There is no on-ledger index of vaults, so we walk the platform's own list and
 * check each share issuance for a holding. Value and phase come from the ledger.
 */
async function positionIn(record, address, nowMs, kind) {
  try {
    const { vault, issuance } = await fetchVault(record.vault_id)
    const held = await fetchPosition(address, vault.ShareMPTID)
    const shares = Number(held?.MPTAmount ?? 0)
    if (!shares) return null

    const pps = pricePerShare(vault, issuance)
    const phase = phaseOf(vault, nowMs)
    return {
      kind,
      vault_id: record.vault_id,
      name: record.name,
      issuer: record.company_name ?? record.curator_name,
      unit: isXrpVault(vault) ? 'XRP' : (vault.Asset.currency ?? 'units'),
      vault, issuance, phase, pps, shares,
      value: pps == null ? null : Math.floor(shares * pps),
      canWithdraw: phase.phase !== 'Investment',
    }
  } catch { return null }
}

export function usePositions(address, { pollMs = 8000 } = {}) {
  const [state, setState] = useState({ loading: true, positions: [], error: null, nowMs: Date.now() })

  const refresh = useCallback(async () => {
    if (!address) return setState({ loading: false, positions: [], error: null, nowMs: Date.now() })
    try {
      const [funds, supers, nowMs] = await Promise.all([listVaults(), listSuperVaults(), ledgerNowMs()])
      const found = await Promise.all([
        ...funds.map((f) => positionIn(f, address, nowMs, 'fund')),
        ...supers.map((s) => positionIn(s, address, nowMs, 'super')),
      ])
      setState({ loading: false, positions: found.filter(Boolean), error: null, nowMs })
    } catch (e) {
      setState((p) => ({ ...p, loading: false, error: e.message }))
    }
  }, [address])

  useEffect(() => { refresh(); const t = setInterval(refresh, pollMs); return () => clearInterval(t) }, [refresh, pollMs])

  return { ...state, refresh }
}
