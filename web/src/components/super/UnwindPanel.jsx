import { useCallback, useEffect, useState } from 'react'
import { dropsToXrp, rippleTimeToUnixTime } from 'xrpl'
import Steps from '../Steps.jsx'
import { getUnwindState, repayCuratorLoan, withdrawFromSubFund } from '../../lib/api.js'
import { countdown } from '../../lib/ledger.js'

const xrp = (drops) => (drops == null ? '—' : Number(dropsToXrp(String(Math.ceil(Number(drops))))).toFixed(6))

/**
 * Closing the loop.
 *
 * Sub-funds redeem, the deployment account gets its capital back, and it
 * repays the curator loan. Only then does the super vault hold assets again
 * and its price per share step up, which is what depositors withdraw against.
 *
 * A loan past its maturity can never be repaid, so the deadline is shown
 * prominently rather than buried.
 */
export default function UnwindPanel({ entry, nowMs, onRefresh }) {
  const [state, setState] = useState(null)
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    getUnwindState(entry.vault_id).then(setState).catch(() => setState(null))
  }, [entry.vault_id])

  useEffect(() => { load(); const t = setInterval(load, 8000); return () => clearInterval(t) }, [load])

  if (!state?.configured) return null

  const loan = state.loan
  const dueMs = loan?.next_due ? rippleTimeToUnixTime(loan.next_due) : null
  const overdue = dueMs != null && dueMs < nowMs
  const stillHeld = state.positions.filter((p) => Number(p.shares) > 0)
  const nameOf = (id) => entry.positions.find((p) => p.sub_vault_id === id)?.sub_vault_name ?? id.slice(0, 10)

  async function run(label, fn) {
    setBusy(true); setSteps([{ label, state: 'pending' }])
    try {
      const out = await fn()
      const ok = out.result_code === 'tesSUCCESS'
      setSteps([{ label, state: ok ? 'ok' : 'fail', code: out.result_code, hash: out.hash }])
      load(); onRefresh?.()
    } catch (e) {
      setSteps([{ label, state: 'fail', error: e.errors?.[0] ?? e.message }])
    } finally { setBusy(false) }
  }

  const redeemAll = () => run('Redeem sub-fund positions', async () => {
    let last = { result_code: 'tesSUCCESS' }
    for (const p of stillHeld) {
      last = await withdrawFromSubFund(entry.vault_id, p.vault_id, p.shares)
      if (last.result_code !== 'tesSUCCESS') break
    }
    return last
  })

  const repay = () => run('Repay the curator loan',
    () => repayCuratorLoan(entry.vault_id, String(Math.ceil(Number(loan.outstanding)))))

  return (
    <fieldset>
      <legend>Unwind</legend>

      <div className="stats">
        <div><span>Deployment account</span><b>{state.balance} XRP</b></div>
        <div><span>Still in sub-funds</span><b>{stillHeld.length} of {state.positions.length}</b></div>
        <div><span>Loan outstanding</span><b>{loan ? `${xrp(loan.outstanding)} XRP` : 'repaid'}</b></div>
        <div><span>Next payment</span>
             <b className={overdue ? 'overdue' : ''}>
               {loan ? (overdue ? 'overdue' : countdown(dueMs - nowMs)) : '—'}
             </b></div>
      </div>

      {overdue && (
        <p className="warnline">
          <b>This loan is past its payment date.</b> Once a loan passes maturity plus its grace
          period the ledger refuses every repayment with <code>tecEXPIRED</code>, the capital stays
          with the deployment account and depositors cannot be paid. Repay now if the grace period
          has not elapsed.
        </p>
      )}

      <ol className="deploysteps">
        <li className={stillHeld.length ? 'now' : 'done'}>
          <b>Redeem sub-fund positions</b> — only possible once each sub-fund reaches its Redemption phase
        </li>
        <li className={!loan ? 'done' : stillHeld.length ? '' : 'now'}>
          <b>Repay the curator loan</b> — principal plus interest returns to the super vault
        </li>
        <li><b>Depositors withdraw</b> — at the super vault's own Redemption, against a higher price per share</li>
      </ol>

      <div className="row">
        <button className="ghost" disabled={busy || !stillHeld.length} onClick={redeemAll}>
          Redeem {stillHeld.length || ''} sub-fund position{stillHeld.length === 1 ? '' : 's'}
        </button>
        <button className="primary" disabled={busy || !loan} onClick={repay}>
          {loan ? `Repay ${xrp(loan.outstanding)} XRP` : 'Loan repaid'}
        </button>
      </div>

      {stillHeld.length > 0 && (
        <p className="dim">
          Holding: {stillHeld.map((p) => nameOf(p.vault_id)).join(', ')}. A sub-fund only allows
          withdrawals in its Subscription or Redemption phase.
        </p>
      )}

      <Steps steps={steps} />
    </fieldset>
  )
}
