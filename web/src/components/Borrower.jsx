import { useCallback, useEffect, useMemo, useState } from 'react'
import { signTransaction, signAsCounterparty } from '../wallet.js'
import Steps from './Steps.jsx'
import LenderPicker from './borrow/LenderPicker.jsx'
import { useVaults } from '../hooks/useVaults.js'
import { useClock } from '../hooks/useClock.js'
import ZoneGate from './zones/ZoneGate.jsx'
import ZoneBadges from './zones/ZoneBadges.jsx'
import { useHolderZones } from '../hooks/useZones.js'
import { zoneAccess } from '../lib/zones.js'
import {
  assetToDisplay, countdown, fetchBroker, fetchLoans, isXrpVault,
  ledgerNowMs, loanState, phaseOf, rateToPct, submitSigned,
} from '../lib/ledger.js'
import { xrpToDrops, rippleTimeToUnixTime } from 'xrpl'

/**
 * A LoanSet needs signatures from BOTH parties, but a WalletConnect session is
 * bound to one account. So the flow is a handoff: the borrower signs without
 * submitting (submit:false) and passes the signed blob to the broker, who
 * counter-signs and submits.
 */
export default function Borrower({ session, address }) {
  const [loans, setLoans] = useState([])
  const [brokerId, setBrokerId] = useState('')
  const [ctx, setCtx] = useState(null)          // { broker, vault, issuance }
  const [terms, setTerms] = useState({ principal: '20', rate: '5', interval: '120', payments: '3', grace: '60' })
  const [handoff, setHandoff] = useState('')    // blob produced by the borrower
  const [incoming, setIncoming] = useState('')  // blob pasted by the broker
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)
  const nowMs = useClock()
  const { vaults, loading: lendersLoading } = useVaults()

  // Any indexed fund with a registered loan broker can originate a loan.
  const lenders = useMemo(
    () => vaults.filter((v) => v.loan_broker_id).sort((a, b) => {
      const rank = (x) => (x.phase?.phase === 'Investment' ? 0 : 1)
      return rank(a) - rank(b)
    }),
    [vaults],
  )

  const load = useCallback(async () => { setLoans(await fetchLoans(address)) }, [address])
  useEffect(() => { load(); const t = setInterval(load, 6000); return () => clearInterval(t) }, [load])

  useEffect(() => {
    if (!/^[0-9A-Fa-f]{64}$/.test(brokerId)) { setCtx(null); return }
    fetchBroker(brokerId.toUpperCase()).then(setCtx).catch(() => setCtx(null))
  }, [brokerId])

  const set = (k) => (e) => setTerms((p) => ({ ...p, [k]: e.target.value }))

  const { zones: heldZones, issuer, refresh: refreshZones } = useHolderZones(address)
  const selectedLender = lenders.find((l) => l.loan_broker_id === brokerId)
  const access = zoneAccess(selectedLender?.zones, heldZones)

  const selfDealing = ctx && ctx.broker.Owner === address
  // rippled enforces a 60s floor on GracePeriod; xrpl.js only checks grace <= interval,
  // so an out-of-range value reaches the ledger as an opaque temINVALID.
  const termErrors = [
    Number(terms.grace) < 60 && 'Grace period must be at least 60s (ledger returns temINVALID below that).',
    Number(terms.grace) > Number(terms.interval) && 'Grace period must not exceed the payment interval.',
    Number(terms.interval) < 60 && 'Payment interval must be at least 60s.',
  ].filter(Boolean)

  function buildLoanSet() {
    return {
      TransactionType: 'LoanSet',
      Account: address,
      Counterparty: ctx.broker.Owner,
      LoanBrokerID: brokerId.toUpperCase(),
      PrincipalRequested: isXrpVault(ctx.vault) ? xrpToDrops(terms.principal) : String(terms.principal),
      InterestRate: Math.round(Number(terms.rate) * 1000),   // 100000 = 100%
      PaymentInterval: Number(terms.interval),
      PaymentTotal: Number(terms.payments),
      GracePeriod: Number(terms.grace),
    }
  }

  /** Leg 1 — borrower signs the terms but does not submit. */
  async function signRequest() {
    setBusy(true); setSteps([{ label: 'LoanSet — borrower signature', state: 'pending' }])
    try {
      const res = await signTransaction(session, buildLoanSet(), { submit: false })
      const blob = JSON.stringify(res.tx_json)
      setHandoff(blob)
      setSteps([{ label: 'Signed, not submitted', state: 'ok',
                  detail: 'Send the blob below to the broker to counter-sign.' }])
    } catch (e) {
      setSteps([{ label: 'LoanSet — borrower signature', state: 'fail', error: e.message }])
    } finally { setBusy(false) }
  }

  /**
   * Leg 2 — counterparty signs with signature_target so the wallet uses the CPT
   * hash prefix, then WE submit: with signature_target set the wallet signs only.
   */
  async function coSign() {
    setBusy(true)
    setSteps([{ label: 'LoanSet — counterparty signature', state: 'pending' }])
    try {
      const tx = JSON.parse(incoming)
      if (tx.Account === address) {
        throw new Error('This session is the originator. Switch to the counterparty account in the header.')
      }
      const res = await signAsCounterparty(session, tx)
      setSteps([{ label: 'Counterparty signature attached', state: 'ok' },
                { label: 'Submitting', state: 'pending' }])
      const result = await submitSigned(res.tx_json)
      const code = result.meta?.TransactionResult
      const loan = result.meta?.AffectedNodes?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === 'Loan')
      setSteps([
        { label: 'Counterparty signature attached', state: 'ok' },
        { label: 'LoanSet', state: code === 'tesSUCCESS' ? 'ok' : 'fail', code, hash: result.hash,
          detail: loan ? `LoanID ${loan.LedgerIndex}` : undefined },
      ])
      load()
    } catch (e) {
      const msg = e?.data?.error_exception ?? e.message
      const code = /\b(te[cflms][A-Z_]+)/.exec(msg)?.[1]
      setSteps((p) => [...p.filter((x) => x.state !== 'pending'),
                       { label: 'LoanSet', state: 'fail', code, error: msg }])
    } finally { setBusy(false) }
  }

  async function pay(loan, amount, flags) {
    setBusy(true); setSteps([{ label: 'LoanPay', state: 'pending' }])
    try {
      const res = await signTransaction(session, {
        TransactionType: 'LoanPay', Account: address, LoanID: loan.index,
        Amount: xrpToDrops(amount), ...(flags ? { Flags: flags } : {}),
      })
      const code = res?.tx_json?.meta?.TransactionResult
      setSteps([{ label: 'LoanPay', state: code === 'tesSUCCESS' ? 'ok' : 'fail', code, hash: res.hash }])
      load()
    } catch (e) {
      const code = /\b(te[cflms][A-Z_]+)/.exec(e.message)?.[1]
      setSteps([{ label: 'LoanPay', state: 'fail', code, error: e.message }])
    } finally { setBusy(false) }
  }

  const vaultPhase = ctx ? phaseOf(ctx.vault, nowMs) : null

  return (
    <div className="card">
      <h2>Borrower</h2>

      <fieldset>
        <legend>My loans</legend>
        {loans.length === 0
          ? <p className="dim">No loans against this account yet.</p>
          : loans.map((l) => <LoanRow key={l.index} loan={l} nowMs={nowMs} busy={busy} onPay={pay} />)}
      </fieldset>

      <fieldset>
        <legend>Request a loan</legend>
        <p className="dim">
          Choose the fund you want to borrow from. Only funds in their Investment phase can
          originate a loan.
        </p>
        <LenderPicker lenders={lenders} selected={brokerId} nowMs={nowMs} loading={lendersLoading}
                      onSelect={(l) => setBrokerId(l.loan_broker_id)} />

        {selectedLender?.zones?.length > 0 && (
          <p className="dim">Lender restricted to <ZoneBadges zones={selectedLender.zones} /></p>
        )}

        {access.gated && !access.allowed && (
          <ZoneGate vaultZones={selectedLender.zones} access={access} session={session}
                    address={address} issuer={issuer} onVerified={refreshZones} />
        )}

        {ctx && (
          <>
            <div className="stats">
              <div><span>Vault phase</span><b className={`p-${vaultPhase.phase.toLowerCase()}`}>{vaultPhase.phase}</b></div>
              <div><span>Available to lend</span><b>{assetToDisplay(ctx.vault, ctx.vault.AssetsAvailable)}</b></div>
              <div><span>Debt outstanding</span><b>{assetToDisplay(ctx.vault, ctx.broker.DebtTotal ?? '0')}</b></div>
              <div><span>Cover posted</span><b>{assetToDisplay(ctx.vault, ctx.broker.CoverAvailable ?? '0')}</b></div>
            </div>
            {selfDealing && (
              <p className="warnline">
                This session ({address.slice(0, 10)}…) owns the broker, so Account and Counterparty
                would be the same account. The ledger rejects that with <code>temBAD_SIGNER</code>.
                Switch the header dropdown to a different account.
              </p>
            )}
            {vaultPhase.phase !== 'Investment' && (
              <p className="warnline">
                Vault is in {vaultPhase.phase}. Loan origination is only permitted during Investment —
                the ledger will reject this.
              </p>
            )}
          </>
        )}

        <div className="grid2">
          <label>Principal<input type="number" min="0" value={terms.principal} onChange={set('principal')} /></label>
          <label>Interest rate (%)<input type="number" step="0.001" value={terms.rate} onChange={set('rate')} /></label>
          <label>Payment interval (s)<input type="number" min="1" value={terms.interval} onChange={set('interval')} /></label>
          <label>Number of payments<input type="number" min="1" value={terms.payments} onChange={set('payments')} /></label>
          <label>Grace period (s)<input type="number" min="60" value={terms.grace} onChange={set('grace')} /></label>
        </div>
        <p className="dim">
          The final payment must fall before the vault's RedemptionDate — the protocol enforces
          asset/liability matching and rejects a loan that would mature too late.
        </p>

        {termErrors.length > 0 && <ul className="errors">{termErrors.map((e) => <li key={e}>{e}</li>)}</ul>}

        <button className="primary"
                disabled={busy || !ctx || selfDealing || termErrors.length > 0 || !access.allowed}
                onClick={signRequest}>
          Sign request (no submit)
        </button>

        {handoff && (
          <div className="uri">
            <p>Signed by the borrower. Hand this to the broker to counter-sign:</p>
            <textarea readOnly value={handoff} rows={4} onFocus={(e) => e.target.select()} />
            <button className="ghost" onClick={() => navigator.clipboard.writeText(handoff)}>Copy</button>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>Counter-sign a request <span className="dim">(broker side)</span></legend>
        <textarea value={incoming} onChange={(e) => setIncoming(e.target.value)} rows={3}
                  placeholder="Paste the borrower-signed LoanSet JSON" spellCheck={false} />
        <button className="primary" disabled={busy || !incoming} onClick={coSign}>
          Counter-sign &amp; submit
        </button>
        <p className="dim">
          Signed via <code>signature_target: "Counterparty"</code>, which makes the wallet use the
          CPT hash prefix (<code>0x43505400</code>) rather than the standard STX one. The wallet signs
          but does not submit in this mode, so the app submits the completed transaction itself.
        </p>
      </fieldset>

      <Steps steps={steps} />
    </div>
  )
}

function LoanRow({ loan, nowMs, busy, onPay }) {
  const [amt, setAmt] = useState('')
  const due = rippleTimeToUnixTime(loan.NextPaymentDueDate)
  const state = loanState(loan)
  return (
    <div className="loan">
      <div className="vaulthead">
        <div>
          <b>{loan.index.slice(0, 16)}…</b>
          <span className={`tag st-${state}`}>{state}</span>
          <div className="dim">{loan.PaymentRemaining} payment(s) remaining · {rateToPct(loan.InterestRate)}%</div>
        </div>
        <div className="phase">
          <span>next payment</span>
          {due > nowMs ? countdown(due - nowMs) : 'overdue'}
        </div>
      </div>
      <div className="stats">
        <div><span>Principal outstanding</span><b>{loan.PrincipalOutstanding}</b></div>
        <div><span>Total outstanding</span><b>{loan.TotalValueOutstanding}</b></div>
        <div><span>Periodic payment</span><b>{loan.PeriodicPayment}</b></div>
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <input type="number" min="0" value={amt} onChange={(e) => setAmt(e.target.value)} placeholder="Amount in XRP" />
        <button disabled={busy || !amt} onClick={() => onPay(loan, amt)}>Pay</button>
        <button className="ghost" disabled={busy || !amt} onClick={() => onPay(loan, amt, 0x00020000)}>Pay in full</button>
      </div>
    </div>
  )
}
