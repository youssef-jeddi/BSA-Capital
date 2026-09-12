#!/usr/bin/env node
/**
 * Stands up a full liquidity-marketplace scenario on Devnet, ready to trade in the
 * Marketplace tab. Same code the UI's "Run demo scenario" button calls.
 *
 *   node scripts/22-demo-scenario.mjs
 *   node scripts/22-demo-scenario.mjs --holder rYOURADDRESS   # also credential your wallet
 */
import { ledger } from './lib/issuer.mjs'
import { runScenario } from './lib/scenario.mjs'

const i = process.argv.indexOf('--holder')
runScenario({ holder: i > 0 ? process.argv[i + 1] : null })
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(async () => (await ledger()).disconnect())
