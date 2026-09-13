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

/**
 * Fill in columns that are still empty, and only those.
 *
 * A vault is recorded in two posts: the first right after VaultCreate, the
 * second once LoanBrokerSet has produced a broker id. Never overwrite a value
 * that is already there — a re-post should be able to complete the record, not
 * rewrite it.
 */
const FILLABLE = ['loan_broker_id', 'share_mpt_id', 'domain_id', 'tx_hash', 'target_apy']

export function fillMissing(vaultId, patch) {
  const current = getDb().prepare('SELECT * FROM vaults WHERE vault_id = ?').get(vaultId)
  if (!current) return null
  const sets = FILLABLE.filter((k) => current[k] == null && patch[k] != null)
  if (sets.length) {
    getDb().prepare(`UPDATE vaults SET ${sets.map((k) => `${k} = @${k}`).join(', ')} WHERE vault_id = @vault_id`)
      .run({ ...patch, vault_id: vaultId })
  }
  return findById(vaultId)
}

export function insert(vault) {
  getDb().prepare(`
    INSERT INTO vaults (vault_id, company_address, loan_broker_id, share_mpt_id, name, activity,
                        asset_code, subscription_date, redemption_date, is_private, zones, domain_id,
                        tx_hash, target_apy, created_at)
    VALUES (@vault_id, @company_address, @loan_broker_id, @share_mpt_id, @name, @activity,
            @asset_code, @subscription_date, @redemption_date, @is_private, @zones, @domain_id,
            @tx_hash, @target_apy, @created_at)
  `).run({ ...vault, created_at: nowIso() })
  return findById(vault.vault_id)
}
