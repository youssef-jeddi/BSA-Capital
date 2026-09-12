import { useState } from 'react'
import { xrpToDrops } from 'xrpl'
import { signTransaction } from '../wallet.js'
import { markSuperVaultDeployed, markAllocationFunded } from '../lib/api.js'
import { splitRaise } from '../lib/superVault.js'

const codeOf = (m) => /\b(te[cflms][A-Z_]+)/.exec(m)?.[1]

/**
 * The two deployment transactions.
 *
 * `borrow` is the curator originating a loan from the super vault to the
 * deployment account. It needs both signatures, so it is signed here without
 * submitting and handed to the deployment account to counter-sign.
 *
 * `fund` is the deployment account depositing its share into one sub-fund.
 */
export function useSuperVaultDeploy({ session, address, entry, onDone }) {
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)

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
        InterestRate: 5000,          // 5%
        PaymentInterval: 120,
        PaymentTotal: 2,
        GracePeriod: 60,             // ledger floor
      }, { submit: false })

      setSteps([{ label: 'Signed by the curator', state: 'ok',
                  detail: 'Switch to the deployment account and counter-sign in the Borrower tab.' },
                { label: 'Handoff', state: 'info', detail: JSON.stringify(res.tx_json) }])
    } catch (e) {
      setSteps([{ label: 'LoanSet', state: 'fail', code: codeOf(e.message), error: e.message }])
    } finally { setBusy(false) }
  }

  async function fund(position) {
    setBusy(true); setSteps([{ label: `VaultDeposit → ${position.sub_vault_name}`, state: 'pending' }])
    try {
      const parts = splitRaise(entry, entry.positions)
      const amount = parts.find((p) => p.sub_vault_id === position.sub_vault_id)?.amount
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

  return { steps, busy, borrow, fund }
}
