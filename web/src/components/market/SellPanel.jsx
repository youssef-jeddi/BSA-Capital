import { useEffect, useMemo, useState } from 'react'
import Steps from '../Steps.jsx'
import { signTransaction } from '../../wallet.js'
import { createListing, getMarketVault, prepareListing } from '../../lib/api.js'
import { dropsToXrpNum, navValueDrops, xrpToDropsStr } from '../../lib/market.js'

/**
 * Selling a locked position.
 *
 * The seller pays the shares to custody first, then the listing is recorded against
 * that transaction hash — which the server re-reads on the ledger before believing it.
 * Custody holds only shares; the buyer will pay the seller directly.
 */
export default function SellPanel({ position, session, address, onListed, onCancel }) {
  const canWithdraw = position.canWithdraw
  const [snap, setSnap] = useState(null)
  const [shares, setShares] = useState(String(position.shares))
  const [askXrp, setAskXrp] = useState('')
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)

  useEffect(() => { getMarketVault(position.vault_id).then(setSnap).catch(() => setSnap(null)) },
    [position.vault_id])

  const navTotal = useMemo(
    () => (snap ? navValueDrops(shares || 0, snap.nav_drops) : null), [snap, shares])
  const navXrp = dropsToXrpNum(navTotal)
  const discount = navXrp && Number(askXrp) ? (1 - Number(askXrp) / navXrp) * 100 : null

  const errors = [
    !/^\d+$/.test(shares) || BigInt(shares || 0) <= 0n ? 'Enter a whole number of shares.' : null,
    BigInt(shares || 0) > BigInt(position.shares) ? `You only hold ${position.shares} shares.` : null,
    !Number(askXrp) ? 'Enter an asking price.' : null,
    snap && !snap.transferable ? 'This vault issued non-transferable shares; they can only be redeemed.' : null,
  ].filter(Boolean)

  async function list() {
    setBusy(true)
    const trail = []
    const push = (s) => { trail.push(s); setSteps([...trail]) }
    const settle = (patch) => { Object.assign(trail[trail.length - 1], patch); setSteps([...trail]) }

    try {
      push({ label: 'Custody opts in to the share token', state: 'pending' })
      const prep = await prepareListing(position.vault_id)
      settle({ state: 'ok', detail: prep.already ? 'Already opted in' : `MPTokenAuthorize ${prep.hash?.slice(0, 12)}…` })

      push({ label: `Send ${shares} shares to custody`, state: 'pending' })
      const res = await signTransaction(session, {
        TransactionType: 'Payment', Account: address, Destination: prep.custody,
        Amount: { mpt_issuance_id: prep.share_mpt_id, value: String(shares) },
      })
      const code = res?.tx_json?.meta?.TransactionResult
      if (code !== 'tesSUCCESS') throw new Error(`Share transfer: ${code}`)
      settle({ state: 'ok', code, hash: res.hash })

      push({ label: 'Record the listing', state: 'pending' })
      const row = await createListing({
        vault_id: position.vault_id, shares: String(shares),
        ask_drops: xrpToDropsStr(askXrp), transfer_hash: res.hash,
      }, address)
      settle({ state: 'ok', detail: `Listing ${row.id}` })
      onListed?.(row)
    } catch (e) {
      const msg = e?.errors?.[0] ?? e.message
      if (trail.length && trail[trail.length - 1].state === 'pending') settle({ state: 'fail', error: msg })
      else push({ label: 'Listing', state: 'fail', error: msg })
    } finally { setBusy(false) }
  }

  return (
    <div className="sellpanel">
      <h3>Sell this position</h3>
      {canWithdraw ? (
        <p className="warnline">
          This fund is in its <b>{position.phase?.phase}</b> phase, so you can withdraw at full
          NAV right now. Selling below NAV would leave money on the table. Shares transfer in
          every phase, so this is allowed, but withdrawing is usually the better deal.
        </p>
      ) : (
        <p className="dim">
          This fund is in its Investment phase, so a withdrawal is refused with
          <code> tecTOO_SOON</code>. The shares still transfer, so selling is your only way out
          before Redemption.
        </p>
      )}

      <div className="grid2">
        <label className="field">
          <span className="field-label">Shares to sell</span>
          <input value={shares} onChange={(e) => setShares(e.target.value.replace(/\D/g, ''))} />
          <small className="field-hint">You hold {Number(position.shares).toLocaleString()}</small>
        </label>
        <label className="field">
          <span className="field-label">Asking price (XRP)</span>
          <input type="number" min="0" step="0.000001" value={askXrp} onChange={(e) => setAskXrp(e.target.value)} />
          <small className="field-hint">
            {navXrp == null ? 'NAV unavailable' : `Worth ${navXrp.toFixed(6)} XRP at current NAV`}
          </small>
        </label>
      </div>

      {discount != null && (
        <p className={discount >= 0 ? 'dim' : 'warnline'}>
          {discount >= 0
            ? `A ${discount.toFixed(2)}% discount to NAV — the price of liquidity before Redemption.`
            : `That is ${Math.abs(discount).toFixed(2)}% ABOVE NAV. A buyer could redeem for less at Redemption.`}
        </p>
      )}

      {errors.length > 0 && <ul className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>}

      <div className="row">
        <button disabled={busy || errors.length > 0} onClick={list}>
          {busy ? 'Listing…' : 'List for sale'}
        </button>
        <button className="ghost" disabled={busy} onClick={onCancel}>Cancel</button>
      </div>

      <Steps steps={steps} />
    </div>
  )
}
