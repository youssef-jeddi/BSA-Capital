/**
 * Pure validation. No database, no HTTP: each function takes a value and
 * returns an error string or null, so they compose and are trivial to test.
 */
import { isValidClassicAddress } from 'ripple-address-codec'

export const INVESTOR_TYPES = ['retail', 'professional']

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '')

export function validateAddress(value) {
  if (!trimmed(value)) return 'address is required'
  if (!isValidClassicAddress(trimmed(value))) return 'address is not a valid XRPL classic address'
  return null
}

export function validateText(value, field, { min = 2, max = 120 } = {}) {
  const v = trimmed(value)
  if (!v) return `${field} is required`
  if (v.length < min) return `${field} must be at least ${min} characters`
  if (v.length > max) return `${field} must be at most ${max} characters`
  return null
}

export function validateCountry(value) {
  const v = trimmed(value).toUpperCase()
  if (!v) return 'country is required'
  if (!/^[A-Z]{2}$/.test(v)) return 'country must be a two-letter ISO code'
  return null
}

export function validateOptionalEmail(value) {
  const v = trimmed(value)
  if (!v) return null
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? null : 'contact_email is not a valid email address'
}

export function validateOptionalUrl(value) {
  const v = trimmed(value)
  if (!v) return null
  return /^([a-z]+:\/\/)?[\w-]+(\.[\w-]+)+([/?#].*)?$/i.test(v) ? null : 'website is not a valid URL'
}

export function validateEnum(value, allowed, field) {
  return allowed.includes(trimmed(value)) ? null : `${field} must be one of ${allowed.join(', ')}`
}

/**
 * Collect the failures from a list of checks. Each check yields either an error
 * string, null, or an array of errors from a nested validator, so flatten.
 */
export const collect = (...checks) => checks.flat(Infinity).filter(Boolean)

export function validateCompanyInput(input) {
  return collect(
    validateAddress(input.address),
    validateText(input.name, 'name', { min: 2, max: 80 }),
    validateText(input.activity, 'activity', { min: 3, max: 200 }),
    validateCountry(input.country),
    validateOptionalUrl(input.website),
    validateOptionalEmail(input.contact_email),
  )
}

export function validateUserInput(input) {
  return collect(
    validateAddress(input.address),
    validateText(input.display_name, 'display_name', { min: 2, max: 80 }),
    validateCountry(input.country),
    validateEnum(input.investor_type, INVESTOR_TYPES, 'investor_type'),
    validateOptionalEmail(input.contact_email),
  )
}
