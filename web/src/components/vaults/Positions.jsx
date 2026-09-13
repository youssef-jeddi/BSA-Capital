import { useState } from 'react'
import { dropsToXrp, rippleTimeToUnixTime } from 'xrpl'
import Steps from '../Steps.jsx'
import PhaseBadge from './PhaseBadge.jsx'
import LifecycleRail from '../ui/LifecycleRail.jsx'
import { usePositions } from '../../hooks/usePositions.js'
import { useClock } from '../../hooks/useClock.js'
import { useVaultActions } from '../../hooks/useVaultActions.js'
import SellPanel from '../market/SellPanel.jsx'

const xrp = (drops) => (drops == null ? '—' : Number(dropsToXrp(String(Math.floor(drops)))).toFixed(6))

function Position({ p, nowMs, session, address, onSettled }) {
  const [open, setOpen] = useState(false)
  const [selling, setSelling] = useState(false)
  const { steps, busy, withdraw } = useVaultActions({
    session, address, vault: p.vault, vaultId: p.vault_id, onSettled,
  })

  return (
    <div className={p.kind === 'super' ? 'position is-super' : 'position'}>
      <div className="vaulthead">
        <div>
          <b>{p.name}</b>
          {p.kind === 'super' && <span className="tag super">Super vault</span>}
          <div className="dim">{p.issuer}</div>
        </div>
        <PhaseBadge phase={p.phase} nowMs={nowMs} />
      </div>

      {p.vault && (
        <div style={{ margin: '14px 0 4px' }}>
          <LifecycleRail sub={rippleTimeToUnixTime(p.vault.SubscriptionDate)}
                         red={rippleTimeToUnixTime(p.vault.RedemptionDate)} nowMs={nowMs} />
        </div>
      )}

      <div className="stats">
        <div><span>Shares</span><b>{p.shares.toLocaleString()}</b></div>
        <div><span>Price per share</span><b>{p.pps == null ? '—' : p.pps.toFixed(6)}</b></div>
        <div><span>Value</span><b>{xrp(p.value)} {p.unit}</b></div>
      </div>

      {selling && (
        <SellPanel position={p} session={session} address={address}
                   onListed={() => { setSelling(false); onSettled?.() }}
                   onCancel={() => setSelling(false)} />
      )}

      {p.canWithdraw ? (
        open ? (
          <div className="row" style={{ marginTop: 12 }}>
            <button disabled={busy}
                    onClick={() => withdraw(String(p.shares), 'shares')}>
              Withdraw all {p.shares.toLocaleString()} shares
            </button>
            <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        ) : (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="ghost" onClick={() => setOpen(true)}>Withdraw</button>
            {!selling && <button className="ghost" onClick={() => setSelling(true)}>Sell instead</button>}
          </div>
        )
      ) : (
        !selling && (
          <>
            <p className="dim" style={{ marginTop: 10 }}>
              Locked during the Investment phase: a withdrawal is refused with
              <code> tecTOO_SOON</code>. The shares still transfer, so selling is your only
              way out before Redemption.
            </p>
            <button onClick={() => setSelling(true)}>Sell this position</button>
          </>
        )
      )}

      <Steps steps={steps} />
    </div>
  )
}

/** Where this wallet's money actually is, and how to get it out. */
export default function Positions({ session, address }) {
  const { positions, loading, error, refresh } = usePositions(address)
  const nowMs = useClock()

  const total = positions.reduce((s, p) => s + (p.value ?? 0), 0)
  const locked = positions.filter((p) => !p.canWithdraw).length

  const managers = new Set(positions.map((p) => p.issuer).filter(Boolean)).size

  return (
    <>
      <p className="lede">Every fund where this wallet holds shares, valued from the ledger.</p>

      {positions.length > 0 && (
        <div className="stats">
          <div>
            <span>Total value</span><b>{xrp(total)}</b>
            <small>XRP at today's net asset value</small>
          </div>
          <div>
            <span>Positions</span><b>{positions.length}</b>
            <small>across {managers || 1} manager{managers === 1 ? '' : 's'}</small>
          </div>
          <div>
            <span>Locked</span><b>{locked}</b>
            <small>{locked ? 'resale is the only exit' : 'nothing is locked'}</small>
          </div>
          <div>
            <span>Withdrawable now</span><b>{positions.length - locked}</b>
            <small>redeemable from the vault directly</small>
          </div>
        </div>
      )}

      {error && <p className="status err">{error}</p>}
      {loading && !positions.length && <p className="status">Checking your holdings…</p>}
      {!loading && !positions.length && (
        <p className="empty">
          You hold no vault shares yet. Browse <b>Marketplace</b> and deposit into a fund that is
          still in its subscription window.
        </p>
      )}

      {positions.map((p) => (
        <Position key={p.vault_id} p={p} nowMs={nowMs} session={session}
                  address={address} onSettled={refresh} />
      ))}
    </>
  )
}
