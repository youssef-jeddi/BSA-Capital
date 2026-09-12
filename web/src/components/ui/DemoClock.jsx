import { useState } from 'react'
import { getDemoOffset, setDemoOffset } from '../../hooks/useClock.js'

const JUMPS = [
  { label: '−5 min', ms: -5 * 60_000 },
  { label: '+1 min', ms: 60_000 },
  { label: '+5 min', ms: 5 * 60_000 },
  { label: '+30 min', ms: 30 * 60_000 },
]

/**
 * Shifts only the app's view of "now".
 *
 * A vault's SubscriptionDate and RedemptionDate are immutable: VaultSet can
 * change Data, AssetsMaximum and DomainID and nothing else, so a live vault's
 * phase can never be moved. This previews how a screen will look in a later
 * phase. The ledger is unaffected, so transactions are still judged on real
 * time and will be rejected accordingly.
 */
export default function DemoClock() {
  const [offset, setOffset] = useState(getDemoOffset)

  const apply = (ms) => { setDemoOffset(ms); setOffset(ms) }
  const minutes = Math.round(offset / 60_000)

  return (
    <div className={offset ? 'democlock on' : 'democlock'}>
      <span className="democlock-label">
        Preview clock
        {offset !== 0 && <b> {minutes > 0 ? '+' : ''}{minutes} min</b>}
      </span>
      {JUMPS.map((j) => (
        <button key={j.label} type="button" className="chip tiny"
                onClick={() => apply(offset + j.ms)}>{j.label}</button>
      ))}
      {offset !== 0 && (
        <button type="button" className="chip tiny reset" onClick={() => apply(0)}>Reset</button>
      )}
      {offset !== 0 && (
        <small>Display only — the ledger still uses real time and will reject early actions.</small>
      )}
    </div>
  )
}
