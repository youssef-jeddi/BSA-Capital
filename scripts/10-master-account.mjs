#!/usr/bin/env node
/**
 * Creates the hackathon master account — our credential issuer — on XRPL Devnet
 * and records it in the root .env.
 *
 *   node scripts/10-master-account.mjs           create if absent
 *   node scripts/10-master-account.mjs --force   replace (orphans old credentials)
 *
 * Idempotent by default: credentials already issued by an existing master would
 * be orphaned by a new one, so replacing it has to be asked for explicitly.
 */
import { Client, Wallet } from 'xrpl'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const ENV = path.join(ROOT, '.env')
const WSS = 'wss://s.devnet.rippletest.net:51233/'
const force = process.argv.includes('--force')

// Keys the identity flow expects to find; created empty so .env documents itself.
const EDEL_KEYS = ['EDEL_AUTH_URL', 'EDEL_API_URL', 'EDEL_CLIENT_ID', 'EDEL_CLIENT_SECRET']

const read = () => (fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '')

function upsert(text, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm')
  if (re.test(text)) return text.replace(re, `${key}=${value}`)
  return `${text}${text && !text.endsWith('\n') ? '\n' : ''}${key}=${value}\n`
}

async function main() {
  let text = read()
  const existing = /^MASTER_SEED=(.+)$/m.exec(text)?.[1]?.trim()

  if (existing && !force) {
    const w = Wallet.fromSeed(existing)
    console.log(`Master already in .env: ${w.address}`)
    console.log('Pass --force to replace it (credentials it issued would be orphaned).')
    return
  }

  const client = new Client(WSS)
  await client.connect()
  console.log('Funding a master account from the Devnet faucet...')
  const { wallet, balance } = await client.fundWallet()
  await client.disconnect()

  text = upsert(text, 'MASTER_ADDRESS', wallet.address)
  text = upsert(text, 'MASTER_SEED', wallet.seed)
  for (const k of EDEL_KEYS) if (!new RegExp(`^${k}=`, 'm').test(text)) text = upsert(text, k, '')
  fs.writeFileSync(ENV, text, { mode: 0o600 })

  console.log(`\n  address  ${wallet.address}`)
  console.log(`  balance  ${balance} XRP`)
  console.log(`\nWritten to .env (gitignored). Explorer:`)
  console.log(`  https://devnet.xrpl.org/accounts/${wallet.address}`)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
