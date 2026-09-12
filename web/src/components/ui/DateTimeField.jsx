import { Field } from './Field.jsx'
import { inMinutes, PRESETS } from '../../lib/schedule.js'

/** A datetime-local input with quick presets, since most testing is minutes away. */
export default function DateTimeField({ label, required, hint, value, onChange, error }) {
  return (
    <Field label={label} required={required} hint={hint} error={error}>
      <input type="datetime-local" value={value} onChange={(e) => onChange(e.target.value)} />
      <span className="presets">
        {PRESETS.map((p) => (
          <button key={p.label} type="button" className="chip tiny"
                  onClick={() => onChange(inMinutes(p.minutes))}>
            {p.label}
          </button>
        ))}
      </span>
    </Field>
  )
}
