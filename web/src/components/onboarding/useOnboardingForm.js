import { useState } from 'react'
import { ApiError } from '../../lib/api.js'

/**
 * Shared submit plumbing for the onboarding forms: field state, busy flag and
 * server-error surfacing. The forms themselves only describe their fields.
 */
export function useOnboardingForm(initial, submitFn, onDone, onAlreadyRegistered) {
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState([])
  const [busy, setBusy] = useState(false)

  const set = (key) => (value) => setValues((p) => ({ ...p, [key]: value }))

  async function submit(event) {
    event?.preventDefault()
    setBusy(true); setErrors([])
    try {
      const saved = await submitFn(values)
      onDone?.(saved)
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && onAlreadyRegistered) {
        // Already signed up: this is a returning wallet, so log it in.
        onAlreadyRegistered()
        return
      }
      setErrors(e instanceof ApiError ? e.errors : [e.message])
    } finally {
      setBusy(false)
    }
  }

  return { values, set, errors, busy, submit }
}
