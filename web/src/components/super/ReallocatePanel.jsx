import { useMemo, useState } from 'react'
import { dropsToXrp } from 'xrpl'
import Steps from '../Steps.jsx'
import { abandonExit, exitPosition, redeployProceeds } from '../../lib/api.js'
import { useVaults } from '../../hooks/useVaults.js'

const xrp = (drops) =>
  drops == null ? '—' : Number(dropsToXrp(String(Math.floor(Number(drops))))).toLocaleString('en-US', { maximumFractionDigits: 2 })

/**
 * Rebalancing a live super vault.
 *
 * The position is locked in its sub-fund's Investment phase, so this is not a
 * withdrawal. It is a sale on our own secondary market followed by a deposit
 * somewhere else, which means it takes a willing buyer and is not instant. The
 * panel is deliberately two steps so that gap is visible rather than hidden
 * behind a spinner.
 */
export default function ReallocatePanel({ entry, position, nowMs, onDone, onClose }) {
  const [discount, setDiscount] = useState('2')
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState('')
  const { vaults } = useVaults()

  const navTotal = position.value
  const bps = Math.round(Number(discount || 0) * 100)
  const ask = navTotal == null ? null : Math.floor((navTotal * (10000 - bps)) / 10000)
  const haircut = navTotal == null || ask == null ? null : navTotal - ask

  /**
   * Only funds that can actually accept a deposit. A vault refuses one outside
   * its subscription window, and the capital must come back before the curator
   * loan matures or it is locked when the loan comes due.
   */
  const destinations = useMemo(() => vaults.filter((v) => (
    v.onChain
    && v.vault_id !== position.sub_vault_id
    && v.vault_id !== entry.vault_id
    && v.phase?.phase === 'Subscription'
    && (entry.loan_maturity == null || v.redemption_date == null || v.redemption_date <= entry.loan_maturity)
  )), [vaults, position.sub_vault_id, entry.vault_id, entry.loan_maturity])

  async function run(label, fn) {
    setBusy(true); setSteps([{ label, state: 'pending' }])
    try {
      const out = await fn()
      setSteps([{ label, state: 'ok', code: out.result_code, hash: out.hash ?? out.transfer_hash,
                  detail: out.detail }])
      onDone?.()
      return out
    } catch (e) {
      setSteps([{ label, state: 'fail', error: e.errors?.[0] ?? e.message }])
    } finally { setBusy(false) }
  }

  const sell = () => run('List the position for sale', async () => {
    const out = await exitPosition(entry.vault_id, position.sub_vault_id, bps, entry.curator_address)
    return { ...out, hash: out.transfer_hash,
             detail: `Listed ${Number(out.shares).toLocaleString('en-US')} shares at ${xrp(out.ask_drops)} XRP.\n`
               + `Nothing moves until a verified investor buys it.` }
  })

  const cancel = () => run('Take the listing down', () =>
    abandonExit(entry.vault_id, position.sub_vault_id, entry.curator_address))

  const redeploy = () => run('Deposit the proceeds', async () => {
    const out = await redeployProceeds(entry.vault_id, position.sub_vault_id, target, entry.curator_address)
    return { ...out, detail: `Moved ${xrp(out.moved_drops)} XRP into the new fund.` }
  })

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="sect-row">
        <div className="sect">Reallocate {position.sub_vault_name}</div>
        <button className="back" style={{ marginBottom: 0 }} onClick={onClose}>Close</button>
      </div>

      {position.status !== 'exiting' ? (
        <>
          <p className="dim">
            This position is locked in its fund&apos;s Investment phase, so it cannot be withdrawn.
            The only exit is to sell the shares to another verified investor and deposit the
            proceeds elsewhere. The curator loan is unchanged: same principal, same maturity,
            different backing.
          </p>

          <label className="field-label">Discount to net asset value (%)</label>
          <input type="number" min="0" max="99" step="0.1" value={discount}
                 onChange={(e) => setDiscount(e.target.value)}
                 style={{ marginTop: 0, fontFamily: 'var(--mono)', maxWidth: 160 }} />

          <div className="summary" style={{ marginTop: 14 }}>
            <div><span>Position at net asset value</span><b>{xrp(navTotal)} XRP</b></div>
            <div><span>You would ask</span><b>{xrp(ask)} XRP</b></div>
            <div><span>Cost of leaving early</span><b>{xrp(haircut)} XRP</b></div>
          </div>

          <p className="warnline">
            That {xrp(haircut)} XRP is a realised loss to your depositors. It will not show in the
            super vault&apos;s price per share today — that only moves when the curator loan is
            repaid — but it reduces what there is to repay with.
          </p>

          <button className="dark" disabled={busy || navTotal == null || bps < 0 || bps >= 10000}
                  onClick={sell}>
            Sell {Number(position.shares ?? 0).toLocaleString('en-US')} shares for {xrp(ask)} XRP
          </button>
        </>
      ) : (
        <>
          <p className="dim">
            Listed on the resale market. Until a verified investor buys it, this capital is in
            neither fund and there are no proceeds to redeploy.
          </p>

          <label className="field-label">Move the proceeds into</label>
          <select value={target} onChange={(e) => setTarget(e.target.value)} style={{ marginTop: 0 }}>
            <option value="">Choose a fund…</option>
            {destinations.map((v) => (
              <option key={v.vault_id} value={v.vault_id}>{v.name} · {v.company_name}</option>
            ))}
          </select>
          {!destinations.length && (
            <p className="warnline">
              No fund can take this capital right now. A vault only accepts deposits inside its
              subscription window, and it must redeem before your curator loan matures. Wait for a
              new fund to open, or take the listing down.
            </p>
          )}

          <div className="row">
            <button disabled={busy || !target} onClick={redeploy}>Redeploy into this fund</button>
            <button className="ghost" disabled={busy} onClick={cancel}>Take the listing down</button>
          </div>
        </>
      )}

      <Steps steps={steps} />
    </div>
  )
}
