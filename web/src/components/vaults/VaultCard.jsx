import { assetToDisplay } from '../../lib/ledger.js'
import PhaseBadge from './PhaseBadge.jsx'

/** One fund in the browse list. Presentation only. */
export default function VaultCard({ entry, nowMs, onOpen }) {
  const { vault, phase, pps, onChain } = entry
  const open = phase?.phase === 'Subscription'

  return (
    <button className="vaultcard" onClick={() => onOpen(entry)}>
      <div className="vaultcard-head">
        <div>
          <b>{entry.name}</b>
          <div className="dim">{entry.company_name} · {entry.company_activity}</div>
        </div>
        <PhaseBadge phase={phase} nowMs={nowMs} />
      </div>

      {onChain ? (
        <div className="vaultcard-stats">
          <div><span>Raised</span><b>{assetToDisplay(vault, vault.AssetsTotal)} {entry.asset_code}</b></div>
          <div><span>Price / share</span><b>{pps == null ? '—' : pps.toFixed(6)}</b></div>
          <div><span>Access</span><b>{entry.is_private ? 'Credential-gated' : 'Open'}</b></div>
        </div>
      ) : (
        <p className="dim">Not readable on this network.</p>
      )}

      <div className="vaultcard-foot">
        <span className={open ? 'cta open' : 'cta'}>
          {open ? 'Open for deposits →' : `${phase?.phase ?? 'Unavailable'} — view details →`}
        </span>
      </div>
    </button>
  )
}
