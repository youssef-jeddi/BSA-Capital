import { useEffect, useMemo, useState } from 'react'
import { xrpToDrops, encodeMPTokenMetadata } from 'xrpl'
import { signTransaction } from '../../wallet.js'
import Steps from '../Steps.jsx'
import AllocationPlanner from './AllocationPlanner.jsx'
import { Field, TextInput, ErrorList } from '../ui/Field.jsx'
import DateTimeField from '../ui/DateTimeField.jsx'
import { describeGap, fromInputValue, inMinutes, toRipple } from '../../lib/schedule.js'
import { createSuperVault, getDeploymentAccount } from '../../lib/api.js'
import { takeRelaunch } from '../../lib/relaunch.js'
import { createdEntry } from '../../lib/vault.js'
import { weightErrors } from '../../lib/superVault.js'

const hex = (s) => Array.from(new TextEncoder().encode(s))
  .map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase()

export default function CreateSuperVault({ session, address, company, candidates, nowMs, onCreated, onCancel }) {
  const [f, setF] = useState({
    name: '', strategy: '', deployment: '',
    subscriptionAt: inMinutes(5), loanMaturityAt: inMinutes(40), redemptionAt: inMinutes(55),
    cap: '5000', rate: '5',
  })
  const [draft] = useState(() => takeRelaunch('super'))
  const [allocations, setAllocations] = useState(() => draft?.allocations ?? [])
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)
  const [serverErrors, setServerErrors] = useState([])

  // Prefill from a relaunch draft, if the curator rolled a finished series forward.
  useEffect(() => {
    if (!draft) return
    setF((p) => ({
      ...p,
      name: draft.name,
      strategy: draft.strategy || draft.desc || '',
      deployment: draft.deployment || p.deployment,
      cap: draft.cap || p.cap,
    }))
  }, [draft])

  // Default to the stored Devnet test account so the demo needs no wallet switch.
  useEffect(() => {
    getDeploymentAccount()
      .then((d) => d.configured && setF((p) => (p.deployment ? p : { ...p, deployment: d.address })))
      .catch(() => {})
  }, [])

  const set = (k) => (v) => setF((p) => ({ ...p, [k]: v?.target ? v.target.value : v }))

  const dates = useMemo(() => ({
    subscription: toRipple(f.subscriptionAt),
    redemption: toRipple(f.redemptionAt),
    loanMaturity: toRipple(f.loanMaturityAt),
    subscriptionMs: fromInputValue(f.subscriptionAt),
    redemptionMs: fromInputValue(f.redemptionAt),
    loanMaturityMs: fromInputValue(f.loanMaturityAt),
  }), [f.subscriptionAt, f.redemptionAt, f.loanMaturityAt])
  const at = (ms) => (ms == null ? '—' : new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }))

  const localErrors = useMemo(() => [
    ...(f.name.trim() ? [] : ['Name is required.']),
    ...(f.deployment.trim() ? [] : ['A deployment account is required.']),
    ...(f.deployment.trim() === address ? ['The deployment account must differ from this curator account.'] : []),
    ...(dates.loanMaturityMs == null || dates.redemptionMs == null || dates.subscriptionMs == null
      ? ['Choose all three phase dates.'] : []),
    ...(dates.loanMaturityMs >= dates.redemptionMs
      ? ['The curator loan must mature before the super vault redeems.'] : []),
    ...((dates.redemptionMs - dates.subscriptionMs) / 1000 < 180
      ? ['Investment period must be at least 3 minutes.'] : []),
    ...(Number(f.rate) < 0 || Number(f.rate) > 10
      ? ['Rate must be between 0 and 100% — the ledger caps InterestRate at 100000, and a rate unit is 1/10th bps.'] : []),
    ...weightErrors(allocations),
  ], [f, allocations, address, dates])

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
        interest_rate: Math.round(Number(f.rate) * 1000),
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
      <button className="back" onClick={onCancel}>Back to super vaults</button>
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
          <DateTimeField label="Subscription closes" required
                         value={f.subscriptionAt} onChange={set('subscriptionAt')} />
          <DateTimeField label="Curator loan matures" required hint="Must be before redemption."
                         value={f.loanMaturityAt} onChange={set('loanMaturityAt')} />
          <DateTimeField label="Redemption opens" required
                         value={f.redemptionAt} onChange={set('redemptionAt')} />
          <Field label="Target raise (XRP)">
            <TextInput type="number" min="1" value={f.cap} onChange={set('cap')} />
          </Field>
          <Field label="Rate paid to depositors (%)"
                 hint="What the fund pays for the capital. You keep whatever the sub-funds earn above it, and cover any shortfall.">
            <TextInput type="number" min="0" max="10" step="0.001" value={f.rate} onChange={set('rate')} />
          </Field>
        </div>
        <div className="timeline">
          <span><b>Subscription</b> now &rarr; {at(dates.subscriptionMs)}</span>
          <span><b>Deploy window</b> {at(dates.subscriptionMs)} &rarr; {at(dates.loanMaturityMs)}</span>
          <span><b>Loan matures</b> {at(dates.loanMaturityMs)}</span>
          <span><b>Redemption</b> from {at(dates.redemptionMs)}</span>
          <span className="dim">
            Investment period {describeGap(f.subscriptionAt, f.redemptionAt)?.text ?? '—'}
          </span>
        </div>
      </fieldset>

      <fieldset>
        <legend>Allocation</legend>
        <p className="dim">
          Two rules disable a fund here. It must still be raising when you deploy, which happens
          after this super vault stops raising. And it must redeem before the curator loan matures,
          or its capital is still locked when the super vault owes its depositors.
        </p>
        <AllocationPlanner candidates={candidates} allocations={allocations}
                           onChange={setAllocations} ceiling={dates.loanMaturity}
                           superSubscription={dates.subscription} nowMs={nowMs} />
      </fieldset>

      <ErrorList errors={[...localErrors, ...serverErrors]} />

      <button className="full" disabled={busy || localErrors.length > 0} onClick={submit}>
        {busy ? 'Awaiting wallet…' : 'Create super vault'}
      </button>

      <Steps steps={steps} />
    </div>
  )
}
