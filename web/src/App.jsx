import { useEffect, useState } from 'react'
import { Client } from 'xrpl'
import { startPairing, restoreSession, disconnect, accountOf, signTransaction, getClient, CHAIN } from './wallet.js'

const WSS = 'wss://s.devnet.rippletest.net:51233/'
const EXPLORER = 'https://devnet.xrpl.org'

const savedProjectId = () =>
  import.meta.env.VITE_WC_PROJECT_ID || localStorage.getItem('wc_project_id') || ''

export default function App() {
  const [projectId, setProjectId] = useState(savedProjectId)
  const [session, setSession] = useState(null)
  const [uri, setUri] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [balance, setBalance] = useState(null)
  const [lastTx, setLastTx] = useState(null)

  const address = accountOf(session)

  // Reconnect to an existing session on reload.
  useEffect(() => {
    if (!projectId) return
    getClient(projectId)
      .then(() => { const s = restoreSession(); if (s) setSession(s) })
      .catch((e) => setStatus(`Init failed: ${e.message}`))
  }, [projectId])

  // Live balance for the connected account.
  useEffect(() => {
    if (!address) { setBalance(null); return }
    let cancelled = false
    const c = new Client(WSS)
    c.connect()
      .then(() => c.getXrpBalance(address))
      .then((b) => { if (!cancelled) setBalance(b) })
      .catch(() => { if (!cancelled) setBalance('—') })
      .finally(() => c.disconnect().catch(() => {}))
    return () => { cancelled = true }
  }, [address])

  async function connect() {
    if (!projectId) return setStatus('Enter a WalletConnect project ID first.')
    setBusy(true); setStatus('Creating pairing…'); setUri(''); setLastTx(null)
    try {
      localStorage.setItem('wc_project_id', projectId)
      const { uri, approval } = await startPairing(projectId)
      setUri(uri)
      setStatus('Paste the URI into the wallet extension, then Approve.')
      const s = await approval()
      setSession(s); setUri(''); setStatus('Connected.')
    } catch (e) {
      setStatus(`Connect failed: ${e.message}`)
    } finally { setBusy(false) }
  }

  async function drop() {
    try { await disconnect(session) } catch { /* session may already be gone */ }
    setSession(null); setStatus('Disconnected.'); setBalance(null); setLastTx(null)
  }

  // Round-trip test: a no-op AccountSet proves sign + submit works end to end.
  async function testSign() {
    setBusy(true); setStatus('Approve the transaction in the extension…'); setLastTx(null)
    try {
      const res = await signTransaction(session, { TransactionType: 'AccountSet', Account: address })
      setLastTx(res)
      setStatus(`Validated: ${res?.tx_json?.meta?.TransactionResult ?? 'signed'}`)
    } catch (e) {
      setStatus(`Rejected: ${e.message}`)
    } finally { setBusy(false) }
  }

  return (
    <main>
      <header>
        <h1>Continuum</h1>
        <span className="net">XRPL Devnet · {CHAIN}</span>
      </header>

      {!session ? (
        <section className="card">
          <h2>Connect wallet</h2>
          <label>
            WalletConnect project ID
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value.trim())}
              placeholder="from cloud.reown.com"
              spellCheck={false}
            />
          </label>
          <button onClick={connect} disabled={busy || !projectId}>
            {busy ? 'Working…' : 'Connect'}
          </button>

          {uri && (
            <div className="uri">
              <p>Copy this into the XRPL Dev Wallet popup → <b>Connect</b>:</p>
              <textarea readOnly value={uri} rows={4} onFocus={(e) => e.target.select()} />
              <button className="ghost" onClick={() => navigator.clipboard.writeText(uri)}>Copy URI</button>
            </div>
          )}
        </section>
      ) : (
        <section className="card">
          <h2>Connected</h2>
          <dl>
            <dt>Account</dt>
            <dd>
              <a href={`${EXPLORER}/accounts/${address}`} target="_blank" rel="noreferrer">{address}</a>
            </dd>
            <dt>Balance</dt>
            <dd>{balance === null ? 'loading…' : `${balance} XRP`}</dd>
            <dt>Session</dt>
            <dd className="mono">{session.topic.slice(0, 16)}…</dd>
          </dl>
          <div className="row">
            <button onClick={testSign} disabled={busy}>Send test transaction</button>
            <button className="ghost" onClick={drop}>Disconnect</button>
          </div>

          {lastTx && (
            <div className="result">
              <a href={`${EXPLORER}/transactions/${lastTx.hash}`} target="_blank" rel="noreferrer">
                {lastTx.hash}
              </a>
              <details><summary>Raw response</summary><pre>{JSON.stringify(lastTx, null, 2)}</pre></details>
            </div>
          )}
        </section>
      )}

      {status && <p className="status">{status}</p>}
    </main>
  )
}
