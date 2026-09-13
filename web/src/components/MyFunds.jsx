import { useState } from 'react'
import LaunchFund from './LaunchFund.jsx'
import MyVaults from './vaults/MyVaults.jsx'

/** Everything you do as an issuer: start a new fund, or run the ones you have. */
const TABS = [
  { id: 'launch', label: 'Launch a fund', hint: 'Create a fund or a super vault' },
  { id: 'manage', label: 'Manage', hint: 'The funds and super vaults you already issued' },
]

export default function MyFunds({ session, address, company, onGoToInvest }) {
  const [tab, setTab] = useState('manage')

  return (
    <>
      <nav className="subtabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'subtab on' : 'subtab'}
                  onClick={() => setTab(t.id)} title={t.hint}>
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'launch'
        ? <LaunchFund session={session} address={address} company={company} />
        : <MyVaults session={session} address={address} company={company}
                    onGoToInvest={onGoToInvest} onGoToLaunch={() => setTab('launch')} />}
    </>
  )
}
