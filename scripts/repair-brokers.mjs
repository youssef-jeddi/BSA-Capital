/**
 * Re-attach loan brokers that exist on-ledger but were never indexed.
 *
 * LoanBrokerSet succeeded; the second POST /api/vaults carrying its id was
 * dropped by the old idempotent-re-post branch. The ledger is the authority, so
 * read the brokers back and fill the column in.
 */
import * as xrpl from 'xrpl'
import { createRequire } from 'node:module'

// better-sqlite3 is a dependency of the api package, not the root one.
const require = createRequire(new URL('../api/package.json', import.meta.url))
const Database = require('better-sqlite3')
const db = new Database(new URL('../api/data/bsa.db', import.meta.url).pathname)
const client = new xrpl.Client('wss://s.devnet.rippletest.net:51233/')
await client.connect()

const rows = db.prepare('SELECT vault_id, name, company_address FROM vaults WHERE loan_broker_id IS NULL').all()
console.log(`${rows.length} vault(s) with no indexed broker\n`)

const byCompany = new Map()
for (const r of rows) {
  if (!byCompany.has(r.company_address)) {
    const objs = await client.request({
      command: 'account_objects', account: r.company_address, type: 'loan_broker', ledger_index: 'validated',
    }).then((x) => x.result.account_objects ?? []).catch(() => [])
    byCompany.set(r.company_address, objs)
  }
  const broker = byCompany.get(r.company_address).find((b) => b.VaultID === r.vault_id)
  if (broker) {
    db.prepare('UPDATE vaults SET loan_broker_id = ? WHERE vault_id = ?').run(broker.index, r.vault_id)
    console.log(`  linked  ${r.name.padEnd(16)} -> ${broker.index.slice(0, 16)}…`)
  } else {
    console.log(`  none    ${r.name.padEnd(16)} (no LoanBroker on ${r.company_address.slice(0, 8)}… for this vault)`)
  }
}
await client.disconnect()
