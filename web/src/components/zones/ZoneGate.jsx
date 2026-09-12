import { useState } from 'react'
import Steps from '../Steps.jsx'
import { signTransaction } from '../../wallet.js'
import { requestZoneCredential } from '../../lib/api.js'
import { zoneLabel } from '../../lib/zones.js'

/**
 * Getting an investor through a zone restriction.
 *
 * Two on-chain steps, and the second one matters: an issuer cannot force a
 * credential onto an account, so the investor accepts it with their own wallet.
 * That signature is the investor's own attestation, not the platform's claim
 * about them.
 *
 * The KYC provider is stubbed for now: the investor states their residency and
 * the platform takes their word for it. Swapping in a real check replaces this
 * one confirmation step, not the ledger flow around it.
 */
export default function ZoneGate({ vaultZones, access, session, address, issuer, onVerified }) {
  const [zone, setZone] = useState(access.missing[0] ?? vaultZones[0])
  const [attested, setAttested] = useState(false)
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)

  const alreadyIssued = access.pending?.includes(zone)

  async function verify() {
    setBusy(true)
    const trail = []
    const push = (s) => { trail.push(s); setSteps([...trail]) }
    const settle = (patch) => { Object.assign(trail[trail.length - 1], patch); setSteps([...trail]) }

    try {
      let credentialType
      if (alreadyIssued) {
        credentialType = null // we will look it up from the issuer below
      } else {
        push({ label: `Platform issues a ${zone} credential`, state: 'pending' })
        const out = await requestZoneCredential(address, zone)
        if (out.result_code !== 'tesSUCCESS') throw new Error(`Issuance: ${out.result_code}`)
        credentialType = out.credential_type
        settle({ state: 'ok', code: out.result_code, hash: out.hash })
      }

      push({ label: 'You accept it with your wallet', state: 'pending' })
      const res = await signTransaction(session, {
        TransactionType: 'CredentialAccept',
        Account: address,
        Issuer: issuer,
        CredentialType: credentialType ?? toHexType(zone),
      })
      const code = res?.tx_json?.meta?.TransactionResult
      if (code !== 'tesSUCCESS') throw new Error(`Accept: ${code}`)
      settle({ state: 'ok', code, hash: res.hash })

      push({ label: `You are now verified for ${zone}`, state: 'info' })
      onVerified?.()
    } catch (e) {
      const msg = e?.errors?.[0] ?? e.message
      if (trail.length && trail[trail.length - 1].state === 'pending') settle({ state: 'fail', error: msg })
      else push({ label: 'Verification', state: 'fail', error: msg })
    } finally { setBusy(false) }
  }

  return (
    <div className="gate">
      <h3>Verification required</h3>
      <p className="dim">
        This fund only accepts investors from <b>{vaultZones.map(zoneLabel).join(' or ')}</b>. Your
        wallet does not hold a credential for {access.missing.length === 1 ? 'that zone' : 'any of those zones'} yet,
        so the ledger would reject a deposit with <code>tecNO_AUTH</code>.
      </p>

      <label className="field">
        <span className="field-label">Where are you resident?</span>
        <select value={zone} onChange={(e) => { setZone(e.target.value); setAttested(false) }}>
          {vaultZones.map((z) => (
            <option key={z} value={z}>{zoneLabel(z)}{access.pending?.includes(z) ? ' — credential already issued' : ''}</option>
          ))}
        </select>
      </label>

      <label className="check">
        <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} />
        I confirm I am resident in {zoneLabel(zone)} and eligible to invest in this fund.
      </label>

      <button className="primary" disabled={busy || !attested} onClick={verify}>
        {busy ? 'Verifying…'
          : alreadyIssued ? `Accept the ${zone} credential`
          : `Get verified for ${zone}`}
      </button>

      <p className="dim">
        Identity checking is stubbed for this build: the platform issues on your say-so. You still
        accept the credential from your own wallet, so nothing is attached to your account without
        your signature.
      </p>

      <Steps steps={steps} />
    </div>
  )
}

/** Fallback when the credential was issued in an earlier session. */
const toHexType = (zone) =>
  Array.from(new TextEncoder().encode(`ZONE_${zone}`))
    .map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()
