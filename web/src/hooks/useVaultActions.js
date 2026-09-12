import { useState } from 'react'
import { signTransaction } from '../wallet.js'
import { assetAmount } from '../lib/ledger.js'

/**
 * Deposit and withdraw against one vault. The wallet throws on any
 * non-tesSUCCESS, so the ledger code is recovered from the error message.
 */
const codeOf = (message) => /\b(te[cflms][A-Z_]+)/.exec(message)?.[1]

export function useVaultActions({ session, address, vault, vaultId, onSettled }) {
  const [steps, setSteps] = useState([])
  const [busy, setBusy] = useState(false)

  async function send(label, tx) {
    setBusy(true)
    setSteps([{ label, state: 'pending' }])
    try {
      const res = await signTransaction(session, tx)
      const code = res?.tx_json?.meta?.TransactionResult
      setSteps([{ label, state: code === 'tesSUCCESS' ? 'ok' : 'fail', code, hash: res.hash }])
      onSettled?.()
    } catch (e) {
      setSteps([{ label, state: 'fail', code: codeOf(e.message), error: e.message }])
    } finally {
      setBusy(false)
    }
  }

  const deposit = (amount) => send('VaultDeposit', {
    TransactionType: 'VaultDeposit', Account: address,
    VaultID: vaultId, Amount: assetAmount(vault, amount),
  })

  const withdraw = (amount, mode) => send('VaultWithdraw', {
    TransactionType: 'VaultWithdraw', Account: address, VaultID: vaultId,
    Amount: mode === 'shares'
      ? { mpt_issuance_id: vault.ShareMPTID, value: String(amount) }
      : assetAmount(vault, amount),
  })

  return { steps, busy, deposit, withdraw, clear: () => setSteps([]) }
}
