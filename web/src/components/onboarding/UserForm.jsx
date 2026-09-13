import { registerUser, updateUser } from '../../lib/api.js'
import { Field, TextInput, SelectInput, ErrorList } from '../ui/Field.jsx'
import { useOnboardingForm } from './useOnboardingForm.js'

const blank = { display_name: '', country: '', investor_type: 'retail', contact_email: '' }

const INVESTOR_TYPES = [
  { value: 'retail', label: 'Retail' },
  { value: 'professional', label: 'Professional' },
]

export default function UserForm({ address, existing, onDone }) {
  const { values, set, errors, busy, submit } = useOnboardingForm(
    existing ? { ...blank, ...existing } : blank,
    (v) => (existing ? updateUser(address, v) : registerUser({ ...v, address })),
    onDone,
    onDone, // 409: the wallet is already registered, just resolve its profile
  )

  return (
    <form className="card" onSubmit={submit}>
      <h2>{existing ? 'Investor details' : 'Register as an investor'}</h2>
      <p className="lede">
        Investors subscribe to funds and hold vault shares. Attached to <code>{address}</code>.
        The first save asks your wallet to sign in once — free, and it never reaches the ledger.
      </p>

      <Field label="Name" required>
        <TextInput value={values.display_name} onChange={set('display_name')}
                   placeholder="Jane Dupont" maxLength={80} />
      </Field>

      <div className="grid2">
        <Field label="Country" required hint="Two-letter ISO code">
          <TextInput value={values.country} onChange={(v) => set('country')(v.toUpperCase())}
                     placeholder="FR" maxLength={2} />
        </Field>
        <Field label="Investor type" required
               hint="Professional investors may access restricted funds.">
          <SelectInput value={values.investor_type} onChange={set('investor_type')} options={INVESTOR_TYPES} />
        </Field>
      </div>

      <Field label="Contact email">
        <TextInput value={values.contact_email} onChange={set('contact_email')} type="email" />
      </Field>

      <ErrorList errors={errors} />

      <button className="full" type="submit" disabled={busy}>
        {busy ? 'Saving…' : existing ? 'Save changes' : 'Register as investor'}
      </button>
    </form>
  )
}
