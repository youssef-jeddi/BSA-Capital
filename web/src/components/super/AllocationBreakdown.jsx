import { dropsToXrp } from 'xrpl'
import { bpsToPct } from '../../lib/superVault.js'

const xrp = (drops) =>
  drops == null ? '—' : Number(dropsToXrp(String(Math.floor(drops)))).toFixed(4)

/**
 * What a super vault actually holds.
 *
 * An investor buying a fund-of-funds is buying the allocation, so the holdings
 * are the product. Target weight is the curator's plan; actual weight is what
 * the deployed positions are worth right now, and the two diverge as sub-funds
 * accrue interest at different rates.
 */
export default function AllocationBreakdown({ positions, renderAction }) {
  if (!positions?.length) return <p className="dim">No allocation recorded for this super vault.</p>

  const valued = positions.filter((p) => p.value != null)
  const navTotal = valued.reduce((sum, p) => sum + p.value, 0)
  const managers = new Set(positions.map((p) => p.sub_company_address ?? p.sub_vault_id)).size
  const funded = positions.filter((p) => p.shares > 0).length

  return (
    <>
      <div className="allocbar big">
        {positions.map((p) => (
          <span key={p.sub_vault_id} style={{ flexGrow: p.target_bps }}
                title={`${p.sub_vault_name}: ${bpsToPct(p.target_bps)}%`} />
        ))}
      </div>

      <div className="holdings">
        <div className="holdings-head">
          <span>Fund</span><span>Target</span><span>Actual</span><span>Value</span>
          {renderAction && <span />}
        </div>
        {positions.map((p) => {
          const actual = navTotal > 0 && p.value != null ? (p.value / navTotal) * 100 : null
          return (
            <div key={p.sub_vault_id} className="holdings-row">
              <div>
                <b>{p.sub_vault_name ?? p.sub_vault_id.slice(0, 10)}</b>
                <small>
                  {p.sub_company_name ?? 'unknown issuer'}
                  {p.phase && ` · ${p.phase.phase}`}
                  {p.lastLedger && ` · ledger ${p.lastLedger}`}
                </small>
              </div>
              <span className="num target">{bpsToPct(p.target_bps)}%</span>
              <span className="num">{actual == null ? '—' : `${actual.toFixed(1)}%`}</span>
              <span className="num">{p.shares ? `${xrp(p.value)} XRP` : 'not funded'}</span>
              {renderAction && <span className="num">{renderAction(p)}</span>}
            </div>
          )
        })}
      </div>

      <p className="dim">
        {positions.length} fund{positions.length === 1 ? '' : 's'} across {managers} manager
        {managers === 1 ? '' : 's'} · {funded} of {positions.length} funded
        {navTotal > 0 && ` · ${xrp(navTotal)} XRP deployed`}
      </p>
      <p className="dim">
        Actual weights drift from target because price per share only moves when a sub-fund receives
        an interest payment. Per-fund ledger sequences are shown rather than one blended figure.
      </p>
    </>
  )
}
