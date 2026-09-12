import { useCallback, useEffect, useState } from 'react'
import { getHolderZones, getZones } from '../lib/api.js'

/** The zone catalogue and its domains. Static for the life of the platform. */
export function useZoneCatalogue() {
  const [state, setState] = useState({ loading: true, zones: [], domains: [], admin: null })
  useEffect(() => {
    getZones()
      .then((d) => setState({ loading: false, ...d }))
      .catch(() => setState({ loading: false, zones: [], domains: [], admin: null }))
  }, [])
  return state
}

/** Which zone credentials the connected wallet holds, and whether it accepted them. */
export function useHolderZones(address) {
  const [state, setState] = useState({ loading: true, zones: [], issuer: null })

  const refresh = useCallback(() => {
    if (!address) return setState({ loading: false, zones: [], issuer: null })
    setState((p) => ({ ...p, loading: true }))
    getHolderZones(address)
      .then((d) => setState({ loading: false, zones: d.zones ?? [], issuer: d.issuer ?? null }))
      .catch(() => setState({ loading: false, zones: [], issuer: null }))
  }, [address])

  useEffect(() => { refresh() }, [refresh])
  return { ...state, refresh }
}
