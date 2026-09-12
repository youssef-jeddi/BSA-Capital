import { useMemo, useState } from 'react'
import VaultCard from './VaultCard.jsx'
import {
  PHASE_FILTERS, SORTS, filterVaults, issuersOf, openCount, sortVaults,
} from '../../lib/vaultFilters.js'

/** Browse every fund the platform knows about, filtered by issuer and phase. */
export default function VaultList({ vaults, nowMs, loading, error, onOpen }) {
  const [phase, setPhase] = useState('open')
  const [issuer, setIssuer] = useState('all')
  const [sort, setSort] = useState('closing')
  const [kind, setKind] = useState('all')

  const byKind = useMemo(
    () => (kind === 'all' ? vaults : vaults.filter((v) => (v.kind ?? 'fund') === kind)),
    [vaults, kind],
  )
  const counts = useMemo(() => ({
    all: vaults.length,
    fund: vaults.filter((v) => (v.kind ?? 'fund') === 'fund').length,
    super: vaults.filter((v) => v.kind === 'super').length,
  }), [vaults])

  const issuers = useMemo(() => issuersOf(byKind), [byKind])
  const shown = useMemo(
    () => sortVaults(filterVaults(byKind, { phase, issuer }), sort),
    [byKind, phase, issuer, sort],
  )

  const selectedIssuer = issuers.find((i) => i.address === issuer)

  return (
    <div className="card">
      <h2>Funds</h2>
      <p className="lede">
        Browse funds issued on the platform. Deposits are only accepted during a fund's
        Subscription window, which the ledger enforces.
      </p>

      <div className="filters">
        <div className="chips">
          {[{ id: 'all', label: 'Everything' },
            { id: 'fund', label: 'Funds' },
            { id: 'super', label: 'Super vaults' }].map((k) => (
            <button key={k.id} type="button" className={kind === k.id ? 'chip on' : 'chip'}
                    onClick={() => setKind(k.id)}>
              {k.label}<span className="count">{counts[k.id]}</span>
            </button>
          ))}
        </div>
        <div className="chips">
          {PHASE_FILTERS.map((f) => (
            <button key={f.id} type="button" className={phase === f.id ? 'chip on' : 'chip'}
                    onClick={() => setPhase(f.id)}>
              {f.label}
              <span className="count">
                {f.id === 'open'
                  ? openCount(byKind, issuer)
                  : filterVaults(byKind, { phase: 'all', issuer }).length}
              </span>
            </button>
          ))}
        </div>

        <div className="row filter-row">
          <label className="inline">
            Issuer
            <select value={issuer} onChange={(e) => setIssuer(e.target.value)}>
              <option value="all">All issuers ({byKind.length})</option>
              {issuers.map((i) => (
                <option key={i.address} value={i.address}>{i.name} ({i.count})</option>
              ))}
            </select>
          </label>

          <label className="inline">
            Sort
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </label>

          {issuer !== 'all' && (
            <button className="ghost sm" onClick={() => setIssuer('all')}>Clear</button>
          )}
        </div>
      </div>

      {selectedIssuer && (
        <p className="dim issuer-note">
          Showing funds issued by <b>{selectedIssuer.name}</b> — {selectedIssuer.activity}
        </p>
      )}

      {error && <p className="status err">{error}</p>}
      {loading && !vaults.length && <p className="status">Loading funds…</p>}

      {!loading && !shown.length && (
        <p className="empty">
          {phase === 'open'
            ? 'No fund is currently open for deposits with these filters. Switch to All funds.'
            : 'No funds match these filters.'}
        </p>
      )}

      <div className="vaultgrid">
        {shown.map((entry) => (
          <VaultCard key={entry.vault_id} entry={entry} nowMs={nowMs} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}
