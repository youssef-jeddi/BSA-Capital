import Steps from '../Steps.jsx'
import PhaseBadge from '../vaults/PhaseBadge.jsx'
import { assetToDisplay, countdown } from '../../lib/ledger.js'
import { aggregateNav, bpsToPct } from '../../lib/superVault.js'
import { useSuperVaultDeploy } from '../../hooks/useSuperVaultDeploy.js'
import { dropsToXrp } from 'xrpl'

const xrp = (drops) => (drops == null ? '—' : Number(dropsToXrp(String(Math.floor(drops)))).toFixed(6))

export default function SuperVaultDetail({ entry, nowMs, session, address, onBack, onRefresh }) {
  const { own, positions } = entry
  const nav = aggregateNav(positions)
  const { steps, busy, pending, isCurator, isDeployer, borrow, counterSign, discard, fund } =
    useSuperVaultDeploy({ session, address, entry, onDone: onRefresh })

  const raised = own?.vault ? Number(own.vault.AssetsTotal ?? 0) : null

  return (
    <div className="card">
      <button className="ghost sm" onClick={onBack}>← Super vaults</button>

      <div className="vaulthead" style={{ marginTop: 14 }}>
        <div>
          <b style={{ fontSize: 18 }}>{entry.name}</b>
          <span className={`tag st-${entry.status}`}>{entry.status}</span>
          <div className="dim">{entry.curator_name} · {entry.strategy || 'Curated fund-of-funds'}</div>
        </div>
        <PhaseBadge phase={own?.phase} nowMs={nowMs} />
      </div>

      <div className="stats">
        <div><span>Raised</span><b>{raised == null ? '—' : `${xrp(raised)} XRP`}</b></div>
        <div><span>Deployed NAV</span><b>{nav.counted ? `${xrp(nav.total)} XRP` : '—'}</b></div>
        <div><span>Sub-funds</span><b>{positions.length}</b></div>
        <div><span>Price per share</span><b>{own?.pps == null ? '—' : own.pps.toFixed(6)}</b></div>
      </div>

      {nav.missing > 0 && (
        <p className="warnline">
          {nav.missing} of {positions.length} positions could not be valued, so the NAV above is partial.
        </p>
      )}

      <fieldset>
        <legend>Allocation</legend>
        <p className="dim">
          Price per share moves only at interest payments, so a blended figure is only as fresh
          as its least recently updated sub-fund. Per-fund ledger sequences are shown rather than
          one number implying more precision than exists.
        </p>
        <div className="alloctable">
          {positions.map((p) => (
            <div key={p.sub_vault_id} className="allocrow static">
              <div>
                <b>{p.sub_vault_name ?? p.sub_vault_id.slice(0, 10)}</b>
                <small>
                  {p.sub_company_name ?? 'unknown issuer'}
                  {p.phase && ` · ${p.phase.phase}`}
                  {p.lastLedger && ` · ledger ${p.lastLedger}`}
                </small>
              </div>
              <div className="allocnums">
                <span className="target">{bpsToPct(p.target_bps)}%</span>
                <span>{p.shares ? `${p.shares} shares` : 'not funded'}</span>
                <span>{p.value == null ? '—' : `${xrp(p.value)} XRP`}</span>
                {isDeployer && entry.status === 'deployed' && !p.deposited_tx && (
                  <button className="ghost sm" disabled={busy} onClick={() => fund(p)}>Fund</button>
                )}
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend>Deployment</legend>
        <ol className="deploysteps">
          <li className={own?.phase?.phase === 'Subscription' ? 'now' : 'done'}>
            <b>Raise</b> — depositors subscribe while the super vault is open
            {own?.phase?.endsAt && own.phase.phase === 'Subscription' &&
              <small> · closes in {countdown(own.phase.endsAt - nowMs)}</small>}
          </li>
          <li className={entry.status === 'deployed' ? 'done' : pending ? 'now'
                        : own?.phase?.phase === 'Investment' ? 'now' : ''}>
            <b>Borrow</b> — the super vault lends the raise to the deployment account
            <small> · two signatures: curator first, then the deployment account</small>
          </li>
          <li className={positions.length && positions.every((p) => p.deposited_tx) ? 'done' : ''}>
            <b>Allocate</b> — the deployment account deposits into each sub-fund
          </li>
          <li><b>Unwind</b> — sub-funds redeem, the loan is repaid, price per share steps up</li>
        </ol>

        {entry.status !== 'deployed' && (
          pending ? (
            <div className="handoff">
              <div className="handoff-head">
                <b>Step 2 of 4 — awaiting the deployment account</b>
                <small>Signed by the curator {new Date(pending.savedAt).toLocaleTimeString()}. Held in this browser.</small>
              </div>
              {isDeployer ? (
                <>
                  <p className="dim">
                    You are the deployment account. Counter-signing completes the loan and submits it.
                  </p>
                  <div className="row">
                    <button className="primary" disabled={busy} onClick={counterSign}>
                      Counter-sign &amp; submit
                    </button>
                    <button className="ghost" disabled={busy} onClick={discard}>Discard</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="dim">
                    Switch the header dropdown to <code>{entry.deployment_address}</code>, come back
                    here, and the counter-sign button appears. Nothing to copy.
                  </p>
                  <button className="ghost sm" disabled={busy} onClick={discard}>Discard and re-sign</button>
                </>
              )}
            </div>
          ) : isCurator ? (
            <>
              <button className="primary" disabled={busy || own?.phase?.phase !== 'Investment'} onClick={borrow}>
                Originate the curator loan
              </button>
              {own?.phase?.phase !== 'Investment' && (
                <p className="dim">Available once the super vault enters its Investment phase.</p>
              )}
            </>
          ) : (
            <p className="dim">
              Waiting for the curator ({entry.curator_name}) to originate the loan.
            </p>
          )
        )}

        {entry.status === 'deployed' && (
          <p className="dim">
            Loan originated{entry.loan_id && <> · <code>{entry.loan_id.slice(0, 16)}…</code></>}.
            The deployment account can now fund each allocation above.
          </p>
        )}
      </fieldset>

      <Steps steps={steps} />
    </div>
  )
}
