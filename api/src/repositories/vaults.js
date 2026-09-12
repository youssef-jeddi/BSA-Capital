/** Data access for the vault index. */
import { getDb, nowIso } from '../db/index.js'

const SELECT_WITH_COMPANY = `
  SELECT v.*, c.name AS company_name, c.activity AS company_activity,
         c.country AS company_country, c.status AS company_status
    FROM vaults v
    JOIN companies c ON c.address = v.company_address
`

export function findById(vaultId) {
  return getDb().prepare(`${SELECT_WITH_COMPANY} WHERE v.vault_id = ?`).get(vaultId) ?? null
}

export function list({ company } = {}) {
  const db = getDb()
  return company
    ? db.prepare(`${SELECT_WITH_COMPANY} WHERE v.company_address = ? ORDER BY v.created_at DESC`).all(company)
    : db.prepare(`${SELECT_WITH_COMPANY} ORDER BY v.created_at DESC`).all()
}

export function insert(vault) {
  getDb().prepare(`
    INSERT INTO vaults (vault_id, company_address, loan_broker_id, share_mpt_id, name, activity,
                        asset_code, subscription_date, redemption_date, is_private, tx_hash, created_at)
    VALUES (@vault_id, @company_address, @loan_broker_id, @share_mpt_id, @name, @activity,
            @asset_code, @subscription_date, @redemption_date, @is_private, @tx_hash, @created_at)
  `).run({ ...vault, created_at: nowIso() })
  return findById(vault.vault_id)
}
