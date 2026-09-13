import { useMemo, useState } from 'react'
import VaultCard from './VaultCard.jsx'
import VaultDetail from './VaultDetail.jsx'
import CreateSuperVault from '../super/CreateSuperVault.jsx'
import SuperVaultDetail from '../super/SuperVaultDetail.jsx'
import { useVaults } from '../../hooks/useVaults.js'
import { useSuperVaults } from '../../hooks/useSuperVaults.js'
import { useClock } from '../../hooks/useClock.js'
import { asFundEntry } from '../../lib/superVault.js'
import { assetToDisplay } from '../../lib/ledger.js'

/** Everything this company has issued: plain funds and the super vaults it curates. */
export default function MyVaults({ session, address, company, onGoToInvest, onGoToLaunch }) {
  const { vaults, loading, error, refresh } = useVaults()
  const { superVaults, refresh: refreshSupers } = useSuperVaults()
  const nowMs = useClock()
  const [openId, setOpenId] = useState(null)
  const [creatingSuper, setCreatingSuper] = useState(false)

  const mine = useMemo(() => [
    ...vaults.filter((v) => v.company_address === address).map((v) => ({ ...v, kind: 'fund' })),
    ...superVaults.filter((s) => s.curator_address === address).map(asFundEntry),
  ], [vaults, superVaults, address])

  const totals = useMemo(() => {
    const on = mine.filter((v) => v.vault)
    return {
      count: mine.length,
      raising: mine.filter((v) => v.phase?.phase === 'Subscription').length,
      raised: on.reduce((s, v) => s + Number(v.vault.AssetsTotal ?? 0), 0),
      lent: on.reduce((s, v) => s + (Number(v.vault.AssetsTotal ?? 0) - Number(v.vault.AssetsAvailable ?? 0)), 0),
    }
  }, [mine])

  const selected = mine.find((v) => v.vault_id === openId)
  const refreshAll = () => { refresh(); refreshSupers() }

  // Candidates for a super vault: any readable fund not already a super vault.
  const candidates = useMemo(
    () => vaults.filter((v) => v.onChain && !superVaults.some((s) => s.vault_id === v.vault_id)),
    [vaults, superVaults],
  )

  if (creatingSuper) {
    return <CreateSuperVault session={session} address={address} company={company}
                             candidates={candidates} nowMs={nowMs}
                             onCancel={() => setCreatingSuper(false)}
                             onCreated={(sv) => { refreshAll(); setCreatingSuper(false); setOpenId(sv.vault_id) }} />
  }

  if (openId && selected) {
    // Managing your own fund-of-funds needs the deployment controls, not the
    // investor view: same vault, different job.
    const raw = superVaults.find((s) => s.vault_id === openId)
    return raw
      ? <SuperVaultDetail entry={raw} nowMs={nowMs} session={session} address={address}
                          onBack={() => setOpenId(null)} onRefresh={refreshAll}
                          onRelaunch={() => { setOpenId(null); setCreatingSuper(true) }} />
      : <VaultDetail entry={selected} nowMs={nowMs} session={session} address={address}
                     onBack={() => setOpenId(null)} onSettled={refreshAll} />
  }

  return (
    <>
      <p className="lede">
        Funds and super vaults issued by {company?.name ?? 'this company'}.
        Investors browse all of them in <button className="linklike" onClick={onGoToInvest}>Invest</button>.
      </p>

      <div className="stats">
        <div><span>Vaults issued</span><b>{totals.count}</b></div>
        <div><span>Currently raising</span><b>{totals.raising}</b></div>
        <div><span>Total raised</span>
             <b>{mine[0]?.vault ? `${assetToDisplay(mine[0].vault, totals.raised)} XRP` : '—'}</b></div>
        <div><span>Deployed in loans</span>
             <b>{mine[0]?.vault ? `${assetToDisplay(mine[0].vault, totals.lent)} XRP` : '—'}</b></div>
      </div>

      {error && <p className="status err">{error}</p>}
      {loading && !mine.length && <p className="status">Loading…</p>}
      {!loading && !mine.length && (
        <p className="empty">
          You have not issued anything yet.{' '}
          <button className="linklike" onClick={onGoToLaunch}>Launch a fund</button> to start one.
        </p>
      )}

      <div className="vaultgrid">
        {mine.map((entry) => (
          <VaultCard key={entry.vault_id} entry={entry} nowMs={nowMs}
                     onOpen={() => setOpenId(entry.vault_id)} />
        ))}
      </div>
    </>
  )
}
