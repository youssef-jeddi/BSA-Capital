import { useEffect, useState } from 'react'
import { rippleTimeToUnixTime } from 'xrpl'
import Steps from '../Steps.jsx'
import LifecycleRail from '../ui/LifecycleRail.jsx'
import { useVaultActions } from '../../hooks/useVaultActions.js'
import { draftFromVault, stageRelaunch } from '../../lib/relaunch.js'
import AllocationBreakdown from '../super/AllocationBreakdown.jsx'
import ZoneBadges from '../zones/ZoneBadges.jsx'
import ZoneGate from '../zones/ZoneGate.jsx'
import { useHolderZones } from '../../hooks/useZones.js'
import { zoneAccess } from '../../lib/zones.js'
import {
  PHASE_RULES, assetToDisplay, countdown, fetchPosition, isXrpVault,
} from '../../lib/ledger.js'

const EXPLORER = 'https://devnet.xrpl.org'
const LONG = { day: 'numeric', month: 'short', year: 'numeric' }
const SHORT = { day: 'numeric', month: 'short' }
const fmt = (ms, o = SHORT) => new Date(ms).toLocaleDateString('en-GB', o)

/** What each phase means, in the design's three-column key under the rail. */
const PHASE_COPY = {
  Subscription: 'Deposits accepted and shares minted. Lending is blocked.',
  Investment: 'Capital is lent to vetted borrowers. Repayments lift price per share; withdrawals return tecTOO_SOON.',
  Redemption: 'Loans wind down and investors withdraw principal plus interest earned.',
}

export default function VaultDetail({ entry, nowMs, session, address, onBack, onSettled, onRelaunch }) {
  const { vault, issuance, phase, pps } = entry
  const [position, setPosition] = useState(null)
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('asset')
  const [force, setForce] = useState(false)

  // Every hook runs before the unreadable-vault branch below: React requires the
  // same hooks in the same order on every render.
  const { zones: heldZones, issuer, refresh: refreshZones } = useHolderZones(address)
  const { steps, busy, deposit, withdraw } = useVaultActions({
    session, address, vault, vaultId: entry.vault_id,
    onSettled: () => { onSettled?.(); loadPosition() },
  })

  async function loadPosition() {
    setPosition(vault ? await fetchPosition(address, vault.ShareMPTID) : null)
  }
  useEffect(() => { loadPosition() }, [address, entry.vault_id])

  if (!vault) {
    return (
      <>
        <button className="back" onClick={onBack}>Back to marketplace</button>
        <div className="card">
          <h3>{entry.name}</h3>
          <p className="status err">This vault is indexed but cannot be read on the current network.</p>
        </div>
      </>
    )
  }

  const access = zoneAccess(entry.zones, heldZones)
  const rules = PHASE_RULES[phase.phase]
  const nextName = draftFromVault(entry).name
  const unit = isXrpVault(vault) ? 'XRP' : (vault.Asset.currency ?? 'units')
  const shares = Number(position?.MPTAmount ?? 0)
  const blocked = mode === 'shares' ? !rules.withdraw : !rules.deposit

  const sub = rippleTimeToUnixTime(vault.SubscriptionDate)
  const red = rippleTimeToUnixTime(vault.RedemptionDate)
  const start = entry.created_at ? Date.parse(entry.created_at) : null
  const yourValue = pps == null || !shares ? null : assetToDisplay(vault, Math.floor(shares * pps))

  return (
    <>
      <button className="back" onClick={onBack}>Back to marketplace</button>

      <div className="pagehead">
        <div>
          <h1>{entry.name}</h1>
          <div className="sub">
            {entry.company_name} · {entry.company_activity}, {entry.company_country}
            {entry.is_private
              ? <> · credential-gated to {entry.zones.join(' and ')} investors</>
              : <> · open to every investor</>}
          </div>
          <div style={{ marginTop: 8 }}><ZoneBadges zones={entry.zones} /></div>
        </div>
        <div className="figure">
          <b>{pps == null ? '—' : pps.toFixed(6)}</b>
          <span>price per share · {phase.phase.toLowerCase()}</span>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 16 }}>
        <div className="sect-row">
          <div className="sect">Fund lifecycle</div>
          <div className="when">
            {phase.endsAt
              ? `${phase.phase === 'Subscription' ? 'subscription closes' : 'redemption opens'} in ${countdown(phase.endsAt - nowMs)}`
              : 'redemption is open'}
          </div>
        </div>

        <LifecycleRail big start={start} sub={sub} red={red} nowMs={nowMs}
                       caption={phase.phase === 'Investment'
                         ? 'INVESTMENT — CAPITAL LENT OUT, WITHDRAWALS REFUSED'
                         : phase.phase.toUpperCase()} />

        <div className="phasekeys">
          <div className="phasekey k-sub">
            <b>Subscription · until {fmt(sub)}</b>
            <span>{PHASE_COPY.Subscription}</span>
          </div>
          <div className="phasekey k-inv">
            <b>Investment · {fmt(sub)} – {fmt(red)}</b>
            <span>{PHASE_COPY.Investment}</span>
          </div>
          <div className="phasekey k-red">
            <b>Redemption · from {fmt(red, LONG)}</b>
            <span>{PHASE_COPY.Redemption}</span>
          </div>
        </div>
      </div>

      <div className="detailgrid">
        <div>
          <div className="card" style={{ padding: 0 }}>
            <div className="stats" style={{ margin: 0, border: 0, borderRadius: 0,
                                            borderBottom: '1px solid var(--line-soft)' }}>
              <div>
                <span>Assets total</span>
                <b>{assetToDisplay(vault, vault.AssetsTotal)}</b>
                <small>{unit}, of which {assetToDisplay(vault, vault.AssetsAvailable)} uncommitted</small>
              </div>
              <div>
                <span>Shares outstanding</span>
                <b>{Number(issuance?.OutstandingAmount ?? 0).toLocaleString('en-US')}</b>
                <small>price steps up on each repayment</small>
              </div>
              <div>
                <span>Unrealised loss</span>
                <b className={Number(vault.LossUnrealized ?? 0) > 0 ? 'overdue' : undefined}>
                  {assetToDisplay(vault, vault.LossUnrealized)}
                </b>
                <small>absorbed by cover first</small>
              </div>
            </div>

            <div style={{ padding: 18 }}>
              <div className="sect">{rules.deposit ? 'Where this fund stands' : 'Why you cannot withdraw'}</div>
              <p style={{ margin: 0, fontSize: 13, lineHeight: 1.65, color: 'var(--body)', maxWidth: '66ch' }}>
                {rules.note}
              </p>
            </div>

            {entry.kind === 'super' && (
              <div style={{ padding: '0 18px 18px' }}>
                <div className="sect">Allocation</div>
                <p className="dim">
                  A fund-of-funds: your deposit is spread across the funds below by the curator
                  {entry.curator_name ? ` ${entry.curator_name}` : ''}. One position, several managers.
                </p>
                <AllocationBreakdown positions={entry.positions} />
              </div>
            )}

            <div style={{ padding: '0 18px 18px' }}>
              <div style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14, display: 'flex',
                            flexWrap: 'wrap', gap: 18, fontFamily: 'var(--mono)', fontSize: 11.5 }}>
                <a href={`${EXPLORER}/accounts/${vault.Account}`} target="_blank" rel="noreferrer">
                  vault account {vault.Account.slice(0, 5)}…{vault.Account.slice(-4)}
                </a>
                {entry.tx_hash && (
                  <a href={`${EXPLORER}/transactions/${entry.tx_hash}`} target="_blank" rel="noreferrer">
                    VaultCreate {entry.tx_hash.slice(0, 8)}…
                  </a>
                )}
                {entry.domain_id && <span>domain {entry.zones.join('+')} {entry.domain_id.slice(0, 6)}…</span>}
              </div>
            </div>
          </div>

          {onRelaunch && entry.company_address === address && (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="sect">Next series</div>
              <p className="dim">
                A close-ended vault cannot be restarted: Redemption is terminal and the phase dates are
                immutable. Launching the next series is how a fund manager continues, and this carries
                everything across except the dates.
              </p>
              <button className="ghost" onClick={() => { stageRelaunch(draftFromVault(entry)); onRelaunch(entry) }}>
                Relaunch as {nextName}
              </button>
            </div>
          )}
        </div>

        <div className="card">
          <div className="sect">{rules.deposit ? 'Subscribe' : 'Your position'}</div>

          {access.gated && !access.allowed ? (
            <ZoneGate vaultZones={entry.zones} access={access} session={session} address={address}
                      issuer={issuer} onVerified={refreshZones} />
          ) : (
            <>
              <div className="chips">
                <button type="button" className={mode === 'asset' ? 'chip on' : 'chip'}
                        onClick={() => setMode('asset')}>In {unit}</button>
                <button type="button" className={mode === 'shares' ? 'chip on' : 'chip'}
                        onClick={() => setMode('shares')}>In shares</button>
              </div>

              <label className="field-label">
                {mode === 'shares' ? 'Number of shares' : `Amount in ${unit}`}
              </label>
              <input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
                     style={{ marginTop: 0, fontFamily: 'var(--mono)', fontSize: 16 }}
                     placeholder={mode === 'shares' ? '0' : '0'} />

              <div className="summary" style={{ marginTop: 12 }}>
                <div><span>Your shares</span><b>{shares.toLocaleString('en-US')}</b></div>
                <div><span>Your value</span><b>{yourValue == null ? '—' : `${yourValue} ${unit}`}</b></div>
                <div><span>Capital locked until</span><b>{fmt(red, LONG)}</b></div>
              </div>

              <div className="row">
                <button disabled={busy || !amount || mode === 'shares' || (!rules.deposit && !force) || !access.allowed}
                        onClick={() => deposit(amount)}>Deposit</button>
                <button className="ghost" disabled={busy || !amount || (!rules.withdraw && !force)}
                        onClick={() => withdraw(amount, mode)}>Withdraw</button>
              </div>

              {!rules.deposit && (
                <p className="dim" style={{ marginTop: 10 }}>
                  Deposits closed: this fund left its Subscription window.
                </p>
              )}
              {blocked && (
                <label className="check" style={{ marginTop: 10 }}>
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  Demo the guardrail — submit anyway and show the ledger's rejection
                </label>
              )}

              {access.gated && access.allowed && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--line-soft)',
                              display: 'flex', gap: 9, alignItems: 'flex-start' }}>
                  <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)',
                                 marginTop: 5, flex: 'none' }} />
                  <div style={{ fontSize: 11.5, color: 'var(--dim)', lineHeight: 1.55 }}>
                    Your wallet holds an accepted{' '}
                    <b style={{ color: 'var(--fg)', fontWeight: 600 }}>
                      {entry.zones.filter((z) => heldZones.some((h) => h.zone === z && h.accepted)).join(', ')}
                    </b>{' '}
                    credential, so the vault's permissioned domain will admit this deposit. Without it
                    the ledger refuses with <code>tecNO_AUTH</code>.
                  </div>
                </div>
              )}
            </>
          )}

          <Steps steps={steps} />
        </div>
      </div>
    </>
  )
}
