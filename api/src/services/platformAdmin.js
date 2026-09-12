/**
 * The platform's own XRPL account: it owns the zone domains and issues zone
 * credentials to investors.
 *
 * DEVNET ONLY. The seed lives in a gitignored file so the platform can act as
 * a credential issuer without a human approving every issuance, which is how a
 * compliance desk would actually work.
 */
import fs from 'node:fs'
import path from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as xrpl from 'xrpl'
import { getDb, nowIso } from '../db/index.js'
import { ZONES, allCombos, comboKey, toHex, zoneByCode } from '../lib/zones.js'

const here = dirname(fileURLToPath(import.meta.url))
const FILE = process.env.PLATFORM_ADMIN ?? path.join(here, '../../data/platform-admin.json')
const WSS = process.env.XRPL_WSS ?? 'wss://s.devnet.rippletest.net:51233/'

function loadAdmin() {
  if (!fs.existsSync(FILE)) return null
  try {
    const { address, seed } = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return address && seed ? { address, seed } : null
  } catch { return null }
}

export const publicAdmin = () => {
  const a = loadAdmin()
  return a ? { address: a.address, configured: true } : { address: null, configured: false }
}

async function withClient(fn) {
  const client = new xrpl.Client(WSS)
  await client.connect()
  try { return await fn(client) } finally { await client.disconnect().catch(() => {}) }
}

async function submit(client, wallet, tx) {
  const res = await client.submitAndWait(wallet.sign(await client.autofill(tx)).tx_blob)
  return { code: res.result.meta?.TransactionResult, hash: res.result.hash, result: res.result }
}

/** Create (once) and fund the platform account, then ensure every zone domain exists. */
export async function setupZones() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })

  return withClient(async (client) => {
    let admin = loadAdmin()
    let wallet
    if (admin) {
      wallet = xrpl.Wallet.fromSeed(admin.seed)
    } else {
      const funded = await client.fundWallet()
      wallet = funded.wallet
      admin = { address: wallet.address, seed: wallet.seed }
      fs.writeFileSync(FILE, JSON.stringify({ ...admin, createdAt: nowIso() }, null, 2))
    }
    if (Number(await client.getXrpBalance(wallet.address)) < 150) {
      await client.fundWallet(wallet).catch(() => {})
    }

    const db = getDb()
    const existing = new Set(db.prepare('SELECT combo_key FROM zone_domains').all().map((r) => r.combo_key))
    const created = []

    for (const zones of allCombos()) {
      const key = comboKey(zones)
      if (existing.has(key)) continue

      const out = await submit(client, wallet, {
        TransactionType: 'PermissionedDomainSet',
        Account: wallet.address,
        AcceptedCredentials: zones.map((code) => ({
          Credential: { Issuer: wallet.address, CredentialType: toHex(zoneByCode(code).credentialType) },
        })),
      })
      if (out.code !== 'tesSUCCESS') throw new Error(`Domain ${key}: ${out.code}`)

      const node = out.result.meta.AffectedNodes
        .map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === 'PermissionedDomain')
      db.prepare(`
        INSERT INTO zone_domains (combo_key, zones, domain_id, tx_hash, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(key, JSON.stringify(zones), node.LedgerIndex, out.hash, nowIso())
      created.push({ key, domain_id: node.LedgerIndex })
    }

    return { address: wallet.address, created, total: allCombos().length }
  })
}

export function listZoneDomains() {
  return getDb().prepare('SELECT * FROM zone_domains ORDER BY LENGTH(combo_key), combo_key').all()
    .map((r) => ({ ...r, zones: JSON.parse(r.zones) }))
}

export const domainForZones = (zones) => {
  if (!zones?.length) return null
  const row = getDb().prepare('SELECT * FROM zone_domains WHERE combo_key = ?').get(comboKey(zones))
  return row ? { ...row, zones: JSON.parse(row.zones) } : null
}

/**
 * Issue a zone credential to an investor. They must still accept it with their
 * own wallet: an issuer cannot force a credential onto an account.
 */
export async function issueZoneCredential(subject, zoneCode) {
  const admin = loadAdmin()
  if (!admin) throw new Error('Platform account not set up. Run: npm run setup-zones')
  const zone = zoneByCode(zoneCode)
  if (!zone) throw new Error(`Unknown zone ${zoneCode}`)

  const wallet = xrpl.Wallet.fromSeed(admin.seed)
  return withClient(async (client) => {
    const out = await submit(client, wallet, {
      TransactionType: 'CredentialCreate',
      Account: wallet.address,
      Subject: subject,
      CredentialType: toHex(zone.credentialType),
    })
    if (out.code === 'tesSUCCESS') {
      getDb().prepare(`
        INSERT INTO zone_credentials (subject, zone, issued_tx, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(subject, zone) DO UPDATE SET issued_tx = excluded.issued_tx
      `).run(subject, zoneCode, out.hash, nowIso())
    }
    return {
      result_code: out.code,
      hash: out.hash,
      issuer: wallet.address,
      credential_type: toHex(zone.credentialType),
    }
  })
}

/** Which zones this account actually holds on-ledger, and whether it accepted them. */
export async function zonesOf(address) {
  const admin = loadAdmin()
  if (!admin) return { configured: false, zones: [] }

  return withClient(async (client) => {
    const objects = await client.request({
      command: 'account_objects', account: address, type: 'credential', ledger_index: 'validated',
    }).then((r) => r.result.account_objects ?? []).catch(() => [])

    const held = []
    for (const zone of ZONES) {
      const type = toHex(zone.credentialType)
      const match = objects.find((o) => o.Issuer === admin.address && o.CredentialType === type)
      if (match) {
        held.push({
          zone: zone.code,
          // lsfAccepted = 0x00010000: issued but not yet accepted by the subject.
          accepted: Boolean(match.Flags & 0x00010000),
        })
      }
    }
    return { configured: true, issuer: admin.address, zones: held }
  })
}
