/**
 * Print the exact date-time values to paste into the forms, for a chosen demo.
 *
 * Getting these right by hand is fiddly and the failures are silent until much
 * later: a sub-fund that closes before the super vault stops raising can never
 * be funded, and a loan that matures before its sub-funds redeem can never be
 * repaid. The offsets below encode those orderings once.
 *
 *   node scripts/plan-times.mjs              reallocation demo
 *   node scripts/plan-times.mjs fund         a single plain fund
 *   node scripts/plan-times.mjs supervault   super vault through to repayment
 */
const PLANS = {
  fund: {
    title: 'One plain fund, borrow and repay',
    note: 'Investment window must be at least 180s; this gives 8 minutes.',
    rows: [
      ['Fund', 'Subscription closes', 6, 'deposit before this'],
      ['Fund', 'Redemption opens', 14, 'withdraw after this'],
    ],
    clock: [
      [0, 'register, launch the fund with a first-loss amount so a broker is created'],
      [1, 'second wallet registers, deposits'],
      [6, 'fund locks — Withdraw now returns tecTOO_SOON'],
      [7, 'borrower requests a draw, curator counter-signs, borrower repays'],
      [14, 'redemption opens, depositor withdraws'],
    ],
  },

  supervault: {
    title: 'Super vault, deploy through to repayment',
    note: 'Sub-funds close AFTER the super vault, and redeem BEFORE the loan matures.',
    rows: [
      ['Super vault', 'Subscription closes', 4, 'must be before the sub-funds close'],
      ['Super vault', 'Redemption opens', 40, 'must be after the loan matures'],
      ['Super vault', 'Loan maturity', 30, 'must be after every sub-fund redeems'],
      ['Sub-fund A', 'Subscription closes', 9, ''],
      ['Sub-fund A', 'Redemption opens', 18, 'redeem here, then repay'],
      ['Sub-fund B', 'Subscription closes', 9, ''],
      ['Sub-fund B', 'Redemption opens', 18, ''],
    ],
    clock: [
      [0, 'launch both sub-funds, then the super vault'],
      [1, 'depositor subscribes to the super vault'],
      [4, 'super vault locks — deploy capital into the funds'],
      [18, 'sub-funds redeem — Unwind: redeem positions'],
      [19, 'repay the curator loan, price per share steps up'],
    ],
  },

  reallocation: {
    title: 'Reallocation: sell a locked position, redeploy the cash',
    note: 'A closes early so it locks; C stays open so it can still take a deposit.',
    rows: [
      ['Super vault', 'Subscription closes', 3, 'before the sub-funds close'],
      ['Super vault', 'Redemption opens', 50, ''],
      ['Super vault', 'Loan maturity', 45, 'after both sub-funds redeem'],
      ['Fund A (source)', 'Subscription closes', 6, 'locks here, which is the point'],
      ['Fund A (source)', 'Redemption opens', 40, ''],
      ['Fund C (target)', 'Subscription closes', 35, 'still raising when you redeploy'],
      ['Fund C (target)', 'Redemption opens', 40, ''],
    ],
    clock: [
      [0, 'launch A, then C, then the super vault allocating 100% to A'],
      [1, 'depositor subscribes to the super vault'],
      [3, 'super vault locks — deploy capital into A'],
      [6, 'A locks. Its position can no longer be withdrawn, only sold'],
      [7, 'curator: Reallocate on the A row, sell at a 2% discount'],
      [8, 'third wallet buys the listing in Invest > Shares marketplace'],
      [9, 'curator: Redeploy into C. Done'],
    ],
  },
}

const pad = (n) => String(n).padStart(2, '0')
/** Exactly what a datetime-local input expects, in the browser's timezone. */
const field = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

const key = process.argv[2] ?? 'reallocation'
const plan = PLANS[key]
if (!plan) {
  console.error(`Unknown plan "${key}". Try: ${Object.keys(PLANS).join(', ')}`)
  process.exit(1)
}

// Round up to the next whole minute so the pasted values are never already past.
const t0 = Math.ceil(Date.now() / 60_000) * 60_000

console.log(`\n${plan.title}`)
console.log(`Starting from ${clock(t0)}. ${plan.note}\n`)

let last = null
for (const [where, label, min, why] of plan.rows) {
  if (where !== last) { console.log(`  ${where}`); last = where }
  console.log(`    ${label.padEnd(22)} ${field(t0 + min * 60_000)}   ${clock(t0 + min * 60_000)}`
    + (why ? `   ${why}` : ''))
}

console.log('\n  What happens when')
for (const [min, what] of plan.clock) {
  console.log(`    ${clock(t0 + min * 60_000).padEnd(8)} ${what}`)
}
console.log('\n  Paste the values in the middle column straight into the date fields.\n')
