import { useEffect, useState } from 'react'
import Steps from '../Steps.jsx'
import PhaseBadge from './PhaseBadge.jsx'
import { useVaultActions } from '../../hooks/useVaultActions.js'
import {
  PHASE_RULES, assetToDisplay, fetchPosition, isXrpVault,
} from '../../lib/ledger.js'

const EXPLORER = 'https://devnet.xrpl.org'

export default function VaultDetail({ entry, nowMs, session, address, onBack, onSettled }) {
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

  const rules = PHASE_RULES[phase.phase]
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
          <button className="primary" disabled={busy || !amount || mode === 'shares' || (!rules.deposit && !force)}
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

      <p className="dim" style={{ marginTop: 16 }}>
        <a href={`${EXPLORER}/accounts/${vault.Account}`} target="_blank" rel="noreferrer">Vault account</a>
        {entry.tx_hash && <> · <a href={`${EXPLORER}/transactions/${entry.tx_hash}`} target="_blank" rel="noreferrer">Creation transaction</a></>}
      </p>
    </div>
  )
}
