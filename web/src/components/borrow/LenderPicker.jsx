import { assetToDisplay, countdown } from '../../lib/ledger.js'

/**
 * Browse the funds that will actually lend, instead of pasting a broker id.
 * Only funds in their Investment phase can originate a loan, so the rest are
 * listed but not selectable, with the reason shown.
 */
export default function LenderPicker({ lenders, selected, onSelect, nowMs, loading }) {
  if (loading && !lenders.length) return <p className="status">Loading lenders…</p>
  if (!lenders.length) {
    return <p className="empty">No fund on the platform has a loan broker registered yet.</p>
  }

  return (
    <div className="alloclist">
      {lenders.map((l) => {
        const lending = l.phase?.phase === 'Investment'
        const available = l.vault ? Number(l.vault.AssetsAvailable ?? 0) : 0
        const active = selected === l.loan_broker_id
        return (
          <button key={l.vault_id} type="button"
                  className={`allocrow lender${active ? ' active' : ''}${lending ? '' : ' late'}`}
                  onClick={() => lending && onSelect(l)} disabled={!lending}>
            <div>
              <b>{l.name}</b>
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
                : <span className="late-tag">{l.phase ? `${l.phase.phase} — cannot lend` : 'unreadable'}</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}
