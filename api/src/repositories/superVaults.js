/** Data access for super vaults and their allocation plans. */
import { getDb, nowIso } from '../db/index.js'

const WITH_CURATOR = `
  SELECT s.*, c.name AS curator_name, c.activity AS curator_activity
    FROM super_vaults s
    JOIN companies c ON c.address = s.curator_address
`

export function findById(vaultId) {
  const row = getDb().prepare(`${WITH_CURATOR} WHERE s.vault_id = ?`).get(vaultId)
  return row ? { ...row, allocations: allocationsOf(vaultId) } : null
}

export function list({ curator } = {}) {
  const db = getDb()
  const rows = curator
    ? db.prepare(`${WITH_CURATOR} WHERE s.curator_address = ? ORDER BY s.created_at DESC`).all(curator)
    : db.prepare(`${WITH_CURATOR} ORDER BY s.created_at DESC`).all()
  return rows.map((r) => ({ ...r, allocations: allocationsOf(r.vault_id) }))
}

export function allocationsOf(superVaultId) {
  return getDb().prepare(`
    SELECT a.*, v.name AS sub_vault_name, v.redemption_date AS sub_redemption_date,
           v.company_address AS sub_company_address, c.name AS sub_company_name,
           v.target_apy AS sub_target_apy
      FROM super_vault_allocations a
      LEFT JOIN vaults v ON v.vault_id = a.sub_vault_id
      LEFT JOIN companies c ON c.address = v.company_address
     WHERE a.super_vault_id = ?
     ORDER BY a.target_bps DESC
  `).all(superVaultId)
}

export function insert(superVault, allocations) {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO super_vaults (vault_id, curator_address, deployment_address, loan_broker_id,
                                name, strategy, subscription_date, redemption_date, loan_maturity,
                                interest_rate, status, created_at)
      VALUES (@vault_id, @curator_address, @deployment_address, @loan_broker_id,
              @name, @strategy, @subscription_date, @redemption_date, @loan_maturity,
              @interest_rate, 'raising', @created_at)
    `).run({ ...superVault, created_at: nowIso() })

    const stmt = db.prepare(`
      INSERT INTO super_vault_allocations (super_vault_id, sub_vault_id, target_bps)
      VALUES (?, ?, ?)
    `)
    for (const a of allocations) stmt.run(superVault.vault_id, a.sub_vault_id, a.target_bps)
  })
  tx()
  return findById(superVault.vault_id)
}

export function setDeployed(vaultId, loanId) {
  getDb().prepare("UPDATE super_vaults SET loan_id = ?, status = 'deployed' WHERE vault_id = ?")
    .run(loanId, vaultId)
  return findById(vaultId)
}

export function markAllocationDeposited(superVaultId, subVaultId, txHash) {
  getDb().prepare(`
    UPDATE super_vault_allocations SET deposited_tx = ?
     WHERE super_vault_id = ? AND sub_vault_id = ?
  `).run(txHash, superVaultId, subVaultId)
  return allocationsOf(superVaultId)
}
