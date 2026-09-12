import { useEffect, useState } from 'react'
import { Client } from 'xrpl'
import { startPairing, restoreSession, disconnect, accountOf, allSessions, getClient, CHAIN } from './wallet.js'
import CreateVault from './components/CreateVault.jsx'
import Depositor from './components/Depositor.jsx'
import Borrower from './components/Borrower.jsx'
import Identity from './components/Identity.jsx'
import Marketplace from './components/Marketplace.jsx'

const WSS = 'wss://s.devnet.rippletest.net:51233/'
const EXPLORER = 'https://devnet.xrpl.org'

const TABS = [
  { id: 'broker', label: 'Broker', ready: true },
  { id: 'depositor', label: 'Depositor', ready: true },
  { id: 'borrower', label: 'Borrower', ready: true },
  { id: 'identity', label: 'Identity', ready: true },
  { id: 'market', label: 'Marketplace', ready: true },
]

const savedProjectId = () =>
  import.meta.env.VITE_WC_PROJECT_ID || localStorage.getItem('wc_project_id') || ''

export default function App() {
  const [projectId, setProjectId] = useState(savedProjectId)
  const [session, setSession] = useState(null)
  const [sessions, setSessions] = useState([])
  const [pairing, setPairing] = useState(false)
  const [uri, setUri] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [balance, setBalance] = useState(null)
  const [tab, setTab] = useState('broker')

  const address = accountOf(session)

  useEffect(() => {
    if (!projectId) return
    getClient(projectId)
      .then(() => { setSessions(allSessions()); const s = restoreSession(); if (s) setSession(s) })
      .catch((e) => setStatus(`Init failed: ${e.message}`))
  }, [projectId])

  // Refetches whenever `bump` changes so a completed transaction updates the balance.
  const [bump, setBump] = useState(0)
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
  }, [address, bump])

  async function connect() {
    if (!projectId) return setStatus('Enter a WalletConnect project ID first.')
    setBusy(true); setStatus('Creating pairing…'); setUri('')
    try {
      localStorage.setItem('wc_project_id', projectId)
      const { uri, approval } = await startPairing(projectId)
      setUri(uri)
      setStatus('Paste the URI into the wallet extension, then Approve.')
      const s = await approval()
      setSessions(allSessions()); setSession(s); setUri(''); setStatus(''); setPairing(false)
    } catch (e) { setStatus(`Connect failed: ${e.message}`) }
    finally { setBusy(false) }
  }

  async function drop() {
    try { await disconnect(session) } catch { /* already gone */ }
    const rest = allSessions()
    setSessions(rest); setSession(rest[rest.length - 1] ?? null)
    setBalance(null); setStatus('Disconnected.')
  }

  return (
    <main>
      <header>
        <div>
          <h1>BSA Capital</h1>
          <span className="net">XRPL Devnet · {CHAIN}</span>
        </div>
        {session && (
          <div className="who">
            {sessions.length > 1 ? (
              <select className="sm" value={session.topic}
                      onChange={(e) => setSession(sessions.find((x) => x.topic === e.target.value))}>
                {sessions.map((s) => (
                  <option key={s.topic} value={s.topic}>{accountOf(s)}</option>
                ))}
              </select>
            ) : (
              <a href={`${EXPLORER}/accounts/${address}`} target="_blank" rel="noreferrer">
                {address.slice(0, 8)}…{address.slice(-6)}
              </a>
            )}
            <span>{balance === null ? '…' : `${balance} XRP`}</span>
            <button className="ghost sm" onClick={() => setBump((n) => n + 1)}>Refresh</button>
            <button className="ghost sm" onClick={() => { setPairing(true); connect() }}>+ Wallet</button>
            <button className="ghost sm" onClick={drop}>Disconnect</button>
          </div>
        )}
      </header>

      {!session ? (
        <section className="card">
          <h2>Connect wallet</h2>
          <label>
            WalletConnect project ID
            <input value={projectId} onChange={(e) => setProjectId(e.target.value.trim())}
                   placeholder="from cloud.reown.com" spellCheck={false} />
          </label>
          <button className="primary" onClick={connect} disabled={busy || !projectId}>
            {busy ? 'Working…' : 'Connect'}
          </button>
          {uri && (
            <div className="uri">
              <p>Copy into the XRPL Dev Wallet popup → the WalletConnect icon → <b>Connect</b>:</p>
              <textarea readOnly value={uri} rows={4} onFocus={(e) => e.target.select()} />
              <button className="ghost" onClick={() => navigator.clipboard.writeText(uri)}>Copy URI</button>
            </div>
          )}
        </section>
      ) : (
        <>
          {pairing && uri && (
            <div className="card uri">
              <p>Switch the extension to the <b>other account</b> first, then paste this and Approve:</p>
              <textarea readOnly value={uri} rows={4} onFocus={(e) => e.target.select()} />
              <div className="row">
                <button className="ghost" onClick={() => navigator.clipboard.writeText(uri)}>Copy URI</button>
                <button className="ghost" onClick={() => { setPairing(false); setUri('') }}>Cancel</button>
              </div>
            </div>
          )}
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} disabled={!t.ready} className={tab === t.id ? 'tab on' : 'tab'}
                      onClick={() => setTab(t.id)}>
                {t.label}{!t.ready && <span className="soon">soon</span>}
              </button>
            ))}
          </nav>
          {tab === 'broker' && <CreateVault key={address} session={session} address={address} />}
          {tab === 'depositor' && <Depositor key={address} session={session} address={address} />}
          {tab === 'borrower' && <Borrower key={address} session={session} address={address} />}
          {tab === 'identity' && <Identity key={address} session={session} address={address} />}
          {tab === 'market' && <Marketplace key={address} session={session} address={address} />}
        </>
      )}

      {status && <p className="status">{status}</p>}
    </main>
  )
}
