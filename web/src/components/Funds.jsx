import { useState } from 'react'
import Invest from './vaults/Invest.jsx'
import Marketplace from './market/Marketplace.jsx'

/**
 * Both places you can buy a position, under one heading.
 *
 * "Invest" and "Marketplace" were sibling top-level destinations, which read as
 * unrelated features. They are the primary and secondary market for the same asset.
 */
const TABS = [
  { id: 'primary', label: 'Vaults', hint: 'Subscribe while a fund is still raising' },
  { id: 'secondary', label: 'Shares marketplace', hint: 'Buy a locked position from another investor' },
]

export default function Funds({ session, address }) {
  const [tab, setTab] = useState('primary')

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
      {tab === 'primary'
        ? <Invest session={session} address={address} />
        : <Marketplace session={session} address={address} />}
    </>
  )
}
