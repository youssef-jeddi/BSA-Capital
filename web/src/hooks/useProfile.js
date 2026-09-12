import { useCallback, useEffect, useState } from 'react'
import { getProfile } from '../lib/api.js'

/**
 * Resolves the connected wallet to a company, an individual investor, or
 * nothing (needs onboarding). Everything downstream branches on `role`.
 */
export function useProfile(address) {
  const [state, setState] = useState({ loading: true, role: null, profile: null, error: null })

  const refresh = useCallback(async () => {
    if (!address) return setState({ loading: false, role: null, profile: null, error: null })
    setState((p) => ({ ...p, loading: true }))
    try {
      const { role, profile } = await getProfile(address)
      setState({ loading: false, role, profile, error: null })
    } catch (e) {
      // Distinct from role:null. Treating a failed lookup as "not registered"
      // would push a returning company back into the sign-up form.
      setState({ loading: false, role: null, profile: null, error: e.message })
    }
  }, [address])

  useEffect(() => { refresh() }, [refresh])

  return { ...state, refresh }
}
