import { useEffect, useState } from 'react'
import { Client } from 'xrpl'
import { startPairing, restoreSession, disconnect, accountOf, allSessions, getClient, signTransaction, CHAIN } from './wallet.js'
import { setProofSigner, setProofListener, clearAuthSession } from './lib/api.js'
import Borrower from './components/Borrower.jsx'
import Funds from './components/Funds.jsx'
import MyFunds from './components/MyFunds.jsx'
import Positions from './components/vaults/Positions.jsx'
import Onboarding from './components/onboarding/Onboarding.jsx'
import CompanyForm from './components/onboarding/CompanyForm.jsx'
import UserForm from './components/onboarding/UserForm.jsx'
import { useProfile } from './hooks/useProfile.js'
import { useHolderZones } from './hooks/useZones.js'
import ErrorBoundary from './components/ui/ErrorBoundary.jsx'
import Landing from './components/Landing.jsx'

const WSS = 'wss://s.devnet.rippletest.net:51233/'
const EXPLORER = 'https://devnet.xrpl.org'

/**
 * Navigation is a permanent rail: one line per destination, no group heading
 * unless the heading earns its place. Anything with two halves says so with
 * subtabs inside the screen rather than two entries out here.
 *
 * Registration is exclusive (an address is a company or an individual), but a
 * company can still invest: a curator allocating across other funds is the whole
 * super-vault idea, so Invest is not investor-only.
 */
const NAV_BY_ROLE = {
  company: [
    { items: [
      { id: 'invest', label: 'Invest', title: 'Invest' },
      { id: 'portfolio', label: 'Portfolio', title: 'Portfolio' },
      { id: 'myfunds', label: 'My funds', title: 'My funds' },
      { id: 'borrow', label: 'Borrow', title: 'Borrow' },
    ] },
    { group: 'Account', items: [
      { id: 'profile', label: 'Company profile', title: 'Company profile' },
    ] },
  ],
  user: [
    { items: [
      { id: 'invest', label: 'Invest', title: 'Invest' },
      { id: 'portfolio', label: 'Portfolio', title: 'Portfolio' },
      // An individual can borrow too: a loan is a two-party agreement between a
      // broker and any account, with no requirement that the borrower issues funds.
      { id: 'borrow', label: 'Borrow', title: 'Borrow' },
    ] },
    { group: 'Account', items: [
      { id: 'profile', label: 'Your profile', title: 'Your profile' },
    ] },
  ],
}

const flatten = (nav) => nav.flatMap((g) => g.items)

const savedProjectId = () =>
  import.meta.env.VITE_WC_PROJECT_ID || localStorage.getItem('wc_project_id') || ''

/** Only ask for it when the build has none: it is deployment config, not user input. */
const NEEDS_PROJECT_ID = !import.meta.env.VITE_WC_PROJECT_ID

/** Wall clock in the header, matching the design's ledger-time readout. */
function useWallClock() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export default function App() {
  const [projectId, setProjectId] = useState(savedProjectId)
  const [session, setSession] = useState(null)
  const [sessions, setSessions] = useState([])
  const [pairing, setPairing] = useState(false)
  const [uri, setUri] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [balance, setBalance] = useState(null)
  const [ledger, setLedger] = useState(null)
  const [tab, setTab] = useState(null)
  const clock = useWallClock()

  const address = accountOf(session)

  // The API needs proof of key control for anything that moves value. Signing
  // happens through the connected wallet, with submit:false so nothing lands.
  const [awaitingSignature, setAwaitingSignature] = useState(false)
  useEffect(() => {
    setProofSigner(session ? (tx) => signTransaction(session, tx, { submit: false }) : null)
    setProofListener(setAwaitingSignature)
    clearAuthSession()   // a different wallet must sign for itself
  }, [session, address])

  const { loading: profileLoading, role, profile, error: profileError, refresh: refreshProfile } = useProfile(address)
  const { zones: heldZones } = useHolderZones(address)
  const acceptedZones = heldZones.filter((z) => z.accepted).map((z) => z.zone)
  const nav = NAV_BY_ROLE[role] ?? []
  const items = flatten(nav)
  const active = items.find((i) => i.id === tab) ?? items[0]

  useEffect(() => {
    if (!projectId) return
    getClient(projectId)
      .then(() => { setSessions(allSessions()); const s = restoreSession(); if (s) setSession(s) })
      .catch((e) => setStatus(`Init failed: ${e.message}`))
  }, [projectId])

  // Refetches whenever `bump` changes so a completed transaction updates the balance.
  const [bump, setBump] = useState(0)
  useEffect(() => {
    if (!address) { setBalance(null); setLedger(null); return }
    let cancelled = false
    const c = new Client(WSS)
    c.connect()
      .then(async () => {
        const [b, l] = await Promise.all([c.getXrpBalance(address), c.getLedgerIndex()])
        if (!cancelled) { setBalance(b); setLedger(l) }
      })
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

  /* Not connected: one full-width column, no navigation to speak of yet. */
  if (!session) {
    return (
      <div className="shell solo">
        <div className="pane">
          <header className="topbar">
            <h1>BSA Capital</h1>
            <div className="meta"><span>XRPL Devnet · {CHAIN}</span></div>
          </header>
          <main>
            <Landing>
              <section className="card connect">
                <h2>Get started</h2>
                <p className="lede">
                  Connect the XRPL Dev Wallet to browse funds, invest, or launch one of your own.
                </p>

                {NEEDS_PROJECT_ID && (
                  <label className="field">
                    <span className="field-label">WalletConnect project ID</span>
                    <input value={projectId} onChange={(e) => setProjectId(e.target.value.trim())}
                           placeholder="free at cloud.reown.com" spellCheck={false} />
                    <small className="field-hint">
                      Set <code>VITE_WC_PROJECT_ID</code> in <code>web/.env</code> to skip this.
                    </small>
                  </label>
                )}

                <button className="full" onClick={connect} disabled={busy || !projectId}>
                  {busy ? 'Waiting for your wallet…' : 'Connect wallet'}
                </button>

                {uri && (
                  <div className="uri">
                    <p>
                      In the wallet extension, open the <b>WalletConnect</b> icon, choose
                      <b> Connect via WalletConnect</b>, and paste this:
                    </p>
                    <textarea readOnly value={uri} rows={3} onFocus={(e) => e.target.select()} />
                    <button className="ghost" onClick={() => navigator.clipboard.writeText(uri)}>Copy link</button>
                  </div>
                )}
              </section>
            </Landing>
            {status && <p className="status">{status}</p>}
          </main>
        </div>
      </div>
    )
  }

  /* Connected but not yet registered: the shell exists, the rail has nothing in it. */
  const registering = !profileLoading && !profileError && !role

  return (
    <div className={nav.length ? 'shell' : 'shell solo'}>
      {nav.length > 0 && (
        <aside className="sidebar">
          <div className="brand">
            <b>BSA Capital</b>
            <span>XRPL DEVNET · {CHAIN}</span>
          </div>

          <nav className="sidenav">
            {nav.map((g, gi) => (
              <div className="sidegroup" key={g.group ?? gi}>
                {g.group && <small>{g.group.toUpperCase()}</small>}
                {g.items.map((item) => (
                  <button key={item.id}
                          className={active?.id === item.id ? 'sidelink on' : 'sidelink'}
                          onClick={() => setTab(item.id)}>
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="sidefoot">
            {sessions.length > 1 ? (
              <select value={session.topic}
                      onChange={(e) => setSession(sessions.find((x) => x.topic === e.target.value))}>
                {sessions.map((s) => <option key={s.topic} value={s.topic}>{accountOf(s)}</option>)}
              </select>
            ) : (
              <div className="acct">
                <span className="livedot" />
                <a href={`${EXPLORER}/accounts/${address}`} target="_blank" rel="noreferrer">
                  {address.slice(0, 5)}…{address.slice(-4)}
                </a>
              </div>
            )}
            <div className="bal">{balance === null ? '…' : `${balance} XRP`}</div>
            <div className="note">
              {acceptedZones.length
                ? <>Verified <b>{acceptedZones.join(' · ')}</b> — credentials accepted</>
                : <>No zone credential yet — request one when a gated fund asks</>}
            </div>
            <div className="acts">
              <button onClick={() => setBump((n) => n + 1)}>Refresh</button>
              <button onClick={() => { setPairing(true); connect() }}>+ Wallet</button>
              <button onClick={drop}>Log out</button>
            </div>
          </div>
        </aside>
      )}

      <div className="pane">
        <header className="topbar">
          <h1>{registering ? 'Create your account' : (active?.title ?? 'BSA Capital')}</h1>
          <div className="meta">
            <span>{clock}</span>
            {ledger && <span>ledger {ledger.toLocaleString('en-US').replace(/,/g, ' ')}</span>}
          </div>
        </header>

        <main className={active?.id === 'borrow' ? 'narrow' : undefined}>
          {pairing && uri && (
            <div className="card uri" style={{ marginBottom: 20 }}>
              <p>Switch the extension to the <b>other account</b> first, then paste this and Approve:</p>
              <textarea readOnly value={uri} rows={4} onFocus={(e) => e.target.select()} />
              <div className="row">
                <button className="ghost" onClick={() => navigator.clipboard.writeText(uri)}>Copy URI</button>
                <button className="ghost" onClick={() => { setPairing(false); setUri('') }}>Cancel</button>
              </div>
            </div>
          )}

          {profileLoading ? (
            <p className="status">Loading profile…</p>
          ) : profileError ? (
            <div className="card">
              <h2>Cannot reach the API</h2>
              <p className="lede">
                {profileError}. The onboarding API should be on :8787 — start it with
                <code> npm run api</code>. Not registering you again until it answers.
              </p>
              <button onClick={refreshProfile}>Retry</button>
            </div>
          ) : !role ? (
            <Onboarding address={address} onDone={refreshProfile} />
          ) : (
            <ErrorBoundary key={active?.id}>
                {active?.id === 'invest' && <Funds key={address} session={session} address={address} />}
                {active?.id === 'portfolio' && <Positions key={address} session={session} address={address} />}
                {active?.id === 'myfunds' && (
                  <MyFunds key={address} session={session} address={address} company={profile}
                           onGoToInvest={() => setTab('invest')} />
                )}
                {active?.id === 'borrow' && <Borrower key={address} session={session} address={address} />}
                {active?.id === 'profile' && (role === 'company'
                  ? <CompanyForm address={address} existing={profile} onDone={refreshProfile} />
                  : <UserForm address={address} existing={profile} onDone={refreshProfile} />)}
            </ErrorBoundary>
          )}

          {status && <p className="status">{status}</p>}
        </main>
      </div>

      {awaitingSignature && (
        <div className="signbar" role="status">
          <span className="signbar-dot" />
          <div>
            <b>Sign in with your wallet</b>
            <small>
              Open the XRPL Dev Wallet extension and approve. It appears as an AccountSet, but it is
              never submitted — it only proves you control this account. Once per session.
            </small>
          </div>
        </div>
      )}
    </div>
  )
}
