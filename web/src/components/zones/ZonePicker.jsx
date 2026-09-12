import ZoneBadges from './ZoneBadges.jsx'
import { zoneLabel } from '../../lib/zones.js'

/**
 * Managers choose regulatory zones, never a domain id.
 *
 * The platform owns one permissioned domain per combination of zones, so the
 * choice here resolves to a DomainID behind the scenes. Choosing none leaves
 * the vault open to everyone.
 */
export default function ZonePicker({ available, selected, onChange }) {
  const toggle = (code) =>
    onChange(selected.includes(code) ? selected.filter((z) => z !== code) : [...selected, code])

  return (
    <>
      <div className="zonegrid">
        {available.map((z) => (
          <button key={z.code} type="button"
                  className={selected.includes(z.code) ? 'zonecard on' : 'zonecard'}
                  onClick={() => toggle(z.code)}>
            <b>{z.code}</b>
            <span>{z.label ?? zoneLabel(z.code)}</span>
          </button>
        ))}
      </div>
      <p className="dim">
        {selected.length === 0 ? (
          <>No restriction: anyone can invest, and the vault carries no permissioned domain.</>
        ) : (
          <>
            Only investors holding a credential for <b>{selected.join(' or ')}</b> will be able to
            deposit or borrow. The ledger enforces this, not the app.
          </>
        )}
      </p>
      <div className="row"><ZoneBadges zones={selected} /></div>
    </>
  )
}
