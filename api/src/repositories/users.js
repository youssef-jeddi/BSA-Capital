/** Data access for individual investors. */
import { getDb, nowIso } from '../db/index.js'

export function findByAddress(address) {
  return getDb().prepare('SELECT * FROM users WHERE address = ?').get(address) ?? null
}

export function list({ status } = {}) {
  const db = getDb()
  return status
    ? db.prepare('SELECT * FROM users WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM users ORDER BY created_at DESC').all()
}

export function insert(user) {
  const at = nowIso()
  getDb().prepare(`
    INSERT INTO users (address, display_name, country, investor_type, contact_email, status, created_at, updated_at)
    VALUES (@address, @display_name, @country, @investor_type, @contact_email, 'pending', @at, @at)
  `).run({ ...user, at })
  return findByAddress(user.address)
}

export function update(address, fields) {
  getDb().prepare(`
    UPDATE users
       SET display_name = @display_name, country = @country,
           investor_type = @investor_type, contact_email = @contact_email, updated_at = @at
     WHERE address = @address
  `).run({ ...fields, address, at: nowIso() })
  return findByAddress(address)
}
