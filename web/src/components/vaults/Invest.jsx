import { useMemo, useState } from 'react'
import VaultList from './VaultList.jsx'
import VaultDetail from './VaultDetail.jsx'
import { useVaults } from '../../hooks/useVaults.js'
import { useSuperVaults } from '../../hooks/useSuperVaults.js'
import { asFundEntry } from '../../lib/superVault.js'
import { useClock } from '../../hooks/useClock.js'

/** Browse funds, open one, deposit. Owns only the list-versus-detail choice. */
export default function Invest({ session, address }) {
  const { vaults, loading, error, refresh } = useVaults()
  const { superVaults, refresh: refreshSupers } = useSuperVaults()
  const nowMs = useClock()

  // Super vaults are ordinary XLS-65 vaults with a curated strategy, so they
  // belong in the same list rather than hidden behind a separate tab.
  const all = useMemo(
    () => [...vaults.map((v) => ({ ...v, kind: 'fund' })), ...superVaults.map(asFundEntry)],
    [vaults, superVaults],
  )
  const refreshAll = () => { refresh(); refreshSupers() }
  const [openId, setOpenId] = useState(null)

  const selected = all.find((v) => v.vault_id === openId)

  if (openId && selected) {
    return (
      <VaultDetail entry={selected} nowMs={nowMs} session={session} address={address}
                   onBack={() => setOpenId(null)} onSettled={refreshAll} />
    )
  }

  return (
    <VaultList vaults={all} nowMs={nowMs} loading={loading} error={error}
               onOpen={(entry) => setOpenId(entry.vault_id)} />
  )
}
