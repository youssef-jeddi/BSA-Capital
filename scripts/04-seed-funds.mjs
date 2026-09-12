/**
 * Seed N funds on Devnet as one issuing company, and publish them to the API
 * index so they appear in the Invest tab immediately.
 *
 *   node scripts/04-seed-funds.mjs
 *   SUB_MINUTES=8 RED_MINUTES=30 COUNT=3 node scripts/04-seed-funds.mjs
 *
 * Every fund shares the same lifecycle window, so they all open and close
 * together: one clock to watch while testing.
 */
import * as xrpl from 'xrpl'
import fs from 'node:fs'
import path from 'node:path'

const WSS = 'wss://s.devnet.rippletest.net:51233/'
const EXPLORER = 'https://devnet.xrpl.org/transactions/'
const API = process.env.API ?? 'http://127.0.0.1:8787'
const ROOT = path.resolve(import.meta.dirname, '..')

const SUB_MINUTES = Number(process.env.SUB_MINUTES ?? 5)
const RED_MINUTES = Number(process.env.RED_MINUTES ?? 10)
const COUNT = Number(process.env.COUNT ?? 5)
const ISSUER_ACCOUNT = process.env.ISSUER ?? 'broker'

const COMPANY = {
  name: 'BSA Capital',
  activity: 'Private credit fund manager',
  country: 'FR',
  website: 'bsa.capital',
  contact_email: 'ops@bsa.capital',
}

/** Enough variety that the browse page does not look like five copies. */
const FUNDS = [
  { name: 'BSA Credit Fund I',      ticker: 'BSAF1', subclass: 'private_credit', cap: '2000', fee: 100, desc: 'Senior secured lending to European SMEs' },
  { name: 'Trade Finance Series A', ticker: 'BSATF', subclass: 'private_credit', cap: '1500', fee: 150, desc: 'Short-dated receivables financing' },
  { name: 'Solar Bridge Fund',      ticker: 'BSASL', subclass: 'real_estate',    cap: '3000', fee: 125, desc: 'Bridge loans against commissioned solar assets' },
  { name: 'Treasury Reserve Fund',  ticker: 'BSATR', subclass: 'treasury',       cap: '5000', fee: 50,  desc: 'Short-duration treasury-backed lending' },
  { name: 'Agri Working Capital',   ticker: 'BSAAG', subclass: 'commodity',      cap: '1200', fee: 175, desc: 'Seasonal working capital for agricultural co-ops' },
]

const client = new xrpl.Client(WSS)
const log = (...a) => console.log(...a)
const hex = (s) => Buffer.from(s).toString('hex').toUpperCase()

function loadIssuer() {
  const file = path.join(ROOT, 'data/accounts.json')
  if (!fs.existsSync(file)) {
    throw new Error('data/accounts.json not found. Run `node scripts/01-spike.mjs` first to fund accounts.')
  }
  const seeds = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!seeds[ISSUER_ACCOUNT]) {
    throw new Error(`Account "${ISSUER_ACCOUNT}" not in data/accounts.json (have: ${Object.keys(seeds).join(', ')})`)
  }
  return xrpl.Wallet.fromSeed(seeds[ISSUER_ACCOUNT])
}

async function submit(label, wallet, tx) {
  const res = await client.submitAndWait(wallet.sign(await client.autofill(tx)).tx_blob)
  const code = res.result.meta?.TransactionResult
  if (code !== 'tesSUCCESS') throw new Error(`${label} failed: ${code}`)
  return res.result
}

const created = (result, type) =>
  result?.meta?.AffectedNodes?.map((n) => n.CreatedNode).find((n) => n?.LedgerEntryType === type)

const shareMetadata = (fund) => hex(JSON.stringify({
  ticker: fund.ticker,
  name: `${fund.name} Shares`,
  issuer_name: COMPANY.name,
  asset_class: 'rwa',
  asset_subclass: fund.subclass,
  desc: fund.desc,
  icon: 'https://bsa.capital/icon.png',
}))

async function createFund(issuer, fund, dates) {
  const vaultResult = await submit('VaultCreate', issuer, {
    TransactionType: 'VaultCreate',
    Account: issuer.address,
    Asset: { currency: 'XRP' },
    VaultKind: 1,                     // close-ended
    WithdrawalPolicy: 1,
    SubscriptionDate: dates.subscription,
    RedemptionDate: dates.redemption,
    AssetsMaximum: xrpl.xrpToDrops(fund.cap),
    MPTokenMetadata: shareMetadata(fund),
    Data: hex(JSON.stringify({ name: fund.name, website: COMPANY.website })),
  })
  const vaultNode = created(vaultResult, 'Vault')

  const brokerResult = await submit('LoanBrokerSet', issuer, {
    TransactionType: 'LoanBrokerSet',
    Account: issuer.address,
    VaultID: vaultNode.LedgerIndex,
    ManagementFeeRate: fund.fee,
    DebtMaximum: xrpl.xrpToDrops(fund.cap),
  })

  return {
    vaultId: vaultNode.LedgerIndex,
    shareMptId: vaultNode.NewFields?.ShareMPTID,
    brokerId: created(brokerResult, 'LoanBroker')?.LedgerIndex,
    txHash: vaultResult.hash,
  }
}

/** Best effort: the funds exist on-ledger whether or not the API is up. */
async function publish(pathname, body) {
  const res = await fetch(`${API}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok && res.status !== 409) {
    const detail = await res.json().catch(() => ({}))
    throw new Error(detail.errors?.[0] ?? `HTTP ${res.status}`)
  }
}

async function main() {
  const issuer = loadIssuer()
  await client.connect()
  await client.fundWallet(issuer).catch(() => {})   // top up for reserves

  const balance = await client.getXrpBalance(issuer.address)
  log(`Issuer ${issuer.address}  ${balance} XRP`)

  const t0 = Date.now()
  const dates = {
    subscription: xrpl.unixTimeToRippleTime(t0 + SUB_MINUTES * 60_000),
    redemption: xrpl.unixTimeToRippleTime(t0 + RED_MINUTES * 60_000),
  }
  const at = (m) => new Date(t0 + m * 60_000).toLocaleTimeString()
  log(`Subscription closes ${at(SUB_MINUTES)}  ·  Redemption opens ${at(RED_MINUTES)}`)
  log(`Investment period ${(RED_MINUTES - SUB_MINUTES) * 60}s (ledger minimum 180s)\n`)

  let apiUp = true
  try {
    await publish('/api/companies', { address: issuer.address, ...COMPANY })
  } catch (e) {
    apiUp = false
    log(`API not reachable at ${API} (${e.message}). Funds will be created on-ledger but not listed.\n`)
  }

  const results = []
  for (const fund of FUNDS.slice(0, COUNT)) {
    process.stdout.write(`  ${fund.name.padEnd(26)} `)
    try {
      const out = await createFund(issuer, fund, dates)
      if (apiUp) {
        await publish('/api/vaults', {
          vault_id: out.vaultId,
          company_address: issuer.address,
          loan_broker_id: out.brokerId,
          share_mpt_id: out.shareMptId,
          name: fund.name,
          activity: fund.desc,
          asset_code: 'XRP',
          subscription_date: dates.subscription,
          redemption_date: dates.redemption,
          is_private: false,
          tx_hash: out.txHash,
        }).catch((e) => log(`(not listed: ${e.message}) `))
      }
      results.push({ fund, ...out })
      log(`ok  ${EXPLORER}${out.txHash}`)
    } catch (e) {
      log(`FAILED  ${e.message}`)
    }
  }

  log(`\n${results.length}/${Math.min(COUNT, FUNDS.length)} funds created\n`)
  for (const r of results) {
    log(`${r.fund.name}`)
    log(`  VaultID      ${r.vaultId}`)
    log(`  LoanBrokerID ${r.brokerId}`)
  }
  log(`\nOpen the Invest tab. Deposits accepted until ${at(SUB_MINUTES)}.`)
  await client.disconnect()
}

main().catch(async (e) => {
  console.error(`\n${e.message}`)
  if (client.isConnected()) await client.disconnect()
  process.exitCode = 1
})
