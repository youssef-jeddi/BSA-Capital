import { bpsToPct, pctToBps, TOTAL_BPS } from '../../lib/superVault.js'
import { countdown } from '../../lib/ledger.js'

/**
 * Pick sub-vaults and set weights. Flags any fund that redeems too late for the
 * cascade, which is the one rule the protocol will not enforce for us.
 */
export default function AllocationPlanner({ candidates, allocations, onChange, ceiling, superSubscription, nowMs }) {
  const byId = new Map(allocations.map((a) => [a.sub_vault_id, a]))
  const total = allocations.reduce((s, a) => s + a.target_bps, 0)

  const toggle = (vault) => {
    if (byId.has(vault.vault_id)) {
      onChange(allocations.filter((a) => a.sub_vault_id !== vault.vault_id))
    } else {
      onChange([...allocations, { sub_vault_id: vault.vault_id, target_bps: 0 }])
    }
  }

  const setWeight = (id, pct) =>
    onChange(allocations.map((a) => (a.sub_vault_id === id ? { ...a, target_bps: pctToBps(pct) } : a)))

  /** Even split, remainder onto the first, so it always lands on exactly 100%. */
  const even = () => {
    if (!allocations.length) return
    const base = Math.floor(TOTAL_BPS / allocations.length)
    onChange(allocations.map((a, i) => ({
      ...a, target_bps: i === 0 ? TOTAL_BPS - base * (allocations.length - 1) : base,
    })))
  }

  if (!candidates.length) {
    return <p className="empty">No funds are listed yet. Seed some with <code>npm run seed</code>.</p>
  }

  return (
    <>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 10 }}>
        <span className="dim">{allocations.length} selected · {bpsToPct(total)}% allocated</span>
        <button type="button" className="ghost sm" onClick={even} disabled={!allocations.length}>
          Split evenly
        </button>
      </div>

      <div className="alloclist">
        {candidates.map((v) => {
          const picked = byId.get(v.vault_id)
          const late = ceiling != null && v.redemption_date != null && v.redemption_date > ceiling
          // Capital only arrives after this super vault stops raising, so a fund
          // that closes earlier can never be funded.
          const closesFirst = superSubscription != null && v.subscription_date != null
            && v.subscription_date <= superSubscription
          const blocked = late || closesFirst
          return (
            <div key={v.vault_id} className={blocked ? 'allocrow late' : 'allocrow'}>
              <label className="allocpick">
                <input type="checkbox" checked={!!picked} onChange={() => toggle(v)} disabled={blocked} />
                <span>
                  <b>{v.name}</b>
                  <small>
                    {v.company_name}
                    {v.phase && ` · ${v.phase.phase}`}
                    {v.phase?.endsAt && ` · ${countdown(v.phase.endsAt - nowMs)} left`}
                  </small>
                </span>
              </label>

              {late ? (
                <span className="late-tag">redeems too late</span>
              ) : closesFirst ? (
                <span className="late-tag">closes before you finish raising</span>
              ) : picked ? (
                <span className="allocweight">
                  <input type="number" min="1" max="100" step="1"
                         value={picked.target_bps ? bpsToPct(picked.target_bps) : ''}
                         onChange={(e) => setWeight(v.vault_id, e.target.value)} />
                  <span>%</span>
                </span>
              ) : null}
            </div>
          )
        })}
      </div>
    </>
  )
}
