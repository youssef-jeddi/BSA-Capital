import { useState } from 'react'
import CreateSuperVault from './CreateSuperVault.jsx'
import SuperVaultDetail from './SuperVaultDetail.jsx'
import PhaseBadge from '../vaults/PhaseBadge.jsx'
import { useSuperVaults } from '../../hooks/useSuperVaults.js'
import { useVaults } from '../../hooks/useVaults.js'
import { bpsToPct } from '../../lib/superVault.js'

/** Browse super vaults, launch one, or open its dashboard. */
export default function SuperVaults({ session, address, company, role }) {
  const { superVaults, nowMs, loading, error, refresh } = useSuperVaults()
  const { vaults } = useVaults()
  const [view, setView] = useState({ mode: 'list' })

  const candidates = vaults.filter((v) => v.onChain && !superVaults.some((s) => s.vault_id === v.vault_id))
  const selected = superVaults.find((s) => s.vault_id === view.id)

  if (view.mode === 'create') {
    return (
      <CreateSuperVault session={session} address={address} company={company}
                        candidates={candidates} nowMs={nowMs}
                        onCancel={() => setView({ mode: 'list' })}
                        onCreated={(s) => { refresh(); setView({ mode: 'detail', id: s.vault_id }) }} />
    )
  }

  if (view.mode === 'detail' && selected) {
    return (
      <SuperVaultDetail entry={selected} nowMs={nowMs} session={session} address={address}
                        onBack={() => setView({ mode: 'list' })} onRefresh={refresh} />
    )
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Super vaults</h2>
        {role === 'company' && (
          <button className="primary sm" onClick={() => setView({ mode: 'create' })}>Launch one</button>
        )}
      </div>
      <p className="lede">
        A curated fund-of-funds: one position for the depositor, spread across several funds
        by a curator.
      </p>

      {error && <p className="status err">{error}</p>}
      {loading && !superVaults.length && <p className="status">Loading…</p>}
      {!loading && !superVaults.length && (
        <p className="empty">
          No super vaults yet.{role === 'company'
            ? ' Launch one to allocate across the funds on the platform.'
            : ' Only registered companies can curate one.'}
        </p>
      )}

      <div className="vaultgrid">
        {superVaults.map((s) => (
          <button key={s.vault_id} className="vaultcard" onClick={() => setView({ mode: 'detail', id: s.vault_id })}>
            <div className="vaultcard-head">
              <div>
                <b>{s.name}</b>
                <div className="dim">{s.curator_name} · {s.positions.length} sub-funds</div>
              </div>
              <PhaseBadge phase={s.own?.phase} nowMs={nowMs} />
            </div>
            <div className="allocbar">
              {s.positions.map((p) => (
                <span key={p.sub_vault_id} style={{ flexGrow: p.target_bps }}
                      title={`${p.sub_vault_name}: ${bpsToPct(p.target_bps)}%`} />
              ))}
            </div>
            <div className="vaultcard-foot">
              <span className={s.status === 'deployed' ? 'cta open' : 'cta'}>{s.status} →</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}
