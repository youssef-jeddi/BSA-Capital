import { useMemo, useState } from 'react'
import { unixTimeToRippleTime, xrpToDrops, encodeMPTokenMetadata } from 'xrpl'
import { signTransaction } from '../../wallet.js'
import Steps from '../Steps.jsx'
import AllocationPlanner from './AllocationPlanner.jsx'
import { Field, TextInput, ErrorList } from '../ui/Field.jsx'
import { createSuperVault } from '../../lib/api.js'
import { createdEntry } from '../../lib/vault.js'
import { weightErrors } from '../../lib/superVault.js'

const hex = (s) => Array.from(new TextEncoder().encode(s))
  .map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()

export default function CreateSuperVault({ session, address, company, candidates, nowMs, onCreated, onCancel }) {
  const [f, setF] = useState({
    name: '', strategy: '', deployment: '',
    subMinutes: '5', redMinutes: '40', loanMinutes: '30', cap: '5000',
  })
  const [allocations, setAllocations] = useState([])
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)
  const [serverErrors, setServerErrors] = useState([])

  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v }))

  const dates = useMemo(() => {
    const t0 = Date.now()
    return {
      subscription: unixTimeToRippleTime(t0 + Number(f.subMinutes) * 60_000),
      redemption: unixTimeToRippleTime(t0 + Number(f.redMinutes) * 60_000),
      loanMaturity: unixTimeToRippleTime(t0 + Number(f.loanMinutes) * 60_000),
      at: (m) => new Date(t0 + m * 60_000).toLocaleTimeString(),
    }
  }, [f.subMinutes, f.redMinutes, f.loanMinutes])

  const localErrors = useMemo(() => [
    ...(f.name.trim() ? [] : ['Name is required.']),
    ...(f.deployment.trim() ? [] : ['A deployment account is required.']),
    ...(f.deployment.trim() === address ? ['The deployment account must differ from this curator account.'] : []),
    ...(Number(f.loanMinutes) >= Number(f.redMinutes)
      ? ['The curator loan must mature before the super vault redeems.'] : []),
    ...(Number(f.redMinutes) - Number(f.subMinutes) < 3
      ? ['Investment period must be at least 3 minutes.'] : []),
    ...weightErrors(allocations),
  ], [f, allocations, address])

  async function run(label, tx) {
    setSteps((p) => [...p, { label, state: 'pending' }])
    const res = await signTransaction(session, tx)
    const code = res?.tx_json?.meta?.TransactionResult
    if (code !== 'tesSUCCESS') throw new Error(`${label}: ${code}`)
    setSteps((p) => p.map((s, i) => (i === p.length - 1 ? { ...s, state: 'ok', code, hash: res.hash } : s)))
    return res.tx_json
  }

  async function submit() {
    setBusy(true); setSteps([]); setServerErrors([])
    try {
      const vaultRes = await run('VaultCreate (super vault)', {
        TransactionType: 'VaultCreate', Account: address,
        Asset: { currency: 'XRP' }, VaultKind: 1, WithdrawalPolicy: 1,
        SubscriptionDate: dates.subscription, RedemptionDate: dates.redemption,
        AssetsMaximum: xrpToDrops(f.cap),
        MPTokenMetadata: encodeMPTokenMetadata({
          ticker: 'SUPER', name: `${f.name} Shares`, issuer_name: company?.name ?? 'Curator',
          asset_class: 'rwa', asset_subclass: 'private_credit',
          desc: f.strategy || 'Curated fund-of-funds', icon: 'https://bsa.capital/icon.png',
        }),
        Data: hex(JSON.stringify({ name: f.name, kind: 'super' })),
      })
      const vault = createdEntry(vaultRes, 'Vault')

      const brokerRes = await run('LoanBrokerSet', {
        TransactionType: 'LoanBrokerSet', Account: address,
        VaultID: vault.id, ManagementFeeRate: 100, DebtMaximum: xrpToDrops(f.cap),
      })
      const broker = createdEntry(brokerRes, 'LoanBroker')

      const saved = await createSuperVault({
        vault_id: vault.id,
        curator_address: address,
        deployment_address: f.deployment.trim(),
        loan_broker_id: broker?.id,
        name: f.name,
        strategy: f.strategy,
        subscription_date: dates.subscription,
        redemption_date: dates.redemption,
        loan_maturity: dates.loanMaturity,
        allocations,
      })
      setSteps((p) => [...p, { label: 'Allocation plan saved', state: 'info',
                               detail: `${allocations.length} sub-funds · cascade validated` }])
      onCreated?.(saved)
    } catch (e) {
      setServerErrors(e.errors ?? [e.message])
      setSteps((p) => p.map((s) => (s.state === 'pending' ? { ...s, state: 'fail', error: e.message } : s)))
    } finally { setBusy(false) }
  }

  return (
    <div className="card">
      <button className="ghost sm" onClick={onCancel}>← Super vaults</button>
      <h2 style={{ marginTop: 14 }}>Launch a super vault</h2>
      <p className="lede">
        A curated fund-of-funds. Depositors hold one position; you allocate the raise
        across the funds below.
      </p>

      <fieldset>
        <legend>Identity</legend>
        <Field label="Name" required>
          <TextInput value={f.name} onChange={set('name')} placeholder="BSA Diversified Credit" />
        </Field>
        <Field label="Strategy" hint="Shown to depositors browsing the fund.">
          <TextInput value={f.strategy} onChange={set('strategy')}
                     placeholder="Diversified private credit across five managers" />
        </Field>
        <Field label="Deployment account" required
               hint="The account that borrows the raise and holds the sub-fund positions. Must differ from this curator account: a LoanSet with Account equal to Counterparty is rejected.">
          <TextInput value={f.deployment} onChange={set('deployment')} placeholder="r…" spellCheck={false} />
        </Field>
      </fieldset>

      <fieldset>
        <legend>Lifecycle</legend>
        <div className="grid2">
          <Field label="Subscription ends in (min)"><TextInput type="number" min="1" value={f.subMinutes} onChange={set('subMinutes')} /></Field>
          <Field label="Redemption opens in (min)"><TextInput type="number" min="4" value={f.redMinutes} onChange={set('redMinutes')} /></Field>
          <Field label="Curator loan matures in (min)" hint="Must be before redemption."><TextInput type="number" min="3" value={f.loanMinutes} onChange={set('loanMinutes')} /></Field>
          <Field label="Target raise (XRP)"><TextInput type="number" min="1" value={f.cap} onChange={set('cap')} /></Field>
        </div>
        <div className="timeline">
          <span><b>Subscription</b> now → {dates.at(Number(f.subMinutes))}</span>
          <span><b>Deploy window</b> {dates.at(Number(f.subMinutes))} → {dates.at(Number(f.loanMinutes))}</span>
          <span><b>Loan matures</b> {dates.at(Number(f.loanMinutes))}</span>
          <span><b>Redemption</b> from {dates.at(Number(f.redMinutes))}</span>
        </div>
      </fieldset>

      <fieldset>
        <legend>Allocation</legend>
        <p className="dim">
          Funds redeeming after the curator loan matures are disabled: their capital would
          still be locked when the super vault owes its depositors.
        </p>
        <AllocationPlanner candidates={candidates} allocations={allocations}
                           onChange={setAllocations} ceiling={dates.loanMaturity} nowMs={nowMs} />
      </fieldset>

      <ErrorList errors={[...localErrors, ...serverErrors]} />

      <button className="primary full" disabled={busy || localErrors.length > 0} onClick={submit}>
        {busy ? 'Awaiting wallet…' : 'Create super vault'}
      </button>

      <Steps steps={steps} />
    </div>
  )
}
