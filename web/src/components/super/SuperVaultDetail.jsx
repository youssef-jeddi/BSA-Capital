import { useEffect, useState } from 'react'
import Steps from '../Steps.jsx'
import { getDeploymentAccount } from '../../lib/api.js'
import { draftFromVault, stageRelaunch } from '../../lib/relaunch.js'

/** Phase as a word, for use inside a sentence rather than as a corner badge. */
const PhaseInline = ({ phase, nowMs }) =>
  phase ? <>{phase.phase.toLowerCase()}{phase.endsAt ? `, ${countdown(phase.endsAt - nowMs)} left` : ''}</> : <>unreadable</>
import AllocationBreakdown from './AllocationBreakdown.jsx'
import UnwindPanel from './UnwindPanel.jsx'
import { countdown } from '../../lib/ledger.js'
import { aggregateNav, bpsToPct } from '../../lib/superVault.js'
import { useSuperVaultDeploy } from '../../hooks/useSuperVaultDeploy.js'
import { dropsToXrp } from 'xrpl'

const xrp = (drops) => (drops == null ? '—' : Number(dropsToXrp(String(Math.floor(drops)))).toFixed(6))

export default function SuperVaultDetail({ entry, nowMs, session, address, onBack, onRefresh, onRelaunch }) {
  const { own, positions } = entry
  const nav = aggregateNav(positions)
  // A sub-fund can only receive capital while it is still raising.
  const unfundable = positions.filter((p) => !p.deposited_tx && p.phase && p.phase.phase !== 'Subscription')
  const {
    steps, busy, pending, isCurator, isDeployer,
    borrow, counterSign, counterSignWithTestAccount, discard, fund, fundWithTestAccount, deployAll,
  } = useSuperVaultDeploy({ session, address, entry, onDone: onRefresh })

  const [deployer, setDeployer] = useState(null)
  useEffect(() => { getDeploymentAccount().then(setDeployer).catch(() => {}) }, [])
  const testAccountMatches = deployer?.configured && deployer.address === entry.deployment_address

  const raised = own?.vault ? Number(own.vault.AssetsTotal ?? 0) : null

  return (
    <>
      <button className="back" onClick={onBack}>Back to super vaults</button>

      <div className="pagehead">
        <div>
          <h1>{entry.name}</h1>
          <div className="sub">
            Curated by {entry.curator_name} · {entry.strategy || 'one deposit, several managers'}
            <span className={`tag st-${entry.status}`}>{entry.status}</span>
          </div>
        </div>
        <div className="figure">
          <b>{own?.pps == null ? '—' : own.pps.toFixed(6)}</b>
          <span>price per share · <PhaseInline phase={own?.phase} nowMs={nowMs} /></span>
        </div>
      </div>

      <div className="stats">
        <div><span>Raised</span><b>{raised == null ? '—' : xrp(raised)}</b>
             <small>XRP subscribed into this vault</small></div>
        <div><span>Deployed NAV</span><b>{nav.counted ? xrp(nav.total) : '—'}</b>
             <small>value of the sub-fund positions</small></div>
        <div><span>Sub-funds</span><b>{positions.length}</b>
             <small>across {new Set(positions.map((p) => p.sub_vault_name)).size} managers</small></div>
      </div>

      {nav.missing > 0 && (
        <p className="warnline">
          {nav.missing} of {positions.length} positions could not be read from the ledger, so the NAV
          above is partial.
        </p>
      )}

      {unfundable.length > 0 && (
        <p className="warnline">
          <b>{unfundable.length} allocation{unfundable.length === 1 ? '' : 's'} can no longer be funded.</b>{' '}
          {unfundable.map((p) => p.sub_vault_name).join(', ')} left the Subscription phase, and a vault
          only accepts deposits while it is raising. Deploying will originate the loan and then fail on
          those deposits. Relaunch this super vault against funds that are still open.
        </p>
      )}

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="sect">Allocation</div>
        <p className="dim">
          Price per share moves only at interest payments, so a blended figure is only as fresh
          as its least recently updated sub-fund. Per-fund ledger sequences are shown rather than
          one number implying more precision than exists.
        </p>
        <AllocationBreakdown
          positions={positions}
          renderAction={(p) => (
            entry.status === 'deployed' && !p.deposited_tx && (isDeployer || testAccountMatches)
              ? <button className="ghost sm" disabled={busy}
                        onClick={() => (isDeployer ? fund(p) : fundWithTestAccount(p))}>Fund</button>
              : null
          )}
        />
      </div>

      <div className="card">
        <div className="sect">Deployment</div>
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

        {isCurator && testAccountMatches && entry.status !== 'deployed' && (
          <>
            <button className="full"
                    disabled={busy || own?.phase?.phase !== 'Investment' || unfundable.length > 0}
                    onClick={deployAll}>
              {busy ? 'Deploying…' : 'Deploy capital into the funds'}
            </button>
            <p className="dim">
              One wallet approval: you are lending your vault's capital, so you sign that. The
              deployment account counter-signs and funds each allocation automatically.
              {own?.phase?.phase !== 'Investment' &&
                ' Available once this super vault enters its Investment phase.'}
            </p>
          </>
        )}

        {isCurator && !testAccountMatches && entry.status !== 'deployed' && (
          pending ? (
            <div className="handoff">
              <div className="handoff-head">
                <b>Step 2 of 4 — awaiting the deployment account</b>
                <small>Signed by the curator {new Date(pending.savedAt).toLocaleTimeString()}.</small>
              </div>
              <p className="dim">
                Switch the header dropdown to <code>{entry.deployment_address}</code> and come back.
              </p>
              <button className="ghost sm" disabled={busy} onClick={discard}>Discard and re-sign</button>
            </div>
          ) : (
            <button disabled={busy || own?.phase?.phase !== 'Investment'} onClick={borrow}>
              Originate the curator loan
            </button>
          )
        )}

        {!isCurator && isDeployer && pending && (
          <div className="handoff">
            <div className="handoff-head"><b>Awaiting your counter-signature</b></div>
            <button disabled={busy} onClick={counterSign}>Counter-sign &amp; submit</button>
          </div>
        )}

        {!isCurator && !isDeployer && entry.status !== 'deployed' && (
          <p className="dim">Waiting for the curator ({entry.curator_name}) to deploy.</p>
        )}

        {entry.status === 'deployed' && (
          <p className="dim">
            Loan originated{entry.loan_id && <> · <code>{entry.loan_id.slice(0, 16)}…</code></>}.
            The deployment account can now fund each allocation above.
          </p>
        )}
      </div>

      {entry.status === 'deployed' && (isCurator || isDeployer) && (
        <UnwindPanel entry={entry} nowMs={nowMs} onRefresh={onRefresh} />
      )}

      {onRelaunch && isCurator && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="sect">Next series</div>
          <p className="dim">
            Carries the strategy, deployment account and the full allocation plan into a new super
            vault. Only the dates need choosing.
          </p>
          <button className="ghost"
                  onClick={() => { stageRelaunch({ ...draftFromVault({ ...entry, kind: 'super' }) }); onRelaunch(entry) }}>
            Relaunch as next series
          </button>
        </div>
      )}

      <Steps steps={steps} />
    </>
  )
}
