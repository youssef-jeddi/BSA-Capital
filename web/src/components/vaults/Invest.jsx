import { useState } from 'react'
import VaultList from './VaultList.jsx'
import VaultDetail from './VaultDetail.jsx'
import { useVaults } from '../../hooks/useVaults.js'

/** Browse funds, open one, deposit. Owns only the list-versus-detail choice. */
export default function Invest({ session, address }) {
  const { vaults, nowMs, loading, error, refresh } = useVaults()
  const [openId, setOpenId] = useState(null)

  const selected = vaults.find((v) => v.vault_id === openId)

  if (openId && selected) {
    return (
      <VaultDetail entry={selected} nowMs={nowMs} session={session} address={address}
                   onBack={() => setOpenId(null)} onSettled={refresh} />
    )
  }

  return (
    <VaultList vaults={vaults} nowMs={nowMs} loading={loading} error={error}
               onOpen={(entry) => setOpenId(entry.vault_id)} />
  )
}
