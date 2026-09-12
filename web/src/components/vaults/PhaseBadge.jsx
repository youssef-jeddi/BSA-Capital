import { countdown } from '../../lib/ledger.js'

export default function PhaseBadge({ phase, nowMs }) {
  if (!phase) return <span className="phase p-unknown">unreadable</span>
  return (
    <div className={`phase p-${phase.phase.toLowerCase()}`}>
      {phase.phase}
      <span>{phase.endsAt ? `${countdown(phase.endsAt - nowMs)} left` : 'open'}</span>
    </div>
  )
}
