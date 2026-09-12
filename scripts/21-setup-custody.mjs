#!/usr/bin/env node
/**
 * Creates the marketplace custody account on XRPL Devnet and credentials it.
 *
 * Custody holds listed shares between listing and sale, so it must be a member of
 * the vault's permissioned domain — `DomainID` sits on the share MPTokenIssuance, and
 * a non-member is refused the shares with `tecNO_AUTH`. So it needs the same KYC
 * credential we issue to users. In production every permissioned vault created on the
 * platform would mint one of these for custody.
 *
 * The per-vault `MPTokenAuthorize` opt-in is not done here — it happens lazily when
 * the first listing for a given vault is created, since it is per share MPT.
 *
 *   node scripts/21-setup-custody.mjs           create if absent
 *   node scripts/21-setup-custody.mjs --force   replace (abandons held shares)
 */
import fs from 'node:fs'
import path from 'node:path'
import { Wallet } from 'xrpl'
import { ledger, master, toHex, CREDENTIAL_TYPE, findCredential } from './lib/issuer.mjs'
import { submit } from './lib/marketplace.mjs'

const ENV = path.join(path.resolve(import.meta.dirname, '..'), '.env')
const force = process.argv.includes('--force')

const upsert = (text, key, value) => {
  const re = new RegExp(`^${key}=.*$`, 'm')
  return re.test(text)
    ? text.replace(re, `${key}=${value}`)
    : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${key}=${value}\n`
}

async function main() {
  let text = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : ''
  const existing = /^CUSTODY_SEED=(.+)$/m.exec(text)?.[1]?.trim()

  const c = await ledger()
  let cust
  if (existing && !force) {
    cust = Wallet.fromSeed(existing)
    console.log(`Custody already in .env: ${cust.address}`)
  } else {
    console.log('Funding a custody account from the Devnet faucet...')
    const { wallet } = await c.fundWallet()
    cust = wallet
    text = upsert(text, 'CUSTODY_ADDRESS', cust.address)
    text = upsert(text, 'CUSTODY_SEED', cust.seed)
    fs.writeFileSync(ENV, text, { mode: 0o600 })
    console.log(`  ${cust.address}  (written to .env)`)
  }

  console.log(`\nCredentialling custody with ${CREDENTIAL_TYPE} from the master...`)
  const typeHex = toHex(CREDENTIAL_TYPE)
  const held = await findCredential(cust.address, typeHex)

  if (held?.accepted) {
    console.log('  already holds an accepted credential')
  } else {
    if (!held) {
      const r = await submit(master(), {
        TransactionType: 'CredentialCreate', Account: master().address,
        Subject: cust.address, CredentialType: typeHex,
      })
      console.log(`  CredentialCreate  ${r.code}`)
      if (!r.ok) throw new Error(`CredentialCreate ${r.code}`)
    }
    const a = await submit(cust, {
      TransactionType: 'CredentialAccept', Account: cust.address,
      Issuer: master().address, CredentialType: typeHex,
    })
    console.log(`  CredentialAccept  ${a.code}`)
    if (!a.ok) throw new Error(`CredentialAccept ${a.code}`)
  }

  console.log(`\n  custody  ${cust.address}   ${await c.getXrpBalance(cust.address)} XRP`)
  console.log(`  issuer   ${master().address}`)
  console.log(`\nCustody can hold shares of any vault whose domain accepts`)
  console.log(`  { Issuer: ${master().address}, CredentialType: ${CREDENTIAL_TYPE} }`)
  console.log(`  https://devnet.xrpl.org/accounts/${cust.address}`)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
  .finally(async () => (await ledger()).disconnect())
