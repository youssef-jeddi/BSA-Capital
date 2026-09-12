/** Data access for marketplace listings. */
import { getDb, nowIso } from '../db/index.js'

const WITH_VAULT = `
  SELECT l.*, v.name AS vault_name, v.zones AS vault_zones, v.asset_code,
         c.name AS issuer_name
    FROM listings l
    LEFT JOIN vaults v ON v.vault_id = l.vault_id
    LEFT JOIN companies c ON c.address = v.company_address
`

const hydrate = (row) =>
  row ? { ...row, vault_zones: row.vault_zones ? JSON.parse(row.vault_zones) : [] } : null

export const findById = (id) =>
  hydrate(getDb().prepare(`${WITH_VAULT} WHERE l.id = ?`).get(id))

export function list({ status, vault, seller } = {}) {
  const where = []
  const args = []
  if (status) { where.push('l.status = ?'); args.push(status) }
  if (vault) { where.push('l.vault_id = ?'); args.push(vault) }
  if (seller) { where.push('l.seller_address = ?'); args.push(seller) }
  const sql = `${WITH_VAULT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.created_at DESC`
  return getDb().prepare(sql).all(...args).map(hydrate)
}

export function insert(row) {
  getDb().prepare(`
    INSERT INTO listings (id, vault_id, share_mpt_id, domain_id, seller_address, shares,
                          ask_drops, nav_at_listing, status, transfer_hash, created_at)
    VALUES (@id, @vault_id, @share_mpt_id, @domain_id, @seller_address, @shares,
            @ask_drops, @nav_at_listing, 'open', @transfer_hash, @created_at)
  `).run({ ...row, created_at: nowIso() })
  return findById(row.id)
}

export function markSold(id, { buyer_address, payment_hash, delivery_hash }) {
  getDb().prepare(`
    UPDATE listings SET status = 'sold', buyer_address = ?, payment_hash = ?,
           delivery_hash = ?, settled_at = ? WHERE id = ?
  `).run(buyer_address, payment_hash, delivery_hash, nowIso(), id)
  return findById(id)
}

export function markCancelled(id, returnHash) {
  getDb().prepare("UPDATE listings SET status = 'cancelled', return_hash = ?, settled_at = ? WHERE id = ?")
    .run(returnHash, nowIso(), id)
  return findById(id)
}

/** Open shares custody is holding for one issuance, to reconcile against its balance. */
export const openSharesFor = (shareMptId) =>
  getDb().prepare("SELECT shares FROM listings WHERE share_mpt_id = ? AND status = 'open'")
    .all(shareMptId)
    .reduce((sum, r) => sum + BigInt(r.shares), 0n)
    .toString()
