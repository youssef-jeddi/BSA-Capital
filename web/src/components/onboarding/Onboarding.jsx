import { useState } from 'react'
import CompanyForm from './CompanyForm.jsx'
import UserForm from './UserForm.jsx'

/**
 * Shown when a connected wallet has no profile. An address is one or the other,
 * never both, so this is a fork rather than a checklist.
 */
export default function Onboarding({ address, onDone }) {
  const [role, setRole] = useState(null)

  if (role === 'company') return <CompanyForm address={address} onDone={onDone} />
  if (role === 'user') return <UserForm address={address} onDone={onDone} />

  return (
    <div className="card">
      <h2>Welcome</h2>
      <p className="lede">
        This wallet is not registered yet. Choose how you will use the platform.
        An address can be a company or an investor, not both.
      </p>
      <div className="roles">
        <button className="role" onClick={() => setRole('company')}>
          <b>I am a company</b>
          <span>Launch funds, originate loans and manage a lending vault.</span>
        </button>
        <button className="role" onClick={() => setRole('user')}>
          <b>I am an investor</b>
          <span>Subscribe to funds, hold vault shares and redeem at maturity.</span>
        </button>
      </div>
    </div>
  )
}
