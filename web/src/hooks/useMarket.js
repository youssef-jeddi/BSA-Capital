import { useCallback, useEffect, useState } from 'react'
import { getEligibility, getMarket } from '../lib/api.js'

export function useMarket(filters = {}, pollMs = 10000) {
  const key = JSON.stringify(filters)
  const [state, setState] = useState({ loading: true, listings: [], error: null })

  const refresh = useCallback(() => {
    getMarket(JSON.parse(key))
      .then((listings) => setState({ loading: false, listings, error: null }))
      .catch((e) => setState((p) => ({ ...p, loading: false, error: e.message })))
  }, [key])

  useEffect(() => { refresh(); const t = setInterval(refresh, pollMs); return () => clearInterval(t) },
    [refresh, pollMs])

  return { ...state, refresh }
}

/** The two receive-gates for one account against one vault. */
export function useEligibility(vaultId, address) {
  const [state, setState] = useState({ loading: true, eligibility: null })

  const refresh = useCallback(() => {
    if (!vaultId || !address) return setState({ loading: false, eligibility: null })
    setState((p) => ({ ...p, loading: true }))
    getEligibility(vaultId, address)
      .then((eligibility) => setState({ loading: false, eligibility }))
      .catch(() => setState({ loading: false, eligibility: null }))
  }, [vaultId, address])

  useEffect(() => { refresh() }, [refresh])
  return { ...state, refresh }
}
