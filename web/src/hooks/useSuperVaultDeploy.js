import { useCallback, useState } from 'react'
import { signTransaction, signAsCounterparty } from '../wallet.js'
import { markSuperVaultDeployed, markAllocationFunded } from '../lib/api.js'
import { submitSigned } from '../lib/ledger.js'
import { splitRaise } from '../lib/superVault.js'
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

      const res = await signTransaction(session, {
        TransactionType: 'LoanSet', Account: address,
        Counterparty: entry.deployment_address,
        LoanBrokerID: entry.loan_broker_id,
        PrincipalRequested: String(raised),
        InterestRate: 5000,      // 5%
        PaymentInterval: 120,
        PaymentTotal: 2,
        GracePeriod: 60,         // ledger floor
      }, { submit: false })

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
        if (loan) await markSuperVaultDeployed(entry.vault_id, loan.LedgerIndex).catch(() => {})
        onDone?.()
      }
    } catch (e) {
      const msg = e?.data?.error_exception ?? e.message
      setSteps((p) => [...p.filter((s) => s.state !== 'pending'),
                       { label: 'LoanSet', state: 'fail', code: codeOf(msg), error: msg }])
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
        await markAllocationFunded(entry.vault_id, position.sub_vault_id, res.hash).catch(() => {})
      }
      onDone?.()
    } catch (e) {
      setSteps([{ label: 'VaultDeposit', state: 'fail', code: codeOf(e.message), error: e.message }])
    } finally { setBusy(false) }
  }

  return { steps, busy, pending, isCurator, isDeployer, borrow, counterSign, discard, fund }
}
