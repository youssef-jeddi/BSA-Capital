import { useState } from 'react'
import CreateVault from './CreateVault.jsx'
import MyVaults from './vaults/MyVaults.jsx'

/** Everything a fund manager does with funds they issue. */
const TABS = [
  { id: 'mine', label: 'My funds' },
  { id: 'issue', label: 'Issue a fund' },
]

export default function Manage({ session, address, company, onGoToFunds }) {
  const [tab, setTab] = useState('mine')

  return (
    <>
      <nav className="subtabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'subtab on' : 'subtab'}
                  onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </nav>
      {tab === 'mine'
        ? <MyVaults session={session} address={address} company={company} onGoToInvest={onGoToFunds} />
        : <CreateVault session={session} address={address} company={company} />}
    </>
  )
}
