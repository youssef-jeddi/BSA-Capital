/**
 * Create (once) and top up the dedicated super-vault deployment account.
 *
 * This account borrows the raise from a super vault and holds the sub-fund
 * positions. It is stored server-side so the UI can counter-sign the curator
 * loan with one button instead of switching wallets mid-demo.
 *
 * DEVNET ONLY. The file holds a seed and lives under api/data/, which is
 * gitignored. Never point this at mainnet.
 */
import * as xrpl from 'xrpl'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const FILE = path.join(ROOT, 'api/data/supervault-account.json')
const TOP_UP_BELOW = 200 // XRP

const client = new xrpl.Client('wss://s.devnet.rippletest.net:51233/')

async function main() {
  await client.connect()
  fs.mkdirSync(path.dirname(FILE), { recursive: true })

  let record = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : null
  let wallet

  if (record?.seed) {
    wallet = xrpl.Wallet.fromSeed(record.seed)
    console.log(`Reusing existing deployment account ${wallet.address}`)
  } else {
    const funded = await client.fundWallet()
    wallet = funded.wallet
    record = { address: wallet.address, seed: wallet.seed, createdAt: new Date().toISOString() }
    fs.writeFileSync(FILE, JSON.stringify(record, null, 2))
    console.log(`Created deployment account ${wallet.address}`)
  }

  const balance = Number(await client.getXrpBalance(wallet.address))
  if (balance < TOP_UP_BELOW) {
    await client.fundWallet(wallet).catch(() => {})
    console.log(`Topped up: ${balance} -> ${await client.getXrpBalance(wallet.address)} XRP`)
  } else {
    console.log(`Balance ${balance} XRP`)
  }

  console.log(`\nSaved to api/data/supervault-account.json (gitignored)`)
  console.log(`Address ${record.address}`)
  console.log(`Explorer https://devnet.xrpl.org/accounts/${record.address}`)
  await client.disconnect()
}

main().catch(async (e) => {
  console.error(e.message)
  if (client.isConnected()) await client.disconnect()
  process.exitCode = 1
})
