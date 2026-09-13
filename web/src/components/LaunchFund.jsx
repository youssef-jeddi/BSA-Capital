import { useMemo, useState } from 'react'
import CreateVault from './CreateVault.jsx'
import CreateSuperVault from './super/CreateSuperVault.jsx'
import { useVaults } from '../hooks/useVaults.js'
import { useSuperVaults } from '../hooks/useSuperVaults.js'
import { useClock } from '../hooks/useClock.js'

/**
 * Choose what you are launching before filling anything in.
 *
 * A plain fund and a fund-of-funds share a name and almost nothing else: one
 * lends to borrowers you underwrite, the other lends to your own deployment
 * account which subscribes to other managers. Asking first keeps two long forms
 * from pretending to be one.
 */
const KINDS = [
  {
    id: 'vault',
    label: 'A fund',
    blurb: 'A close-ended vault you raise into and lend out yourself. You underwrite the '
      + 'borrowers, post first-loss cover, and service the loans.',
  },
  {
    id: 'super',
    label: 'A super vault',
    blurb: 'A fund-of-funds. One raise, one redemption date for your depositors, allocated '
      + 'across several managers you pick. You take first loss on the blend.',
  },
]

export default function LaunchFund({ session, address, company }) {
  const [kind, setKind] = useState(null)
  const { vaults, refresh } = useVaults()
  const { superVaults, refresh: refreshSupers } = useSuperVaults()
  const nowMs = useClock()

  // Candidates for a super vault: any readable fund not already a super vault.
  const candidates = useMemo(
    () => vaults.filter((v) => v.onChain && !superVaults.some((s) => s.vault_id === v.vault_id)),
    [vaults, superVaults],
  )

  if (kind === 'vault') {
    return (
      <>
        <button className="back" onClick={() => setKind(null)}>Back to launch options</button>
        <CreateVault session={session} address={address} company={company} />
      </>
    )
  }

  if (kind === 'super') {
    return (
      <CreateSuperVault session={session} address={address} company={company}
                        candidates={candidates} nowMs={nowMs}
                        onCancel={() => setKind(null)}
                        onCreated={() => { refresh(); refreshSupers(); setKind(null) }} />
    )
  }

  return (
    <>
      <p className="lede">
        Both are close-ended XLS-65 vaults with immutable phase dates. The difference is where the
        money goes once the subscription window closes.
      </p>
      <div className="roles">
        {KINDS.map((k) => (
          <button key={k.id} className="role" onClick={() => setKind(k.id)}>
            <b>{k.label}</b>
            <span>{k.blurb}</span>
          </button>
        ))}
      </div>
    </>
  )
}
