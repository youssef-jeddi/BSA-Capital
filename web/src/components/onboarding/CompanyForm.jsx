import { registerCompany, updateCompany } from '../../lib/api.js'
import { Field, TextInput, ErrorList } from '../ui/Field.jsx'
import { useOnboardingForm } from './useOnboardingForm.js'

const blank = { name: '', activity: '', country: '', website: '', contact_email: '' }

export default function CompanyForm({ address, existing, onDone }) {
  const { values, set, errors, busy, submit } = useOnboardingForm(
    existing ? { ...blank, ...existing } : blank,
    (v) => (existing ? updateCompany(address, v) : registerCompany({ ...v, address })),
    onDone,
    onDone, // 409: the wallet is already registered, just resolve its profile
  )

  return (
    <form className="card" onSubmit={submit}>
      <h2>{existing ? 'Company details' : 'Register your company'}</h2>
      <p className="lede">
        Registered companies can launch funds. Your XRPL account is the identity, so the profile is
        attached to <code>{address}</code>. The first save asks your wallet to sign in once — it costs
        nothing and never reaches the ledger.
      </p>

      <Field label="Company name" required>
        <TextInput value={values.name} onChange={set('name')} placeholder="BSA Capital" maxLength={80} />
      </Field>

      <Field label="Activity" required hint="What the company does. Shown to investors browsing your funds.">
        <TextInput value={values.activity} onChange={set('activity')}
                   placeholder="Private credit fund manager" maxLength={200} />
      </Field>

      <div className="grid2">
        <Field label="Country" required hint="Two-letter ISO code">
          <TextInput value={values.country} onChange={(v) => set('country')(v.toUpperCase())}
                     placeholder="FR" maxLength={2} />
        </Field>
        <Field label="Website">
          <TextInput value={values.website} onChange={set('website')} placeholder="bsa.capital" />
        </Field>
      </div>

      <Field label="Contact email">
        <TextInput value={values.contact_email} onChange={set('contact_email')}
                   placeholder="ops@bsa.capital" type="email" />
      </Field>

      <ErrorList errors={errors} />

      <button className="full" type="submit" disabled={busy}>
        {busy ? 'Saving…' : existing ? 'Save changes' : 'Register company'}
      </button>
    </form>
  )
}
