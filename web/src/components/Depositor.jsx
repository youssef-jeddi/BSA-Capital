import { useCallback, useEffect, useRef, useState } from 'react'
import { signTransaction } from '../wallet.js'
import Steps from './Steps.jsx'
import { knownVaults, rememberVault, forgetVault } from '../lib/store.js'
import {
  PHASE_RULES, assetAmount, assetToDisplay, countdown, decodeData,
  fetchPosition, fetchVault, isXrpVault, ledgerNowMs, phaseOf, pricePerShare,
} from '../lib/ledger.js'

const POLL_MS = 4000

export default function Depositor({ session, address }) {
  const [vaults, setVaults] = useState(knownVaults)
  const [selected, setSelected] = useState(() => knownVaults()[0]?.id ?? '')
  const [addId, setAddId] = useState('')

  const [state, setState] = useState(null)   // { vault, issuance, position, nowMs }
  const [error, setError] = useState('')
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)

  const [amount, setAmount] = useState('')
  const [wdMode, setWdMode] = useState('asset')  // 'asset' | 'shares'
  const [force, setForce] = useState(false)

  // Local clock keeps the countdown smooth between polls; the ledger is still the source of truth.
  const drift = useRef(0)
  const [tick, setTick] = useState(0)
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t) }, [])

  const load = useCallback(async () => {
    if (!selected) { setState(null); return }
    try {
      const [{ vault, issuance }, nowMs] = await Promise.all([fetchVault(selected), ledgerNowMs()])
      drift.current = nowMs - Date.now()
      const position = await fetchPosition(address, vault.ShareMPTID)
      setState({ vault, issuance, position })
      setError('')
    } catch (e) {
      setState(null); setError(`Could not load vault: ${e.message}`)
    }
  }, [selected, address])

  useEffect(() => { load(); const t = setInterval(load, POLL_MS); return () => clearInterval(t) }, [load])

  function addVault() {
    const id = addId.trim().toUpperCase()
    if (!/^[0-9A-F]{64}$/.test(id)) return setError('VaultID must be 64 hex characters.')
    setVaults(rememberVault({ id, label: `${id.slice(0, 8)}…` })); setSelected(id); setAddId(''); setError('')
  }

  async function send(label, tx) {
    setBusy(true); setSteps([{ label, state: 'pending' }])
    try {
      const res = await signTransaction(session, tx)
      const code = res?.tx_json?.meta?.TransactionResult
      setSteps([{ label, state: code === 'tesSUCCESS' ? 'ok' : 'fail', code, hash: res.hash }])
      load()
    } catch (e) {
      // The wallet throws on any non-tesSUCCESS; the ledger code is inside the message.
      const code = /\b(te[cflms][A-Z_]+)/.exec(e.message)?.[1]
      setSteps([{ label, state: 'fail', code, error: e.message }])
    } finally { setBusy(false) }
  }

  if (!vaults.length && !selected) {
    return (
      <div className="card">
        <h2>Depositor</h2>
        <p className="lede">No vaults known to this browser yet. Create one in the Broker tab, or paste a VaultID.</p>
        <div className="row">
          <input value={addId} onChange={(e) => setAddId(e.target.value)} placeholder="VaultID (64 hex)" spellCheck={false} />
          <button className="primary" onClick={addVault}>Add</button>
        </div>
        {error && <p className="status err">{error}</p>}
      </div>
    )
  }

  const nowMs = Date.now() + drift.current
  const v = state?.vault
  const meta = v ? decodeData(v.Data) : null
  const ph = v ? phaseOf(v, nowMs) : null
  const rules = ph ? PHASE_RULES[ph.phase] : null
  const pps = state ? pricePerShare(state.vault, state.issuance) : null
  const shares = Number(state?.position?.MPTAmount ?? 0)
  const unit = v ? (isXrpVault(v) ? 'XRP' : (v.Asset.currency ?? 'units')) : ''

  const canDeposit = rules?.deposit
  const canWithdraw = rules?.withdraw

  return (
    <div className="card">
      <h2>Depositor</h2>

      <div className="row">
        <select value={selected} onChange={(e) => setSelected(e.target.value)}>
          {vaults.map((x) => <option key={x.id} value={x.id}>{x.label ?? x.id.slice(0, 12)}</option>)}
        </select>
        <input value={addId} onChange={(e) => setAddId(e.target.value)} placeholder="Add VaultID…" spellCheck={false} />
        <button className="ghost" onClick={addVault}>Add</button>
        {selected && <button className="ghost" onClick={() => { setVaults(forgetVault(selected)); setSelected(knownVaults()[0]?.id ?? '') }}>Forget</button>}
      </div>

      {error && <p className="status err">{error}</p>}

      {state && (
        <>
          <div className="vaulthead">
            <div>
              <b>{meta?.name ?? 'Unnamed vault'}</b>
              {v.Flags & 0x00010000 ? <span className="tag">private</span> : <span className="tag">public</span>}
              <div className="dim">{selected.slice(0, 24)}…</div>
            </div>
            <div className={`phase p-${ph.phase.toLowerCase()}`}>
              {ph.phase}
              <span>{ph.endsAt ? `${countdown(ph.endsAt - nowMs)} left` : 'open'}</span>
            </div>
          </div>
          <p className="dim">{rules.note}</p>

          <div className="stats">
            <div><span>Assets total</span><b>{assetToDisplay(v, v.AssetsTotal)} {unit}</b></div>
            <div><span>Available</span><b>{assetToDisplay(v, v.AssetsAvailable)} {unit}</b></div>
            <div><span>Unrealised loss</span><b>{assetToDisplay(v, v.LossUnrealized)} {unit}</b></div>
            <div><span>Shares outstanding</span><b>{state.issuance?.OutstandingAmount ?? '0'}</b></div>
            <div><span>Price per share</span><b>{pps == null ? '—' : pps.toFixed(6)}</b></div>
            <div><span>Your shares</span><b>{shares || '0'}</b></div>
            <div><span>Your value</span><b>{pps == null || !shares ? '—' : `${assetToDisplay(v, Math.floor(shares * pps))} ${unit}`}</b></div>
          </div>

          <fieldset>
            <legend>Actions</legend>
            <div className="row">
              <input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)}
                     placeholder={wdMode === 'shares' ? 'Shares' : `Amount in ${unit}`} />
              {shares > 0 && <button className="ghost" onClick={() => { setWdMode('shares'); setAmount(String(shares)) }}>Max shares</button>}
            </div>

            <div className="chips" style={{ marginTop: 10 }}>
              <button type="button" className={wdMode === 'asset' ? 'chip on' : 'chip'} onClick={() => setWdMode('asset')}>Withdraw in {unit}</button>
              <button type="button" className={wdMode === 'shares' ? 'chip on' : 'chip'} onClick={() => setWdMode('shares')}>Redeem shares</button>
            </div>

            <div className="row" style={{ marginTop: 14 }}>
              <button className="primary" disabled={busy || !amount || (!canDeposit && !force)}
                      onClick={() => send('VaultDeposit', {
                        TransactionType: 'VaultDeposit', Account: address,
                        VaultID: selected, Amount: assetAmount(v, amount),
                      })}>
                Deposit
              </button>
              <button disabled={busy || !amount || (!canWithdraw && !force)}
                      onClick={() => send('VaultWithdraw', {
                        TransactionType: 'VaultWithdraw', Account: address, VaultID: selected,
                        Amount: wdMode === 'shares'
                          ? { mpt_issuance_id: v.ShareMPTID, value: String(amount) }
                          : assetAmount(v, amount),
                      })}>
                Withdraw
              </button>
            </div>

            {(!canDeposit || !canWithdraw) && (
              <label className="check" style={{ marginTop: 14 }}>
                <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                Demo the guardrail — submit a blocked action anyway and show the ledger's rejection
              </label>
            )}
            {force && (
              <p className="dim indent">
                In {ph.phase}: deposits {canDeposit ? 'allowed' : 'blocked'}, withdrawals {canWithdraw ? 'allowed' : 'blocked'}.
                Submitting a blocked action should fail on-ledger with a tec code.
              </p>
            )}
          </fieldset>

          <Steps steps={steps} />
        </>
      )}
    </div>
  )
}
