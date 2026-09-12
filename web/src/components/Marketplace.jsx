import { useCallback, useEffect, useState } from 'react'
import { signTransaction } from '../wallet.js'
import Steps from './Steps.jsx'

/**
 * Liquidity marketplace for locked vault shares.
 *
 * During a closed-ended vault's Investment phase an LP cannot redeem — VaultWithdraw
 * is tecTOO_SOON — but the share MPT still transfers. So a seller pays shares to
 * custody, we list them, and a buyer pays the seller directly; custody then releases
 * the shares. Custody only ever holds the shares, never the cash.
 *
 * Who may hold the shares is not our decision: the ledger requires an accepted
 * credential in the vault's domain AND the holder's own MPTokenAuthorize opt-in, and
 * refuses anything else with tecNO_AUTH. Opt-in is permissionless, so we check the
 * credential explicitly rather than inferring eligibility from the opt-in.
 */

const API = '/dev-api'
const DROPS = 1_000_000

const fmt = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString())
const xrp = (drops) => (drops === null || drops === undefined ? '—' : (Number(drops) / DROPS).toFixed(6))

async function api(path, init) {
  const r = await fetch(`${API}${path}`, {
    ...init, headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
  })
  const body = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`)
  return body
}

export default function Marketplace({ session, address }) {
  const [market, setMarket] = useState(null)
  const [steps, setSteps] = useState([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // sell side
  const [vaultId, setVaultId] = useState('')
  const [snap, setSnap] = useState(null)
  const [shares, setShares] = useState('')
  const [discount, setDiscount] = useState('10')

  // per-listing eligibility, keyed by vaultId
  const [elig, setElig] = useState({})

  // demo scenario runner
  const [job, setJob] = useState(null)

  const load = useCallback(async () => {
    try { setMarket(await api('/market')) } catch (e) { setError(e.message) }
  }, [])

  useEffect(() => { load() }, [load])

  // While a scenario runs, follow its log and refresh the market when it lands.
  useEffect(() => {
    if (!job?.running) return
    const t = setInterval(async () => {
      try {
        const next = await api('/market/scenario')
        setJob(next)
        if (!next.running) { load(); if (next.summary) setVaultId(next.summary.vaultId) }
      } catch { /* keep polling */ }
    }, 2000)
    return () => clearInterval(t)
  }, [job?.running, load])

  async function runScenario() {
    setError(''); setSteps([])
    try {
      await api('/market/scenario', { method: 'POST', body: JSON.stringify({ holder: address }) })
      setJob({ running: true, log: ['starting…'] })
    } catch (e) { setError(e.message) }
  }

  // Eligibility is per vault (its own domain and share MPT), not per listing.
  useEffect(() => {
    if (!market || !address) return
    const vaults = [...new Set(market.listings.filter((l) => l.status === 'open').map((l) => l.vaultId))]
    Promise.all(vaults.map((v) =>
      api(`/market/eligibility?vault=${v}&account=${address}`).then((e) => [v, e]).catch(() => [v, null])
    )).then((pairs) => setElig(Object.fromEntries(pairs)))
  }, [market, address])

  async function sign(label, tx) {
    setSteps((s) => [...s, { label, state: 'pending' }])
    try {
      const res = await signTransaction(session, tx)
      const code = res?.tx_json?.meta?.TransactionResult
      setSteps((s) => [...s.slice(0, -1), {
        label, state: code === 'tesSUCCESS' ? 'ok' : 'fail', code, hash: res.hash,
      }])
      if (code && code !== 'tesSUCCESS') throw new Error(code)
      return res.hash
    } catch (e) {
      const code = /\b(te[cflms][A-Z_]+)/.exec(e.message)?.[1]
      setSteps((s) => [...s.slice(0, -1), { label, state: 'fail', code, error: e.message }])
      throw e
    }
  }

  async function optIn(vaultId) {
    setBusy(true); setError(''); setSteps([])
    try {
      const e = elig[vaultId]
      await sign('MPTokenAuthorize (opt in to the share MPT)', {
        TransactionType: 'MPTokenAuthorize', Account: address, MPTokenIssuanceID: e.shareMPTID,
      })
      setElig((prev) => ({ ...prev, [vaultId]: { ...e, optedIn: true, ready: e.credentialed } }))
    } catch { /* shown in steps */ } finally { setBusy(false) }
  }

  async function buy(l) {
    setBusy(true); setError(''); setSteps([])
    try {
      // Pay the seller directly — custody never touches the cash.
      const paymentHash = await sign(`Payment ${xrp(l.askDrops)} XRP -> seller`, {
        TransactionType: 'Payment', Account: address,
        Destination: l.seller, Amount: String(l.askDrops),
      })
      setSteps((s) => [...s, { label: 'custody releases the shares', state: 'pending' }])
      const row = await api(`/market/listings/${l.id}/settle`, {
        method: 'POST', body: JSON.stringify({ paymentHash }),
      })
      setSteps((s) => [...s.slice(0, -1), {
        label: `custody released ${fmt(row.shares)} shares`, state: 'ok', hash: row.deliveryHash,
      }])
      load()
    } catch (e) {
      setSteps((s) => [...s.slice(0, -1), { label: 'custody releases the shares', state: 'fail', error: e.message }])
    } finally { setBusy(false) }
  }

  async function cancel(l) {
    setBusy(true); setError(''); setSteps([{ label: 'custody returns the shares', state: 'pending' }])
    try {
      const row = await api(`/market/listings/${l.id}/cancel`, { method: 'POST' })
      setSteps([{ label: `returned ${fmt(row.shares)} shares to seller`, state: 'ok', hash: row.returnHash }])
      load()
    } catch (e) {
      setSteps([{ label: 'custody returns the shares', state: 'fail', error: e.message }])
    } finally { setBusy(false) }
  }

  async function loadVault() {
    setError(''); setSnap(null)
    const id = vaultId.trim().toUpperCase()
    if (!/^[0-9A-F]{64}$/.test(id)) return setError('VaultID must be 64 hex characters.')
    try { setSnap(await api(`/market/vault/${id}`)) } catch (e) { setError(e.message) }
  }

  const askDrops = snap?.navDrops && shares
    ? Math.floor(Number(shares) * snap.navDrops * (1 - Number(discount) / 100))
    : null

  async function list() {
    setBusy(true); setError(''); setSteps([])
    try {
      // Custody must opt in to this share MPT before it can be paid.
      setSteps([{ label: 'custody opts in to the share MPT', state: 'pending' }])
      const prep = await api('/market/prepare', {
        method: 'POST', body: JSON.stringify({ vaultId: snap.vaultId }),
      })
      setSteps([{ label: `custody ready (${prep.custody})`, state: 'ok' }])

      const transferHash = await sign(`Payment ${fmt(shares)} shares -> custody`, {
        TransactionType: 'Payment', Account: address, Destination: prep.custody,
        Amount: { mpt_issuance_id: snap.shareMPTID, value: String(shares) },
      })
      const row = await api('/market/listings', {
        method: 'POST',
        body: JSON.stringify({ vaultId: snap.vaultId, shares: String(shares), askDrops, transferHash }),
      })
      setSteps((s) => [...s, { label: `listed as ${row.id}`, state: 'ok' }])
      setShares(''); load()
    } catch (e) {
      setError(e.message)
    } finally { setBusy(false) }
  }

  const open = market?.listings.filter((l) => l.status === 'open') ?? []
  const done = market?.listings.filter((l) => l.status !== 'open') ?? []

  return (
    <div className="card">
      <h2>Liquidity marketplace</h2>
      <p className="lede">
        A closed-ended vault in its <b>Investment</b> phase will not let an LP redeem
        (<span className="mono">tecTOO_SOON</span>), but the share MPT still moves. Sell the locked
        position at a discount to NAV instead. Custody holds only the shares — the buyer pays the
        seller directly.
        {market && <> Custody: <span className="mono">{market.custody}</span>.</>}
      </p>

      {/* ── scenario runner ───────────────────────────────── */}
      <fieldset>
        <legend>Demo scenario</legend>
        <p className="dim">
          Stands up a private closed-ended vault, three LPs, a loan that lifts NAV above par,
          and two discounted listings — then issues a credential to your wallet. Takes about
          two minutes: it funds five Devnet accounts and waits out a real Subscription window.
        </p>
        <div className="row">
          <button className="primary" onClick={runScenario} disabled={job?.running}>
            {job?.running ? 'Running…' : 'Run demo scenario'}
          </button>
          {job?.summary && <span className="tag">NAV {job.summary.navDrops} drops/share</span>}
        </div>
        {job?.log?.length > 0 && (
          <pre className="scenariolog">{job.log.join('\n')}</pre>
        )}
        {job?.summary && (
          <p className="dim">
            Credential issued to <span className="mono">{address}</span> — accept it in the{' '}
            <b>Identity</b> tab, then come back, opt in, and buy.
          </p>
        )}
      </fieldset>

      {/* ── buy ───────────────────────────────────────────── */}
      <fieldset>
        <legend>Open listings</legend>
        {!open.length ? (
          <p className="dim">
            Nothing listed. Run <span className="mono">node scripts/22-demo-scenario.mjs</span> to
            stand up a vault, three LPs, a loan and two listings.
          </p>
        ) : open.map((l) => {
          const e = elig[l.vaultId]
          const mine = l.seller === address
          return (
            <div key={l.id} className="listing">
              <div className="stats">
                <div><span>Shares</span><b>{fmt(l.shares)}</b></div>
                <div><span>NAV now</span><b>{xrp(l.valueAtNav)} XRP</b></div>
                <div><span>Ask</span><b>{xrp(l.askDrops)} XRP</b></div>
                <div><span>Discount</span><b>{l.discountPct === null ? '—' : `${l.discountPct.toFixed(2)}%`}</b></div>
              </div>
              <p className="dim">
                seller <span className="mono">{l.seller}</span> · vault{' '}
                <span className="mono">{l.vaultId.slice(0, 12)}…</span> · phase {l.phase ?? '—'}
              </p>

              {mine ? (
                <div className="row">
                  <span className="tag">your listing</span>
                  <button className="ghost" onClick={() => cancel(l)} disabled={busy}>Cancel &amp; get shares back</button>
                </div>
              ) : !e ? <p className="dim">checking your eligibility…</p>
                : !e.credentialed ? (
                  <p className="verdict no">
                    ✕ You hold no credential this vault's domain accepts. Get verified in the{' '}
                    <b>Identity</b> tab first — the ledger will refuse the transfer otherwise
                    (<span className="mono">tecNO_AUTH</span>).
                  </p>
                ) : !e.optedIn ? (
                  <div className="row">
                    <p className="dim">
                      Credential OK. You must also opt in to the share MPT — like a trustline,
                      the holder creates it themselves.
                    </p>
                    <button className="ghost" onClick={() => optIn(l.vaultId)} disabled={busy}>Opt in</button>
                  </div>
                ) : (
                  <button className="primary" onClick={() => buy(l)} disabled={busy}>
                    Buy for {xrp(l.askDrops)} XRP
                  </button>
                )}
            </div>
          )
        })}
      </fieldset>

      {/* ── sell ──────────────────────────────────────────── */}
      <fieldset>
        <legend>Sell a locked position</legend>
        <div className="row">
          <input value={vaultId} onChange={(e) => setVaultId(e.target.value)}
                 placeholder="VaultID (64 hex)" spellCheck={false} />
          <button className="ghost" onClick={loadVault}>Load</button>
        </div>
        {snap && (
          <>
            <div className="stats">
              <div><span>Phase</span><b>{snap.phase}</b></div>
              <div><span>NAV / share</span><b>{snap.navDrops} drops</b></div>
              <div><span>Shares outstanding</span><b>{fmt(snap.outstanding)}</b></div>
              <div><span>Transferable</span><b>{snap.transferable ? 'yes' : 'no'}</b></div>
            </div>
            {!snap.transferable ? (
              <p className="verdict no">✕ These shares are non-transferable — no secondary sale is possible.</p>
            ) : (
              <>
                <div className="grid2">
                  <label>Shares to sell
                    <input value={shares} onChange={(e) => setShares(e.target.value.replace(/\D/g, ''))}
                           placeholder="20000000" />
                  </label>
                  <label>Discount to NAV (%)
                    <input value={discount} onChange={(e) => setDiscount(e.target.value.replace(/[^\d.]/g, ''))} />
                  </label>
                </div>
                {askDrops !== null && (
                  <p className="dim">
                    At NAV that position is worth{' '}
                    <b>{xrp(Number(shares) * snap.navDrops)} XRP</b>; asking{' '}
                    <b>{xrp(askDrops)} XRP</b> — you give up{' '}
                    {xrp(Number(shares) * snap.navDrops - askDrops)} XRP for immediate liquidity.
                  </p>
                )}
                <button className="primary" onClick={list} disabled={busy || !shares || !askDrops}>
                  Send shares to custody &amp; list
                </button>
              </>
            )}
          </>
        )}
      </fieldset>

      {done.length > 0 && (
        <fieldset>
          <legend>Settled</legend>
          {done.map((l) => (
            <p key={l.id} className="dim">
              <span className="tag">{l.status}</span> {fmt(l.shares)} shares ·{' '}
              {l.status === 'sold' ? <>bought by <span className="mono">{l.buyer}</span> for {xrp(l.askDrops)} XRP</>
                : 'returned to seller'}
            </p>
          ))}
        </fieldset>
      )}

      <Steps steps={steps} />
      {error && <p className="status err">{error}</p>}
    </div>
  )
}
