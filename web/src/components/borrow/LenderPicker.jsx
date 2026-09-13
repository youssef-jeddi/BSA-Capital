import { assetToDisplay, countdown } from '../../lib/ledger.js'

/**
 * Browse the funds that will actually lend, instead of pasting a broker id.
 * A fund can only originate a loan while it is in its Investment phase and has
 * a loan broker registered, so the rest are listed but not selectable, each
 * with the reason it cannot lend.
 */
const reason = (l) => {
  if (!l.onChain) return 'not readable on this network'
  if (!l.loan_broker_id) return 'no loan broker registered'
  if (!l.phase) return 'phase unreadable'
  return `${l.phase.phase} — cannot lend`
}

export default function LenderPicker({ lenders, selected, onSelect, nowMs, loading }) {
  if (loading && !lenders.length) return <p className="status">Loading lenders…</p>
  if (!lenders.length) return <p className="empty">No fund is indexed on the platform yet.</p>

  const open = lenders.filter((l) => l.loan_broker_id && l.phase?.phase === 'Investment').length

  return (
    <div className="alloclist">
      <p className="dim" style={{ margin: '0 0 4px' }}>
        {open
          ? `${open} of ${lenders.length} funds can lend right now.`
          : `None of the ${lenders.length} indexed funds can lend right now — a fund lends only during its Investment phase.`}
      </p>
      {lenders.map((l) => {
        const lending = Boolean(l.loan_broker_id) && l.phase?.phase === 'Investment'
        // Selectable whenever there is a broker to address. A fund in the wrong
        // phase still produces a real transaction and a real refusal.
        const selectable = Boolean(l.loan_broker_id)
        const available = l.vault ? Number(l.vault.AssetsAvailable ?? 0) : 0
        const active = selected === l.loan_broker_id
        return (
          <button key={l.vault_id} type="button"
                  className={`allocrow lender${active ? ' active' : ''}${lending ? '' : ' late'}`}
                  onClick={() => selectable && onSelect(l)} disabled={!selectable}>
            <div>
              <b>{l.name || `Fund ${l.vault_id.slice(0, 8)}…`}</b>
              <small>
                {l.company_name} · {l.company_activity}
                {l.phase && ` · ${l.phase.phase}`}
                {l.phase?.endsAt && ` · ${countdown(l.phase.endsAt - nowMs)} left`}
              </small>
            </div>
            <div className="allocnums">
              <span>{l.vault ? `${assetToDisplay(l.vault, available)} ${l.asset_code} free` : '—'}</span>
              {lending
                ? <span className={active ? 'target' : ''}>{active ? 'selected' : 'select'}</span>
                : <span className="late-tag">{reason(l)}{selectable && ' · try anyway'}</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}
