import { useState } from 'react'
import BuyPanel from './BuyPanel.jsx'
import ZoneBadges from '../zones/ZoneBadges.jsx'
import Steps from '../Steps.jsx'
import { useMarket } from '../../hooks/useMarket.js'
import { cancelListing } from '../../lib/api.js'
import { dropsToXrpNum } from '../../lib/market.js'

const EXPLORER = 'https://devnet.xrpl.org'

function Listing({ row, address, session, onChanged }) {
  const [open, setOpen] = useState(false)
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)

  const ask = dropsToXrpNum(row.ask_drops)
  const nav = dropsToXrpNum(row.nav_drops_total)
  const mine = row.seller_address === address
  const phase = row.snapshot?.phase

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
    <div className="listing">
      <div className="vaulthead">
        <div>
          <b>{row.vault_name ?? row.vault_id.slice(0, 12)}</b>
          {mine && <span className="tag">your listing</span>}
          <div className="dim">
            {row.issuer_name} · {Number(row.shares).toLocaleString()} shares
            {phase && ` · ${phase}`}
          </div>
          <div style={{ marginTop: 6 }}><ZoneBadges zones={row.vault_zones} /></div>
        </div>
        <div className="asking">
          <b>{ask?.toFixed(6)} XRP</b>
          {row.discount_pct != null && (
            <span className={row.discount_pct >= 0 ? 'off' : 'over'}>
              {row.discount_pct >= 0
                ? `${row.discount_pct.toFixed(2)}% below NAV`
                : `${Math.abs(row.discount_pct).toFixed(2)}% above NAV`}
            </span>
          )}
        </div>
      </div>

      <div className="stats">
        <div><span>Asking</span><b>{ask?.toFixed(6)} XRP</b></div>
        <div><span>NAV of the shares</span><b>{nav == null ? '—' : `${nav.toFixed(6)} XRP`}</b></div>
        <div><span>Seller</span><b className="mono">{row.seller_address.slice(0, 10)}…</b></div>
        <div><span>Status</span><b>{row.status}</b></div>
      </div>

      {row.status === 'open' && (
        mine
          ? <div className="row"><button className="ghost" disabled={busy} onClick={cancel}>Cancel listing</button></div>
          : open
            ? <BuyPanel listing={row} session={session} address={address}
                        onSettled={() => { setOpen(false); onChanged?.() }} onCancel={() => setOpen(false)} />
            : <button className="primary" onClick={() => setOpen(true)}>Buy this position</button>
      )}

      {row.status === 'sold' && (
        <p className="dim">
          Sold to <span className="mono">{row.buyer_address?.slice(0, 12)}…</span>
          {row.delivery_hash && <> · <a href={`${EXPLORER}/transactions/${row.delivery_hash}`} target="_blank" rel="noreferrer">delivery</a></>}
        </p>
      )}

      <Steps steps={steps} />
    </div>
  )
}

/** The secondary market: positions locked in Investment, offered at a discount to NAV. */
export default function Marketplace({ session, address }) {
  const [status, setStatus] = useState('open')
  const { listings, loading, error, refresh } = useMarket({ status })

  return (
    <div className="card">
      <h2>Marketplace</h2>
      <p className="lede">
        Fund positions for sale. During a fund's Investment phase a withdrawal is refused
        with <code>tecTOO_SOON</code>, so holders who need liquidity early sell their shares
        here instead, usually at a discount to net asset value.
      </p>

      <div className="chips">
        {['open', 'sold', 'cancelled'].map((s) => (
          <button key={s} type="button" className={status === s ? 'chip on' : 'chip'}
                  onClick={() => setStatus(s)}>{s}</button>
        ))}
      </div>

      {error && <p className="status err">{error}</p>}
      {loading && !listings.length && <p className="status">Loading listings…</p>}
      {!loading && !listings.length && (
        <p className="empty">
          {status === 'open'
            ? 'Nothing for sale. A holder can list a locked position from My positions.'
            : `No ${status} listings.`}
        </p>
      )}

      {listings.map((row) => (
        <Listing key={row.id} row={row} address={address} session={session} onChanged={refresh} />
      ))}
    </div>
  )
}
