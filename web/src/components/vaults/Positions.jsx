import { useState } from 'react'
import { dropsToXrp } from 'xrpl'
import Steps from '../Steps.jsx'
import PhaseBadge from './PhaseBadge.jsx'
import { usePositions } from '../../hooks/usePositions.js'
import { useClock } from '../../hooks/useClock.js'
import { useVaultActions } from '../../hooks/useVaultActions.js'

const xrp = (drops) => (drops == null ? '—' : Number(dropsToXrp(String(Math.floor(drops)))).toFixed(6))

function Position({ p, nowMs, session, address, onSettled }) {
  const [open, setOpen] = useState(false)
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

      <div className="stats">
        <div><span>Shares</span><b>{p.shares.toLocaleString()}</b></div>
        <div><span>Price per share</span><b>{p.pps == null ? '—' : p.pps.toFixed(6)}</b></div>
        <div><span>Value</span><b>{xrp(p.value)} {p.unit}</b></div>
      </div>

      {p.canWithdraw ? (
        open ? (
          <div className="row" style={{ marginTop: 12 }}>
            <button className="primary" disabled={busy}
                    onClick={() => withdraw(String(p.shares), 'shares')}>
              Withdraw all {p.shares.toLocaleString()} shares
            </button>
            <button className="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          </div>
        ) : (
          <button className="ghost" style={{ marginTop: 12 }} onClick={() => setOpen(true)}>Withdraw</button>
        )
      ) : (
        <p className="dim" style={{ marginTop: 10 }}>
          Locked during the Investment phase. Withdrawals reopen at Redemption
          {p.phase?.endsAt ? ', when this fund stops lending.' : '.'}
        </p>
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

  return (
    <div className="card">
      <h2>My positions</h2>
      <p className="lede">Every fund where this wallet holds shares, valued from the ledger.</p>

      {positions.length > 0 && (
        <div className="stats">
          <div><span>Positions</span><b>{positions.length}</b></div>
          <div><span>Total value</span><b>{xrp(total)} XRP</b></div>
          <div><span>Withdrawable now</span><b>{positions.length - locked}</b></div>
          <div><span>Locked</span><b>{locked}</b></div>
        </div>
      )}

      {error && <p className="status err">{error}</p>}
      {loading && !positions.length && <p className="status">Checking your holdings…</p>}
      {!loading && !positions.length && (
        <p className="empty">
          You hold no vault shares yet. Browse <b>Invest</b> and deposit into a fund that is
          still in its Subscription phase.
        </p>
      )}

      {positions.map((p) => (
        <Position key={p.vault_id} p={p} nowMs={nowMs} session={session}
                  address={address} onSettled={refresh} />
      ))}
    </div>
  )
}
