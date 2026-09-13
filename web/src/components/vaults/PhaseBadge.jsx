import { countdown } from '../../lib/ledger.js'

/** Where a fund is in its term, and how long that lasts. */
export default function PhaseBadge({ phase, nowMs }) {
  if (!phase) return <div className="phase p-unknown">unreadable</div>
  return (
    <div className={`phase p-${phase.phase.toLowerCase()}`}>
      {phase.phase}
      <span>{phase.endsAt ? countdown(phase.endsAt - nowMs) : 'open'}</span>
    </div>
  )
}
