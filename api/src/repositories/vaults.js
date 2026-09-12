/** Data access for the vault index. */
import { getDb, nowIso } from '../db/index.js'

const SELECT_WITH_COMPANY = `
  SELECT v.*, c.name AS company_name, c.activity AS company_activity,
         c.country AS company_country, c.status AS company_status
    FROM vaults v
    JOIN companies c ON c.address = v.company_address
`

const withZones = (row) => (row ? { ...row, zones: row.zones ? JSON.parse(row.zones) : [] } : null)

export function findById(vaultId) {
  return withZones(getDb().prepare(`${SELECT_WITH_COMPANY} WHERE v.vault_id = ?`).get(vaultId))
}

export function list({ company } = {}) {
  const db = getDb()
  const rows = company
    ? db.prepare(`${SELECT_WITH_COMPANY} WHERE v.company_address = ? ORDER BY v.created_at DESC`).all(company)
    : db.prepare(`${SELECT_WITH_COMPANY} ORDER BY v.created_at DESC`).all()
  return rows.map(withZones)
}

export function insert(vault) {
  getDb().prepare(`
    INSERT INTO vaults (vault_id, company_address, loan_broker_id, share_mpt_id, name, activity,
                        asset_code, subscription_date, redemption_date, is_private, zones, domain_id,
                        tx_hash, created_at)
    VALUES (@vault_id, @company_address, @loan_broker_id, @share_mpt_id, @name, @activity,
            @asset_code, @subscription_date, @redemption_date, @is_private, @zones, @domain_id,
            @tx_hash, @created_at)
  `).run({ ...vault, created_at: nowIso() })
  return findById(vault.vault_id)
}
