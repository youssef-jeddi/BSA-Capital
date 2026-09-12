import { zoneLabel } from '../../lib/zones.js'

/** Where a vault is open to invest from. */
export default function ZoneBadges({ zones, compact }) {
  if (!zones?.length) {
    return <span className="zone open">{compact ? 'Open' : 'Open to everyone'}</span>
  }
  return (
    <span className="zones">
      {zones.map((z) => (
        <span key={z} className="zone" title={zoneLabel(z)}>{z}</span>
      ))}
    </span>
  )
}
