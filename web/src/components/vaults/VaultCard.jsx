import { rippleTimeToUnixTime } from 'xrpl'
import { assetToDisplay } from '../../lib/ledger.js'
import PhaseBadge from './PhaseBadge.jsx'
import ZoneBadges from '../zones/ZoneBadges.jsx'
import LifecycleRail from '../ui/LifecycleRail.jsx'

const DATE = { day: 'numeric', month: 'short' }
const shortDate = (ms) => new Date(ms).toLocaleDateString('en-GB', DATE)

const num = (v) =>
  v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 0 })

/** One fund in the browse list. Presentation only. */
export default function VaultCard({ entry, nowMs, onOpen }) {
  const { vault, phase, pps, onChain } = entry
  const open = phase?.phase === 'Subscription'
  const sub = vault ? rippleTimeToUnixTime(vault.SubscriptionDate) : null
  const red = vault ? rippleTimeToUnixTime(vault.RedemptionDate) : null
  // The ledger records no creation date, so the rail's left edge comes from the index.
  const start = entry.created_at ? Date.parse(entry.created_at) : null

  return (
    <button className={entry.kind === 'super' ? 'vaultcard is-super' : 'vaultcard'}
            onClick={() => onOpen(entry)}>
      <div className="vaultcard-head">
        <div>
          <b>{entry.name}</b>
          {entry.kind === 'super' && <span className="tag super">Fund of funds</span>}
          <div className="dim">
            {entry.company_name} · {entry.company_activity}
            {entry.kind === 'super' && entry.positions && ` · ${entry.positions.length} sub-funds`}
          </div>
        </div>
        <PhaseBadge phase={phase} nowMs={nowMs} />
      </div>

      {onChain ? (
        <>
          <div className="vaultcard-stats">
            <div><span>Raised</span><b>{num(assetToDisplay(vault, vault.AssetsTotal))}</b></div>
            <div><span>Lent out</span>
                 <b>{num(assetToDisplay(vault, Number(vault.AssetsTotal ?? 0) - Number(vault.AssetsAvailable ?? 0)))}</b></div>
            <div><span>Price / share</span><b>{pps == null ? '—' : pps.toFixed(6)}</b></div>
          </div>

          {/* The term at a glance: how much of it has already run. */}
          <LifecycleRail start={start} sub={sub} red={red} nowMs={nowMs}
                         legend={[start ? shortDate(start) : 'launch',
                                  `closes ${shortDate(sub)}`,
                                  `redeems ${shortDate(red)}`]} />
        </>
      ) : (
        <p className="dim">Not readable on this network.</p>
      )}

      <div className="vaultcard-foot">
        <ZoneBadges zones={entry.zones} compact />
        <span className={open ? 'cta open' : 'cta'}>
          {open ? 'Open for deposits' : `${phase?.phase ?? 'Unavailable'} — view details`}
        </span>
      </div>
    </button>
  )
}
