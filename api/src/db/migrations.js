/**
 * Ordered, idempotent migrations.
 *
 * schema.sql is all CREATE TABLE IF NOT EXISTS, so an existing database silently
 * keeps its old shape and every column added later is simply missing. Deleting the
 * database is not a migration strategy once a second person has one.
 *
 * Each step is (name, fn). Applied names are recorded, so re-running is a no-op.
 */
const has = (db, table) =>
  db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table) != null

const column = (db, table, col) =>
  has(db, table) && db.pragma(`table_info("${table}")`).some((c) => c.name === col)

const addColumn = (db, table, col, decl) => {
  if (has(db, table) && !column(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`)
}

const STEPS = [
  ['2026-09-12-vault-zones', (db) => {
    addColumn(db, 'vaults', 'zones', 'TEXT')
    addColumn(db, 'vaults', 'domain_id', 'TEXT')
  }],
  ['2026-09-12-super-vault-loan-maturity', (db) => {
    addColumn(db, 'super_vaults', 'loan_maturity', 'INTEGER')
    addColumn(db, 'super_vaults', 'deployment_address', 'TEXT')
  }],
  ['2026-09-13-listing-payment-unique', (db) => {
    // Clear duplicates before the unique index can be built.
    if (has(db, 'listings')) {
      db.exec(`
        UPDATE listings SET payment_hash = NULL
         WHERE payment_hash IS NOT NULL AND id NOT IN (
           SELECT MIN(id) FROM listings WHERE payment_hash IS NOT NULL GROUP BY payment_hash
         )`)
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_payment
                 ON listings(payment_hash) WHERE payment_hash IS NOT NULL`)
    }
  }],
  ['2026-09-13-super-vault-interest-rate', (db) => {
    addColumn(db, 'super_vaults', 'interest_rate', 'INTEGER')
  }],
  ['2026-09-13-drop-unused-profile-status', (db) => {
    // companies.status / users.status were a seam for a credentials flow the zone
    // system replaced. Nothing ever wrote them. SQLite cannot drop a column
    // portably, so they are left in place but no longer referenced anywhere.
    void db
  }],
]

export function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)')
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name))
  const record = db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)')

  const run = db.transaction(() => {
    for (const [name, step] of STEPS) {
      if (applied.has(name)) continue
      step(db)
      record.run(name, new Date().toISOString())
    }
  })
  run()
}
