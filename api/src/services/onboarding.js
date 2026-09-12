/**
 * Business rules for onboarding. Routes stay thin: they hand raw input here and
 * get back either { ok: true, data } or { ok: false, status, errors }.
 */
import * as companies from '../repositories/companies.js'
import * as users from '../repositories/users.js'
import { validateCompanyInput, validateUserInput } from '../validation/profiles.js'

const fail = (status, ...errors) => ({ ok: false, status, errors: errors.flat() })
const ok = (data) => ({ ok: true, data })

const clean = (v) => (typeof v === 'string' ? v.trim() : null) || null

const companyFields = (input) => ({
  address: clean(input.address),
  name: clean(input.name),
  activity: clean(input.activity),
  country: clean(input.country)?.toUpperCase() ?? null,
  website: clean(input.website),
  contact_email: clean(input.contact_email),
})

const userFields = (input) => ({
  address: clean(input.address),
  display_name: clean(input.display_name),
  country: clean(input.country)?.toUpperCase() ?? null,
  investor_type: clean(input.investor_type),
  contact_email: clean(input.contact_email),
})

/**
 * An address may be a company or an individual, never both: the two roles issue
 * and hold different things, and one wallet playing both makes the vault it
 * created indistinguishable from one it invested in.
 */
function roleConflict(address, wanted) {
  if (wanted !== 'company' && companies.findByAddress(address)) {
    return 'This address is already registered as a company.'
  }
  if (wanted !== 'user' && users.findByAddress(address)) {
    return 'This address is already registered as an individual investor.'
  }
  return null
}

export function registerCompany(input) {
  const errors = validateCompanyInput(input)
  if (errors.length) return fail(400, errors)

  const fields = companyFields(input)
  const conflict = roleConflict(fields.address, 'company')
  if (conflict) return fail(409, conflict)
  if (companies.findByAddress(fields.address)) return fail(409, 'This company is already registered.')

  return ok(companies.insert(fields))
}

export function updateCompany(address, input) {
  if (!companies.findByAddress(address)) return fail(404, 'Company not found.')
  const errors = validateCompanyInput({ ...input, address })
  if (errors.length) return fail(400, errors)
  return ok(companies.update(address, companyFields({ ...input, address })))
}

export function registerUser(input) {
  const errors = validateUserInput(input)
  if (errors.length) return fail(400, errors)

  const fields = userFields(input)
  const conflict = roleConflict(fields.address, 'user')
  if (conflict) return fail(409, conflict)
  if (users.findByAddress(fields.address)) return fail(409, 'This investor is already registered.')

  return ok(users.insert(fields))
}

export function updateUser(address, input) {
  if (!users.findByAddress(address)) return fail(404, 'Investor not found.')
  const errors = validateUserInput({ ...input, address })
  if (errors.length) return fail(400, errors)
  return ok(users.update(address, userFields({ ...input, address })))
}

/**
 * What is this connected wallet? The front end asks once after connecting and
 * routes to onboarding, the broker screens or the investor screens accordingly.
 */
export function resolveProfile(address) {
  const company = companies.findByAddress(address)
  if (company) return { role: 'company', profile: company }

  const user = users.findByAddress(address)
  if (user) return { role: 'user', profile: user }

  return { role: null, profile: null }
}

/** Only a registered company may create a vault. */
export const canCreateVault = (address) => companies.findByAddress(address) !== null
