import { useEffect, useState } from 'react'
import Steps from '../Steps.jsx'
import PhaseBadge from './PhaseBadge.jsx'
import { useVaultActions } from '../../hooks/useVaultActions.js'
import { draftFromVault, stageRelaunch } from '../../lib/relaunch.js'
import AllocationBreakdown from '../super/AllocationBreakdown.jsx'
import ZoneBadges from '../zones/ZoneBadges.jsx'
import ZoneGate from '../zones/ZoneGate.jsx'
import { useHolderZones } from '../../hooks/useZones.js'
import { zoneAccess } from '../../lib/zones.js'
import {
  PHASE_RULES, assetToDisplay, fetchPosition, isXrpVault,
} from '../../lib/ledger.js'

const EXPLORER = 'https://devnet.xrpl.org'

export default function VaultDetail({ entry, nowMs, session, address, onBack, onSettled, onRelaunch }) {
  const { vault, issuance, phase, pps } = entry
  const [position, setPosition] = useState(null)
  const [amount, setAmount] = useState('')
  const [mode, setMode] = useState('asset')
  const [force, setForce] = useState(false)

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
      <div className="card">
        <button className="ghost sm" onClick={onBack}>← All funds</button>
        <h2>{entry.name}</h2>
        <p className="status err">This vault is indexed but cannot be read on the current network.</p>
      </div>
    )
  }

  const { zones: heldZones, issuer, refresh: refreshZones } = useHolderZones(address)
  const access = zoneAccess(entry.zones, heldZones)

  const rules = PHASE_RULES[phase.phase]
  const nextName = draftFromVault(entry).name
  const unit = isXrpVault(vault) ? 'XRP' : (vault.Asset.currency ?? 'units')
  const shares = Number(position?.MPTAmount ?? 0)
  const blocked = mode === 'shares' ? !rules.withdraw : !rules.deposit

  return (
    <div className="card">
      <button className="ghost sm" onClick={onBack}>← All funds</button>

      <div className="vaulthead" style={{ marginTop: 14 }}>
        <div>
          <b style={{ fontSize: 18 }}>{entry.name}</b>
          {entry.is_private ? <span className="tag">credential-gated</span> : <span className="tag">open</span>}
          <div className="dim">{entry.company_name} · {entry.company_activity} · {entry.company_country}</div>
          <div style={{ marginTop: 6 }}><ZoneBadges zones={entry.zones} /></div>
        </div>
        <PhaseBadge phase={phase} nowMs={nowMs} />
      </div>
      <p className="dim">{rules.note}</p>

      <div className="stats">
        <div><span>Assets total</span><b>{assetToDisplay(vault, vault.AssetsTotal)} {unit}</b></div>
        <div><span>Available</span><b>{assetToDisplay(vault, vault.AssetsAvailable)} {unit}</b></div>
        <div><span>Unrealised loss</span><b>{assetToDisplay(vault, vault.LossUnrealized)} {unit}</b></div>
        <div><span>Shares outstanding</span><b>{issuance?.OutstandingAmount ?? '0'}</b></div>
        <div><span>Price per share</span><b>{pps == null ? '—' : pps.toFixed(6)}</b></div>
        <div><span>Your shares</span><b>{shares || '0'}</b></div>
        <div><span>Your value</span>
             <b>{pps == null || !shares ? '—' : `${assetToDisplay(vault, Math.floor(shares * pps))} ${unit}`}</b></div>
      </div>

      {entry.kind === 'super' && (
        <fieldset>
          <legend>Holdings</legend>
          <p className="dim">
            This is a fund-of-funds: your deposit is spread across the funds below by the curator,
            {entry.curator_name ? ` ${entry.curator_name}` : ''}. One position, several managers.
          </p>
          <AllocationBreakdown positions={entry.positions} />
        </fieldset>
      )}

      {access.gated && !access.allowed && (
        <ZoneGate vaultZones={entry.zones} access={access} session={session} address={address}
                  issuer={issuer} onVerified={refreshZones} />
      )}

      {access.gated && access.allowed && (
        <p className="dim verified">
          Verified for this fund. Your wallet holds an accepted credential for{' '}
          {entry.zones.filter((z) => heldZones.some((h) => h.zone === z && h.accepted)).join(', ')}.
        </p>
      )}

      <fieldset>
        <legend>{rules.deposit ? 'Deposit' : 'Your position'}</legend>

        <div className="chips">
          <button type="button" className={mode === 'asset' ? 'chip on' : 'chip'} onClick={() => setMode('asset')}>
            In {unit}
          </button>
          <button type="button" className={mode === 'shares' ? 'chip on' : 'chip'} onClick={() => setMode('shares')}>
            In shares
          </button>
        </div>

        <div className="row" style={{ marginTop: 12 }}>
          <input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
                 placeholder={mode === 'shares' ? 'Number of shares' : `Amount in ${unit}`} />
          {shares > 0 && mode === 'shares' &&
            <button className="ghost" onClick={() => setAmount(String(shares))}>Max</button>}
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <button className="primary"
                  disabled={busy || !amount || mode === 'shares' || (!rules.deposit && !force) || !access.allowed}
                  onClick={() => deposit(amount)}>
            Deposit
          </button>
          <button disabled={busy || !amount || (!rules.withdraw && !force)}
                  onClick={() => withdraw(amount, mode)}>
            Withdraw
          </button>
        </div>

        {!rules.deposit && (
          <p className="dim">Deposits closed: this fund left its Subscription window.</p>
        )}
        {blocked && (
          <label className="check" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
            Demo the guardrail — submit anyway and show the ledger's rejection
          </label>
        )}
      </fieldset>

      <Steps steps={steps} />

      {onRelaunch && entry.company_address === address && (
        <fieldset>
          <legend>Next series</legend>
          <p className="dim">
            A close-ended vault cannot be restarted: Redemption is terminal and the phase dates are
            immutable. Launching the next series is how a fund manager continues, and this carries
            everything across except the dates.
          </p>
          <button className="ghost" onClick={() => { stageRelaunch(draftFromVault(entry)); onRelaunch(entry) }}>
            Relaunch as {nextName}
          </button>
        </fieldset>
      )}

      <p className="dim" style={{ marginTop: 16 }}>
        <a href={`${EXPLORER}/accounts/${vault.Account}`} target="_blank" rel="noreferrer">Vault account</a>
        {entry.tx_hash && <> · <a href={`${EXPLORER}/transactions/${entry.tx_hash}`} target="_blank" rel="noreferrer">Creation transaction</a></>}
      </p>
    </div>
  )
}
