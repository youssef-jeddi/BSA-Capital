import { useState } from 'react'
import BuyPanel from './BuyPanel.jsx'
import ZoneBadges from '../zones/ZoneBadges.jsx'
import Steps from '../Steps.jsx'
import { useMarket } from '../../hooks/useMarket.js'
import { cancelListing } from '../../lib/api.js'
import { dropsToXrpNum } from '../../lib/market.js'

const EXPLORER = 'https://devnet.xrpl.org'

const xrp = (n) => (n == null ? '—' : n.toLocaleString('en-US', { maximumFractionDigits: 2 }))

/** Days until a fund's redemption opens, which is when the buyer gets their money. */
function daysTo(row) {
  const ms = row.snapshot?.redemption_ms
  if (!ms) return null
  return Math.max(0, Math.round((ms - Date.now()) / 86400000))
}

/**
 * One row of the book. Buying and cancelling expand underneath rather than
 * navigating away, so the rest of the book stays on screen for comparison.
 */
function Row({ row, address, session, onChanged }) {
  const [open, setOpen] = useState(false)
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)

  const ask = dropsToXrpNum(row.ask_drops)
  const nav = dropsToXrpNum(row.nav_drops_total)
  const mine = row.seller_address === address
  const days = daysTo(row)

  async function cancel() {
    setBusy(true); setSteps([{ label: 'Custody returns the shares', state: 'pending' }])
    try {
      const out = await cancelListing(row.id, address)
      setSteps([{ label: 'Cancelled', state: 'ok', hash: out.return_hash }])
      onChanged?.()
    } catch (e) {
      setSteps([{ label: 'Cancel', state: 'fail', error: e.errors?.[0] ?? e.message }])
    } finally { setBusy(false) }
  }

  return (
    <>
      <div className={mine ? 'table-row book mine' : 'table-row book'}>
        <div>
          <div className="name">{row.vault_name ?? row.vault_id.slice(0, 12)}</div>
          <div className="who">
            {mine ? 'your listing' : `${row.seller_address.slice(0, 4)}…${row.seller_address.slice(-4)}`}
            {days != null && ` · ${days} days to redemption`}
            {row.issuer_name && ` · ${row.issuer_name}`}
          </div>
          <div style={{ marginTop: 5 }}><ZoneBadges zones={row.vault_zones} compact /></div>
        </div>
        <div className="num">{Number(row.shares).toLocaleString('en-US')}</div>
        <div className="num soft">{xrp(nav)}</div>
        <div className="num">
          {xrp(ask)}
          {row.discount_pct != null && (
            <small style={row.discount_pct >= 0 ? undefined : { color: 'var(--warn)' }}>
              {Math.abs(row.discount_pct).toFixed(2)}% {row.discount_pct >= 0 ? 'below' : 'above'}
            </small>
          )}
        </div>
        <div className="num strong">
          {nav && ask && days > 0 ? `${(((nav - ask) / ask) * (365 / days) * 100).toFixed(1)}%` : '—'}
        </div>
        <div>
          {row.status === 'open' && (mine
            ? <button className="ghost sm danger" disabled={busy} onClick={cancel}>Cancel</button>
            : <button className="sm" onClick={() => setOpen((v) => !v)}>{open ? 'Close' : 'Buy'}</button>)}
          {row.status === 'sold' && (
            row.delivery_hash
              ? <a className="mono" href={`${EXPLORER}/transactions/${row.delivery_hash}`}
                   target="_blank" rel="noreferrer">sold</a>
              : <span className="dim" style={{ margin: 0 }}>sold</span>
          )}
          {row.status === 'cancelled' && <span className="dim" style={{ margin: 0 }}>cancelled</span>}
        </div>
      </div>

      {(open || steps.length > 0) && (
        <div className="table-expand">
          {open && (
            <BuyPanel listing={row} session={session} address={address}
                      onSettled={() => { setOpen(false); onChanged?.() }}
                      onCancel={() => setOpen(false)} />
          )}
          <Steps steps={steps} />
        </div>
      )}
    </>
  )
}

/** The secondary market: positions locked in Investment, offered at a discount to NAV. */
export default function Marketplace({ session, address }) {
  const [status, setStatus] = useState('open')
  const { listings, loading, error, refresh } = useMarket({ status })

  return (
    <>
      <p className="lede">
        Positions locked in a fund's investment phase. A withdrawal there is refused
        with <code>tecTOO_SOON</code>, but the share token still transfers — so a holder who needs
        cash sells to another verified investor at a discount to net asset value.
      </p>

      <div className="chips">
        {['open', 'sold', 'cancelled'].map((s) => (
          <button key={s} type="button" className={status === s ? 'chip on' : 'chip'}
                  onClick={() => setStatus(s)}>{s}</button>
        ))}
      </div>

      {error && <p className="status err">{error}</p>}
      {loading && !listings.length && <p className="status">Loading listings…</p>}

      {!loading && !listings.length ? (
        <p className="empty">
          {status === 'open'
            ? 'Nothing for sale. A holder can list a locked position from Portfolio.'
            : `No ${status} listings.`}
        </p>
      ) : (
        <div className="table">
          <div className="table-head book">
            <span>Fund / seller</span>
            <span className="num">Shares</span>
            <span className="num">Fair value</span>
            <span className="num">Ask</span>
            <span className="num">Implied return</span>
            <span />
          </div>
          {listings.map((row) => (
            <Row key={row.id} row={row} address={address} session={session} onChanged={refresh} />
          ))}
        </div>
      )}

      <p style={{ margin: '14px 0 0', fontSize: 11.5, color: 'var(--faint)',
                  lineHeight: 1.6, maxWidth: '74ch' }}>
        Settlement runs through a custody account that only ever holds share tokens: the seller pays
        shares to custody, the buyer pays the seller directly, custody releases. Eligibility is
        re-checked on-ledger immediately before the shares move.
      </p>
    </>
  )
}
