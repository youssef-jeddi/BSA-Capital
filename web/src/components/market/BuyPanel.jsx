import { useState } from 'react'
import Steps from '../Steps.jsx'
import ZoneGate from '../zones/ZoneGate.jsx'
import { signTransaction } from '../../wallet.js'
import { settleListing } from '../../lib/api.js'
import { useEligibility } from '../../hooks/useMarket.js'
import { buyerState } from '../../lib/market.js'
import { useHolderZones } from '../../hooks/useZones.js'

/**
 * Buying, in the order the ledger forces.
 *
 * To receive private-vault shares an account needs BOTH an accepted credential in the
 * vault's domain AND its own MPTokenAuthorize opt-in. Neither implies the other:
 * opting in is permissionless, so an existing MPToken proves nothing about
 * eligibility. Both are surfaced as separate, explicit steps.
 */
export default function BuyPanel({ listing, session, address, onSettled, onCancel }) {
  const { eligibility, refresh } = useEligibility(listing.vault_id, address)
  const { issuer, refresh: refreshZones } = useHolderZones(address)
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)

  const state = buyerState(eligibility)
  const isSeller = listing.seller_address === address

  async function optIn() {
    setBusy(true); setSteps([{ label: 'Opt in to the share token', state: 'pending' }])
    try {
      const res = await signTransaction(session, {
        TransactionType: 'MPTokenAuthorize', Account: address,
        MPTokenIssuanceID: eligibility.share_mpt_id,
      })
      const code = res?.tx_json?.meta?.TransactionResult
      setSteps([{ label: 'Opted in', state: code === 'tesSUCCESS' ? 'ok' : 'fail', code, hash: res.hash }])
      refresh()
    } catch (e) {
      setSteps([{ label: 'Opt in', state: 'fail', error: e.message }])
    } finally { setBusy(false) }
  }

  async function buy() {
    setBusy(true)
    const trail = []
    const push = (s) => { trail.push(s); setSteps([...trail]) }
    const settle = (patch) => { Object.assign(trail[trail.length - 1], patch); setSteps([...trail]) }
    try {
      push({ label: 'Pay the seller', state: 'pending' })
      const res = await signTransaction(session, {
        TransactionType: 'Payment', Account: address,
        Destination: listing.seller_address, Amount: String(listing.ask_drops),
      })
      const code = res?.tx_json?.meta?.TransactionResult
      if (code !== 'tesSUCCESS') throw new Error(`Payment: ${code}`)
      settle({ state: 'ok', code, hash: res.hash })

      push({ label: 'Custody releases the shares', state: 'pending' })
      const row = await settleListing(listing.id, res.hash, address)
      settle({ state: 'ok', detail: `Delivery ${row.delivery_hash?.slice(0, 12)}…` })
      onSettled?.(row)
    } catch (e) {
      const msg = e?.errors?.[0] ?? e.message
      if (trail.length && trail[trail.length - 1].state === 'pending') settle({ state: 'fail', error: msg })
      else push({ label: 'Buy', state: 'fail', error: msg })
    } finally { setBusy(false) }
  }

  if (isSeller) {
    return <p className="dim">This is your own listing. Cancel it to get the shares back.</p>
  }

  return (
    <div className="buypanel">
      {state === 'loading' && <p className="status">Checking your eligibility…</p>}

      {state === 'needs-credential' && (
        <ZoneGate
          vaultZones={eligibility.missing_zones.length ? eligibility.missing_zones : listing.vault_zones}
          access={{ gated: true, allowed: false, missing: eligibility.missing_zones, pending: [] }}
          session={session} address={address} issuer={issuer}
          onVerified={() => { refreshZones(); refresh() }}
        />
      )}

      {state === 'needs-optin' && (
        <div className="gate">
          <h3>Opt in to receive these shares</h3>
          <p className="dim">
            You are verified for this fund. Receiving a token still needs a one-off opt-in from
            your own wallet, like a trust line: <code>MPTokenAuthorize</code> on the share token.
            Without it the transfer is refused with <code>tecNO_AUTH</code>.
          </p>
          <button className="primary" disabled={busy} onClick={optIn}>
            {busy ? 'Opting in…' : 'Opt in'}
          </button>
        </div>
      )}

      {state === 'ready' && (
        <>
          <p className="dim verified">
            Eligible: you hold an accepted credential for this fund and have opted in to its
            share token.
          </p>
          <div className="row">
            <button className="primary" disabled={busy} onClick={buy}>
              {busy ? 'Buying…' : `Pay the seller and receive ${Number(listing.shares).toLocaleString()} shares`}
            </button>
            <button className="ghost" disabled={busy} onClick={onCancel}>Back</button>
          </div>
          <p className="dim">
            You pay the seller directly; custody then releases the shares. The two legs cannot be
            atomic on this network, so your eligibility is re-checked on the server immediately
            before the shares move.
          </p>
        </>
      )}

      <Steps steps={steps} />
    </div>
  )
}
