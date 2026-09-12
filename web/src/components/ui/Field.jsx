/** Form primitives. Presentation only: no validation, no data fetching. */

export function Field({ label, required, hint, error, children }) {
  return (
    <label className={error ? 'field bad' : 'field'}>
      <span className="field-label">{label}{required && <em> *</em>}</span>
      {children}
      {hint && !error && <small className="field-hint">{hint}</small>}
      {error && <small className="field-error">{error}</small>}
    </label>
  )
}

export function TextInput({ value, onChange, ...rest }) {
  return <input value={value} onChange={(e) => onChange(e.target.value)} {...rest} />
}

export function SelectInput({ value, onChange, options, ...rest }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      {options.map((o) => (
        <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>
      ))}
    </select>
  )
}

export function ErrorList({ errors }) {
  if (!errors?.length) return null
  return <ul className="errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul>
}
