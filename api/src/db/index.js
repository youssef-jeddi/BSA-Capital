import Database from 'better-sqlite3'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const DB_PATH = process.env.BSA_DB ?? join(here, '../../data/bsa.db')

let db

export function getDb() {
  if (!db) {
    // data/ is gitignored, so it does not exist on a fresh clone and
    // better-sqlite3 will not create it for us.
    mkdirSync(dirname(DB_PATH), { recursive: true })
    db = new Database(DB_PATH)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    migrate(db)
  }
  return db
}

function migrate(connection) {
  connection.exec(readFileSync(join(here, 'schema.sql'), 'utf8'))
}

export const nowIso = () => new Date().toISOString()
