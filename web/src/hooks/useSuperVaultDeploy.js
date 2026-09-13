import { useCallback, useState } from 'react'
import { signTransaction, signAsCounterparty } from '../wallet.js'
import {
  markSuperVaultDeployed, markAllocationFunded,
  counterSignWithDeployer, depositAsDeployer,
} from '../lib/api.js'
import { handoffExpiry, submitSigned, withHandoffWindow } from '../lib/ledger.js'
import { loanSchedule, splitRaise } from '../lib/superVault.js'
import { clearPendingLoan, getPendingLoan, savePendingLoan } from '../lib/pendingLoans.js'

const codeOf = (m) => /\b(te[cflms][A-Z_]+)/.exec(m)?.[1]

/**
 * The deployment transactions.
 *
 * `borrow`      curator signs the LoanSet without submitting, and it is parked
 * `counterSign` deployment account adds its signature and the app submits
 * `fund`        deployment account deposits its share into one sub-fund
 */
export function useSuperVaultDeploy({ session, address, entry, onDone }) {
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(() => getPendingLoan(entry.vault_id))

  const isCurator = address === entry.curator_address
  const isDeployer = address === entry.deployment_address

  const refreshPending = useCallback(
    () => setPending(getPendingLoan(entry.vault_id)), [entry.vault_id])

  async function borrow() {
    setBusy(true); setSteps([{ label: 'LoanSet — curator signature', state: 'pending' }])
    try {
      const raised = Number(entry.own?.vault?.AssetsAvailable ?? 0)
      if (!raised) throw new Error('The super vault has not raised anything yet.')

      // Same schedule as deployAll: a hardcoded 120s x 2 matured the loan four
      // minutes after origination, long before any sub-fund could redeem, and a
      // loan past maturity can never be repaid — LoanPay returns tecEXPIRED and
      // the capital is stranded with the deployment account.
      const schedule = loanSchedule({ maturityRippleTime: entry.loan_maturity, nowMs: Date.now() })
      if (schedule.error) throw new Error(schedule.error)

      const res = await signTransaction(session, await withHandoffWindow({
        TransactionType: 'LoanSet', Account: address,
        Counterparty: entry.deployment_address,
        LoanBrokerID: entry.loan_broker_id,
        PrincipalRequested: String(raised),
        InterestRate: entry.interest_rate ?? 5000,
        PaymentInterval: schedule.PaymentInterval,
        PaymentTotal: schedule.PaymentTotal,
        GracePeriod: schedule.GracePeriod,
      }), { submit: false })

      savePendingLoan(entry.vault_id, res.tx_json)
      refreshPending()
      setSteps([{ label: 'Signed by the curator', state: 'ok',
                  detail: `Held for ${entry.deployment_address}. Switch to that account to counter-sign.` }])
    } catch (e) {
      setSteps([{ label: 'LoanSet', state: 'fail', code: codeOf(e.message), error: e.message }])
    } finally { setBusy(false) }
  }

  async function counterSign() {
    setBusy(true); setSteps([{ label: 'LoanSet — counterparty signature', state: 'pending' }])
    try {
      const held = getPendingLoan(entry.vault_id)
      if (!held) throw new Error('No half-signed loan is waiting for this super vault.')

      // Say so before spending a wallet approval on a transaction the ledger
      // will refuse: the curator's signature covers LastLedgerSequence, so an
      // expired blob can only be discarded and re-signed.
      const { expired } = await handoffExpiry(held.txJson)
      if (expired) {
        throw new Error('The curator signature has expired — its validity window closed before the '
          + 'deployment account counter-signed. Discard it and re-sign.')
      }

      // signature_target makes the wallet use the CPT prefix and NOT submit.
      const signedRes = await signAsCounterparty(session, held.txJson)
      setSteps([{ label: 'Both signatures collected', state: 'ok' },
                { label: 'Submitting', state: 'pending' }])

      const result = await submitSigned(signedRes.tx_json)
      const code = result.meta?.TransactionResult
      const loan = result.meta?.AffectedNodes
        ?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === 'Loan')

      setSteps([
        { label: 'Both signatures collected', state: 'ok' },
        { label: 'LoanSet', state: code === 'tesSUCCESS' ? 'ok' : 'fail', code, hash: result.hash,
          detail: loan ? `LoanID ${loan.LedgerIndex}` : undefined },
      ])

      if (code === 'tesSUCCESS') {
        clearPendingLoan(entry.vault_id)
        refreshPending()
        if (loan) await markSuperVaultDeployed(entry.vault_id, loan.LedgerIndex, entry.curator_address).catch(() => {})
        onDone?.()
      }
    } catch (e) {
      const msg = e?.data?.error_exception ?? e.message
      setSteps((p) => [...p.filter((s) => s.state !== 'pending'),
                       { label: 'LoanSet', state: 'fail', code: codeOf(msg), error: msg }])
    } finally { setBusy(false) }
  }

  /**
   * Counter-sign with the stored Devnet test account instead of switching
   * wallets. The server holds that seed, so a demo is one button.
   */
  async function counterSignWithTestAccount() {
    setBusy(true); setSteps([{ label: 'Counter-signing with the test account', state: 'pending' }])
    try {
      const held = getPendingLoan(entry.vault_id)
      if (!held) throw new Error('No half-signed loan is waiting for this super vault.')
      const out = await counterSignWithDeployer(entry.vault_id, held.txJson, entry.curator_address)
      const ok = out.result_code === 'tesSUCCESS'
      setSteps([{ label: 'LoanSet', state: ok ? 'ok' : 'fail', code: out.result_code,
                  hash: out.hash, detail: out.loan_id ? `LoanID ${out.loan_id}` : undefined }])
      if (ok) { clearPendingLoan(entry.vault_id); refreshPending(); onDone?.() }
    } catch (e) {
      setSteps([{ label: 'Counter-sign', state: 'fail', error: e.errors?.[0] ?? e.message }])
    } finally { setBusy(false) }
  }

  /** Fund one allocation from the stored test account. */
  async function fundWithTestAccount(position) {
    setBusy(true); setSteps([{ label: `VaultDeposit → ${position.sub_vault_name}`, state: 'pending' }])
    try {
      const amount = splitRaise(entry, entry.positions)
        .find((p) => p.sub_vault_id === position.sub_vault_id)?.amount
      if (!amount || amount === '0') throw new Error('Nothing to allocate to this fund.')
      const out = await depositAsDeployer(entry.vault_id, position.sub_vault_id, amount, entry.curator_address)
      setSteps([{ label: `VaultDeposit → ${position.sub_vault_name}`,
                  state: out.result_code === 'tesSUCCESS' ? 'ok' : 'fail',
                  code: out.result_code, hash: out.hash }])
      onDone?.()
    } catch (e) {
      setSteps([{ label: 'VaultDeposit', state: 'fail', error: e.errors?.[0] ?? e.message }])
    } finally { setBusy(false) }
  }

  /**
   * The whole deployment in one action.
   *
   * Only step 1 needs the curator's wallet: they are lending their own vault's
   * money and must consent. Everything after is signed server-side by the
   * deployment account, so the manager is not switching wallets mid-flow.
   */
  async function deployAll() {
    setBusy(true)
    const trail = []
    const push = (step) => { trail.push(step); setSteps([...trail]) }
    const settle = (patch) => { Object.assign(trail[trail.length - 1], patch); setSteps([...trail]) }

    try {
      // 1. Curator signs the loan from the super vault to the deployment account.
      let held = getPendingLoan(entry.vault_id)
      if (!held && entry.status !== 'deployed') {
        push({ label: '1 · Curator signs the loan', state: 'pending' })
        const raised = Number(entry.own?.vault?.AssetsAvailable ?? 0)
        if (!raised) throw new Error('Nothing has been deposited into this super vault yet.')

        // The last payment must land on the maturity the curator chose, not a
        // hardcoded few minutes: a loan past maturity can never be repaid.
        const schedule = loanSchedule({ maturityRippleTime: entry.loan_maturity, nowMs: Date.now() })
        if (schedule.error) throw new Error(schedule.error)

        const res = await signTransaction(session, await withHandoffWindow({
          TransactionType: 'LoanSet', Account: address,
          Counterparty: entry.deployment_address,
          LoanBrokerID: entry.loan_broker_id,
          PrincipalRequested: String(raised),
          // The curator chose this when launching; the spread over what the
          // sub-funds earn is their return, and any shortfall is their loss.
          InterestRate: entry.interest_rate ?? 5000,
          PaymentInterval: schedule.PaymentInterval,
          PaymentTotal: schedule.PaymentTotal,
          GracePeriod: schedule.GracePeriod,
        }), { submit: false })

        savePendingLoan(entry.vault_id, res.tx_json)
        held = getPendingLoan(entry.vault_id)
        refreshPending()
        settle({ state: 'ok' })
      }

      // 2. Deployment account counter-signs and the loan is submitted.
      if (entry.status !== 'deployed') {
        push({ label: '2 · Deployment account counter-signs', state: 'pending' })
        const out = await counterSignWithDeployer(entry.vault_id, held.txJson, entry.curator_address)
        if (out.result_code !== 'tesSUCCESS') throw new Error(`LoanSet: ${out.result_code}`)
        clearPendingLoan(entry.vault_id); refreshPending()
        settle({ state: 'ok', code: out.result_code, hash: out.hash,
                 detail: out.loan_id ? `LoanID ${out.loan_id}` : undefined })
      }

      // 3. Allocate the drawn principal across the sub-funds.
      const todo = entry.positions.filter((p) => !p.deposited_tx)
      const split = splitRaise(entry, entry.positions)
      for (const position of todo) {
        const amount = split.find((x) => x.sub_vault_id === position.sub_vault_id)?.amount
        if (!amount || amount === '0') continue
        push({ label: `3 · Fund ${position.sub_vault_name ?? 'sub-fund'}`, state: 'pending' })
        const out = await depositAsDeployer(entry.vault_id, position.sub_vault_id, amount, entry.curator_address)
        settle({ state: out.result_code === 'tesSUCCESS' ? 'ok' : 'fail',
                 code: out.result_code, hash: out.hash })
        if (out.result_code !== 'tesSUCCESS') {
          throw new Error(`${position.sub_vault_name}: ${out.result_code}`)
        }
      }

      push({ label: 'Deployed', state: 'info',
             detail: 'Capital is working in the sub-funds. Repayments will step the price per share.' })
      onDone?.()
    } catch (e) {
      const msg = e?.errors?.[0] ?? e.message
      if (trail.length && trail[trail.length - 1].state === 'pending') settle({ state: 'fail', error: msg })
      else push({ label: 'Deploy', state: 'fail', error: msg })
    } finally { setBusy(false) }
  }

  function discard() {
    clearPendingLoan(entry.vault_id)
    refreshPending()
    setSteps([{ label: 'Half-signed loan discarded', state: 'info' }])
  }

  async function fund(position) {
    setBusy(true); setSteps([{ label: `VaultDeposit → ${position.sub_vault_name}`, state: 'pending' }])
    try {
      const amount = splitRaise(entry, entry.positions)
        .find((p) => p.sub_vault_id === position.sub_vault_id)?.amount
      if (!amount || amount === '0') throw new Error('Nothing to allocate to this fund.')

      const res = await signTransaction(session, {
        TransactionType: 'VaultDeposit', Account: address,
        VaultID: position.sub_vault_id, Amount: amount,
      })
      const code = res?.tx_json?.meta?.TransactionResult
      setSteps([{ label: `VaultDeposit → ${position.sub_vault_name}`,
                  state: code === 'tesSUCCESS' ? 'ok' : 'fail', code, hash: res.hash }])
      if (code === 'tesSUCCESS') {
        await markAllocationFunded(entry.vault_id, position.sub_vault_id, res.hash, entry.curator_address).catch(() => {})
      }
      onDone?.()
    } catch (e) {
      setSteps([{ label: 'VaultDeposit', state: 'fail', code: codeOf(e.message), error: e.message }])
    } finally { setBusy(false) }
  }

  return {
    steps, busy, pending, isCurator, isDeployer,
    borrow, counterSign, counterSignWithTestAccount, discard, fund, fundWithTestAccount, deployAll,
  }
}
