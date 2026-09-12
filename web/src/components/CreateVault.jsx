import { useMemo, useState } from 'react'
import { signTransaction } from '../wallet.js'
import Steps from './Steps.jsx'
import { rememberVault } from '../lib/store.js'
import {
  ASSET_CLASSES, ASSET_SUBCLASSES, MIN_INVESTMENT_SECONDS, buildVaultCreate,
  buildLoanBrokerSet, buildCoverDeposit, createdEntry, lifecycleDates,
  metadataWarnings, validateForm,
} from '../lib/vault.js'

const EXPLORER = 'https://devnet.xrpl.org'

const INITIAL = {
  assetType: 'XRP', iouCurrency: '', iouIssuer: '', mptIssuanceId: '',
  subMinutes: '6', redMinutes: '20',
  vaultName: '', website: '',
  capEnabled: false, cap: '', private: false, domainId: '', nonTransferable: false,
  ticker: '', shareName: '', issuerName: '', assetClass: 'rwa', assetSubclass: 'private_credit',
  desc: '', icon: 'https://bsa.capital/icon.png',
  mgmtFee: '', maxDebt: '', coverRateMin: '', coverRateLiq: '', firstLoss: '',
}

const time = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

export default function CreateVault({ session, address }) {
  const [f, setF] = useState(INITIAL)
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)

  const set = (k) => (e) =>
    setF((p) => ({ ...p, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))

  const errors = useMemo(() => validateForm(f), [f])
  const warnings = useMemo(() => metadataWarnings(f), [f])
  const dates = useMemo(() => lifecycleDates(f), [f])

  const push = (s) => setSteps((p) => [...p, s])
  const patch = (i, s) => setSteps((p) => p.map((x, j) => (j === i ? { ...x, ...s } : x)))

  /** Each transaction is a separate wallet approval — the extension has no batching. */
  async function run(label, tx) {
    const i = steps.length
    push({ label, state: 'pending', tx })
    const res = await signTransaction(session, tx)
    const code = res?.tx_json?.meta?.TransactionResult
    if (code !== 'tesSUCCESS') throw new Error(`${label}: ${code ?? 'no result'}`)
    patch(i, { state: 'ok', hash: res.hash, code })
    return res.tx_json
  }

  async function submit() {
    setBusy(true); setSteps([])
    try {
      const vaultRes = await run('VaultCreate', buildVaultCreate(f, address))
      const vault = createdEntry(vaultRes, 'Vault')
      if (!vault) throw new Error('VaultCreate succeeded but no Vault node found in metadata')
      rememberVault({ id: vault.id, label: f.vaultName || `${vault.id.slice(0, 8)}…` })
      push({ label: 'Vault created', state: 'info',
             detail: `VaultID ${vault.id}\nShare MPT ${vault.fields?.ShareMPTID ?? '—'}\nSaved — now selectable in the Depositor tab.` })

      const brokerRes = await run('LoanBrokerSet', buildLoanBrokerSet(f, address, vault.id))
      const broker = createdEntry(brokerRes, 'LoanBroker')

      if (f.firstLoss && Number(f.firstLoss) > 0 && broker) {
        await run('LoanBrokerCoverDeposit', buildCoverDeposit(f, address, broker.id))
      }
      push({ label: 'Done', state: 'info', detail: 'Vault live and broker registered.' })
    } catch (e) {
      setSteps((p) => {
        const i = p.findIndex((s) => s.state === 'pending')
        const next = [...p]
        if (i >= 0) next[i] = { ...next[i], state: 'fail', error: e.message }
        else next.push({ label: 'Failed', state: 'fail', error: e.message })
        return next
      })
    } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <h2>Create a vault</h2>
      <p className="lede">
        Configure and deploy a vault, then register a loan broker against it. Signed by the connected
        broker wallet — one approval per transaction.
      </p>

      <fieldset>
        <legend>Asset</legend>
        <div className="chips">
          {['XRP', 'IOU', 'MPT'].map((t) => (
            <button key={t} type="button" className={f.assetType === t ? 'chip on' : 'chip'}
                    onClick={() => setF((p) => ({ ...p, assetType: t }))}>{t}</button>
          ))}
        </div>
        {f.assetType === 'IOU' && (
          <div className="grid2">
            <label>Currency code<input value={f.iouCurrency} onChange={set('iouCurrency')} placeholder="USD" /></label>
            <label>Issuer<input value={f.iouIssuer} onChange={set('iouIssuer')} placeholder="r…" spellCheck={false} /></label>
          </div>
        )}
        {f.assetType === 'MPT' && (
          <label>MPT issuance ID<input value={f.mptIssuanceId} onChange={set('mptIssuanceId')} spellCheck={false} /></label>
        )}
      </fieldset>

      <fieldset>
        <legend>Lifecycle <span className="dim">· close-ended</span></legend>
        <p className="dim">
          Three phases, fixed at creation and immutable. Subscription: deposits and withdrawals,
          lending blocked. Investment: loans only, capital locked. Redemption: withdrawals and
          loan servicing, no new loans.
        </p>
        <div className="grid2">
          <label>Subscription ends in (min)<input type="number" min="1" value={f.subMinutes} onChange={set('subMinutes')} /></label>
          <label>Redemption opens in (min)<input type="number" min="4" value={f.redMinutes} onChange={set('redMinutes')} /></label>
        </div>
        {dates && (
          <div className="timeline">
            <span><b>Subscription</b> now &rarr; {time(dates.subscriptionUnix)}</span>
            <span><b>Investment</b> {time(dates.subscriptionUnix)} &rarr; {time(dates.redemptionUnix)}</span>
            <span><b>Redemption</b> from {time(dates.redemptionUnix)}</span>
            <span className="dim">
              Ripple time {dates.SubscriptionDate} / {dates.RedemptionDate} &middot; investment period{' '}
              {(Number(f.redMinutes) - Number(f.subMinutes)) * 60}s (min {MIN_INVESTMENT_SECONDS}s)
            </span>
          </div>
        )}
      </fieldset>

      <fieldset>
        <legend>Vault identity</legend>
        <div className="grid2">
          <label>Name<input value={f.vaultName} onChange={set('vaultName')} placeholder="e.g. BSA Credit Fund I" /></label>
          <label>Website<input value={f.website} onChange={set('website')} placeholder="e.g. example.com" /></label>
        </div>
        <p className="dim">Stored on-ledger in the vault's Data field (max 256 bytes).</p>
      </fieldset>

      <fieldset>
        <legend>Settings</legend>
        <label className="check"><input type="checkbox" checked={f.capEnabled} onChange={set('capEnabled')} /> Set a maximum deposit cap</label>
        {f.capEnabled && <label>Cap<input type="number" min="0" value={f.cap} onChange={set('cap')} /></label>}

        <label className="check"><input type="checkbox" checked={f.private} onChange={set('private')} /> Private vault (credential-gated)</label>
        <p className="dim indent">Only holders of an accepted credential in the domain may deposit or receive shares. Enforced by the ledger.</p>
        {f.private && <label>DomainID<input value={f.domainId} onChange={set('domainId')} placeholder="64 hex characters" spellCheck={false} /></label>}

        <label className="check"><input type="checkbox" checked={f.nonTransferable} onChange={set('nonTransferable')} /> Non-transferable shares</label>
        <p className="dim indent">Shares could only be redeemed, never sold — this disables the secondary market.</p>
      </fieldset>

      <fieldset>
        <legend>Share token metadata <span className="dim">(XLS-89)</span></legend>
        <div className="grid2">
          <label>Ticker *<input value={f.ticker} onChange={(e) => setF((p) => ({ ...p, ticker: e.target.value.toUpperCase() }))} placeholder="BSAF1" maxLength={6} /></label>
          <label>Name *<input value={f.shareName} onChange={set('shareName')} placeholder="BSA Fund I Shares" /></label>
          <label>Issuer name *<input value={f.issuerName} onChange={set('issuerName')} placeholder="BSA Capital" /></label>
          <label>Asset class *
            <select value={f.assetClass} onChange={set('assetClass')}>
              {ASSET_CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        </div>
        {f.assetClass === 'rwa' && (
          <label>Asset subclass * <span className="dim">(required when class is rwa)</span>
            <select value={f.assetSubclass} onChange={set('assetSubclass')}>
              {ASSET_SUBCLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </label>
        )}
        <label>Description<input value={f.desc} onChange={set('desc')} placeholder="Proportional ownership of the fund" /></label>
        <label>Icon URL *<input value={f.icon} onChange={set('icon')} placeholder="https://example.com/icon.png" /></label>
      </fieldset>

      <fieldset>
        <legend>Broker configuration <span className="dim">(optional)</span></legend>
        <div className="grid2">
          <label>Management fee (%)<input type="number" step="0.01" min="0" max="100" value={f.mgmtFee} onChange={set('mgmtFee')} placeholder="1.0" /></label>
          <label>Max debt<input type="number" min="0" value={f.maxDebt} onChange={set('maxDebt')} placeholder="Unlimited" /></label>
          <label>Min cover rate (%)<input type="number" step="0.001" min="0" max="100" value={f.coverRateMin} onChange={set('coverRateMin')} placeholder="10.0" /></label>
          <label>Liquidation rate (%)<input type="number" step="0.001" min="0" max="100" value={f.coverRateLiq} onChange={set('coverRateLiq')} placeholder="100.0" /></label>
        </div>
        <label>First-loss capital<input type="number" min="0" value={f.firstLoss} onChange={set('firstLoss')} placeholder="Amount deposited as cover" /></label>
        <p className="dim">Deposited from the broker wallet after registration. Absorbs losses before depositors.</p>
      </fieldset>

      <div className="summary">
        <div><span>Asset</span><b>{f.assetType}</b></div>
        <div><span>Type</span><b>Close-ended (VaultKind 1)</b></div>
        <div><span>Access</span><b>{f.private ? 'Private (domain-gated)' : 'Public'}</b></div>
        <div><span>Deposit cap</span><b>{f.capEnabled && f.cap ? f.cap : 'Unlimited'}</b></div>
        <div><span>Shares</span><b>{f.nonTransferable ? 'Non-transferable' : 'Transferable'}</b></div>
        <div><span>Transactions</span><b>{2 + (f.firstLoss && Number(f.firstLoss) > 0 ? 1 : 0)}</b></div>
      </div>

      {errors.length > 0 && (
        <ul className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
      )}
      {errors.length === 0 && warnings.length > 0 && (
        <ul className="warnings">
          <li className="head">XLS-89 metadata warnings — will still submit, but explorers may not index the share token:</li>
          {warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}

      <button className="primary full" disabled={busy || errors.length > 0} onClick={submit}>
        {busy ? 'Awaiting wallet…' : 'Create vault & register broker'}
      </button>

      <Steps steps={steps} />

    </div>
  )
}
