/** Data access for companies. One query per function, no business rules. */
import { getDb, nowIso } from '../db/index.js'

export function findByAddress(address) {
  return getDb().prepare('SELECT * FROM companies WHERE address = ?').get(address) ?? null
}

export function list({ status } = {}) {
  const db = getDb()
  return status
    ? db.prepare('SELECT * FROM companies WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM companies ORDER BY created_at DESC').all()
}

export function insert(company) {
  const at = nowIso()
  getDb().prepare(`
    INSERT INTO companies (address, name, activity, country, website, contact_email, status, created_at, updated_at)
    VALUES (@address, @name, @activity, @country, @website, @contact_email, 'pending', @at, @at)
  `).run({ ...company, at })
  return findByAddress(company.address)
}

export function update(address, fields) {
  getDb().prepare(`
    UPDATE companies
       SET name = @name, activity = @activity, country = @country,
           website = @website, contact_email = @contact_email, updated_at = @at
     WHERE address = @address
  `).run({ ...fields, address, at: nowIso() })
  return findByAddress(address)
}

/** Seam for the credentials flow: onboarding never calls this itself. */
export function setStatus(address, status) {
  getDb().prepare('UPDATE companies SET status = ?, updated_at = ? WHERE address = ?')
    .run(status, nowIso(), address)
  return findByAddress(address)
}
