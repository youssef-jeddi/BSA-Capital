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
import { clearPendingLoan, pendingFor, savePendingLoan } from '../lib/pendingLoans.js'

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
  // Loans this account is being asked to counter-sign. Held in the browser rather
  // than pasted between tabs, and surviving the remount an account switch causes.
  const [awaiting, setAwaiting] = useState(() => pendingFor(address))
  const refreshAwaiting = () => setAwaiting(pendingFor(address))
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)
  const nowMs = useClock()
  const { vaults, loading: lendersLoading } = useVaults()

  /**
   * Every indexed fund, ranked by whether it can actually lend right now.
   *
   * Funds with no registered loan broker used to be dropped silently, so the list
   * looked short with no way to tell whether it was filtered or simply empty.
   * They are shown last and disabled, with the reason on the row.
   */
  const lenders = useMemo(
    () => [...vaults].sort((a, b) => {
      const rank = (x) => (!x.loan_broker_id ? 2 : x.phase?.phase === 'Investment' ? 0 : 1)
      return rank(a) - rank(b) || (a.name ?? '').localeCompare(b.name ?? '')
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
      savePendingLoan(`loan:${brokerId}:${Date.now()}`, res.tx_json)
      refreshAwaiting()
      setSteps([{ label: 'Signed, waiting for the lender', state: 'ok',
                  detail: `Held for ${ctx.broker.Owner}. Switch to that account and it appears below.` }])
    } catch (e) {
      setSteps([{ label: 'LoanSet — borrower signature', state: 'fail', error: e.message }])
    } finally { setBusy(false) }
  }

  /**
   * Leg 2 — counterparty signs with signature_target so the wallet uses the CPT
   * hash prefix, then WE submit: with signature_target set the wallet signs only.
   */
  async function coSign(held) {
    setBusy(true)
    setSteps([{ label: 'LoanSet — counterparty signature', state: 'pending' }])
    try {
      const tx = held.txJson
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

  const drawn = loans.reduce((t, l) => t + Number(l.PrincipalOutstanding ?? 0), 0)

  return (
    <>
      <p className="lede">
        Your credit facility. Draws are uncollateralised two-party loans under a fund's broker, and
        no draw may mature after the fund's own redemption date.
      </p>

      {loans.length > 0 && (
        <div className="stats">
          <div><span>Open draws</span><b>{loans.length}</b>
               <small>against this account</small></div>
          <div><span>Principal outstanding</span><b>{(drawn / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 })}</b>
               <small>XRP still owed</small></div>
          <div><span>Impaired</span>
               <b className={loans.some((l) => loanState(l) !== 'current') ? 'overdue' : undefined}>
                 {loans.filter((l) => loanState(l) !== 'current').length}
               </b>
               <small>loans past their grace period</small></div>
        </div>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="sect">Your loans</div>
        {loans.length === 0
          ? <p className="dim">No loans against this account yet.</p>
          : loans.map((l) => <LoanRow key={l.index} loan={l} nowMs={nowMs} busy={busy} onPay={pay} />)}
      </div>

      <div className="card">
        <div className="sect">Request a draw</div>
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

        {termErrors.length > 0 && <ul className="warnings">{termErrors.map((e) => <li key={e}>{e}</li>)}</ul>}

        {access.gated && !access.allowed && (
          <p className="warnline">
            This fund is restricted to <ZoneBadges zones={selectedLender.zones} /> and your wallet
            holds no accepted credential for it, so the ledger will refuse the loan
            with <code>tecNO_AUTH</code>.
          </p>
        )}

        {/* Only a missing broker disables this: without one there is no
            Counterparty to address, so there is no transaction to reject.
            Everything else is the ledger's call and is left to the ledger. */}
        <button disabled={busy || !ctx} onClick={signRequest}>
          Sign request (no submit)
        </button>
      </div>

      {awaiting.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="sect">Waiting for your signature</div>
          <p className="dim">
            A borrower has signed these terms and needs you, as the lender, to counter-sign. Nothing
            reaches the ledger until you do.
          </p>
          {awaiting.map((held) => (
            <div key={held.key} className="handoff">
              <div className="handoff-head">
                <b>{Number(held.txJson.PrincipalRequested) / 1e6} XRP requested</b>
                <small>
                  from {held.txJson.Account?.slice(0, 12)}… · signed {new Date(held.savedAt).toLocaleTimeString()}
                </small>
              </div>
              <div className="row">
                <button disabled={busy} onClick={() => coSign(held)}>
                  Counter-sign &amp; submit
                </button>
                <button className="ghost" disabled={busy}
                        onClick={() => { clearPendingLoan(held.key); refreshAwaiting() }}>
                  Decline
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Steps steps={steps} />
    </>
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
