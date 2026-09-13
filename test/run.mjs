/**
 * Unit tests for the pure logic.
 *
 * These modules hold the rules the ledger will not enforce for us — the maturity
 * cascade, the funding window, loan scheduling, zone access, largest-remainder
 * splitting. They have no network or React dependency, so they are the part of
 * the codebase that can be defended in a second rather than a four-minute Devnet
 * run. No framework: node test/run.mjs.
 */
let pass = 0, fail = 0
const eq = (label, actual, expected) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected)
  if (a === e) { pass += 1 } else { fail += 1; console.log(`  FAIL ${label}\n       expected ${e}\n       got      ${a}`) }
}
const ok = (label, cond) => eq(label, !!cond, true)
const group = (name) => console.log(`\n${name}`)

/* ── allocations: the rules the protocol does not check one level up ── */
const A = await import('../api/src/validation/allocations.js')
group('allocation weights')
eq('50/50 accepted', A.validateAllocations([
  { sub_vault_id: 'A'.repeat(64), target_bps: 5000 }, { sub_vault_id: 'B'.repeat(64), target_bps: 5000 }]), [])
ok('must total 100%', A.validateAllocations([{ sub_vault_id: 'A'.repeat(64), target_bps: 9000 }]).length)
ok('rejects duplicates', A.validateAllocations([
  { sub_vault_id: 'A'.repeat(64), target_bps: 5000 }, { sub_vault_id: 'A'.repeat(64), target_bps: 5000 }]).length)
ok('rejects sub-1% slivers', A.validateAllocations([
  { sub_vault_id: 'A'.repeat(64), target_bps: 50 }, { sub_vault_id: 'B'.repeat(64), target_bps: 9950 }]).length)
ok('rejects empty', A.validateAllocations([]).length)

group('maturity cascade')
const sub = (name, red) => ({ vault_id: name, name, redemption_date: red })
eq('all subs redeem before the loan', A.validateMaturityCascade({
  superRedemption: 1000, loanMaturity: 900, subVaults: [sub('a', 800), sub('b', 850)] }), [])
ok('a sub redeeming later is refused', A.validateMaturityCascade({
  superRedemption: 1000, loanMaturity: 900, subVaults: [sub('late', 950)] }).length)
ok('loan may not outlive the super vault', A.validateMaturityCascade({
  superRedemption: 1000, loanMaturity: 1000, subVaults: [sub('a', 800)] }).length)
ok('unknown maturity is refused', A.validateMaturityCascade({
  superRedemption: 1000, loanMaturity: 900, subVaults: [sub('x', null)] }).length)

group('funding window')
eq('sub closes after the super vault', A.validateFundingWindow({
  superSubscription: 100, subVaults: [{ name: 'a', subscription_date: 200 }] }), [])
ok('sub closing first can never be funded', A.validateFundingWindow({
  superSubscription: 200, subVaults: [{ name: 'a', subscription_date: 100 }] }).length)

group('largest-remainder split')
const parts = A.splitAmount('100000001', [
  { sub_vault_id: 'A', target_bps: 3333 }, { sub_vault_id: 'B', target_bps: 3333 }, { sub_vault_id: 'C', target_bps: 3334 }])
eq('parts sum exactly to the whole', parts.reduce((s, p) => s + BigInt(p.amount), 0n).toString(), '100000001')

/* ── zones ── */
const Z = await import('../api/src/lib/zones.js')
group('zones')
eq('every non-empty subset', Z.allCombos().length, 7)
eq('combo key is order-independent', Z.comboKey(['US', 'EU']), Z.comboKey(['EU', 'US']))
eq('valid zones accepted', Z.validateZones(['EU', 'CH']), [])
ok('unknown zone refused', Z.validateZones(['XX']).length)

const ZC = await import('../web/src/lib/zones.js')
group('zone access')
eq('an ungated fund admits anyone', ZC.zoneAccess([], []).allowed, true)
eq('holding one accepted zone is enough', ZC.zoneAccess(['EU', 'CH'], [{ zone: 'CH', accepted: true }]).allowed, true)
eq('an unaccepted credential is not enough', ZC.zoneAccess(['EU'], [{ zone: 'EU', accepted: false }]).allowed, false)
eq('it is reported as pending, not missing', ZC.zoneAccess(['EU'], [{ zone: 'EU', accepted: false }]).pending, ['EU'])
eq('the wrong zone does not admit', ZC.zoneAccess(['US'], [{ zone: 'EU', accepted: true }]).allowed, false)

/* ── loan scheduling: a loan past maturity can never be repaid ── */
const S = await import('../web/src/lib/superVault.js')
group('loan schedule')
const now = Date.now(), rt = (m) => Math.floor((now + m * 60000) / 1000) - 946684800
ok('refuses a maturity with no room to unwind', S.loanSchedule({ maturityRippleTime: rt(2), nowMs: now }).error)
ok('refuses a missing maturity', S.loanSchedule({ maturityRippleTime: null, nowMs: now }).error)
const sched = S.loanSchedule({ maturityRippleTime: rt(30), nowMs: now })
eq('final payment lands on the maturity', Math.round((sched.finalPaymentMs - now) / 60000), 30)
// The whole point: nothing is owed before the sub-funds have returned the capital.
eq('the curator loan is a single bullet payment', sched.PaymentTotal, 1)
eq('so its only due date is the maturity', Math.round(sched.PaymentInterval / 60), 30)
ok('interval respects the 60s floor', sched.PaymentInterval >= 60)
ok('grace respects the 60s floor', sched.GracePeriod >= 60)
ok('grace never exceeds the interval', sched.GracePeriod <= sched.PaymentInterval)

/**
 * The hardcoded schedule has now been written twice: once in deployAll and once
 * in borrow, the two-wallet path, which was missed when the first was fixed.
 * Both produce a loan that matures minutes after origination and can never be
 * repaid (tecEXPIRED). This guards the call sites, not just the helper.
 */
{
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../web/src/hooks/useSuperVaultDeploy.js', import.meta.url), 'utf8')
  const literals = [...src.matchAll(/Payment(?:Interval|Total)\s*:\s*\d/g)].map((m) => m[0])
  eq('no curator loan schedule is hardcoded', literals, [])
  eq('both LoanSet call sites derive their schedule',
    (src.match(/PaymentInterval: schedule\.PaymentInterval/g) ?? []).length, 2)
}

/* ── target vs realised yield ── */
const Y = await import('../web/src/lib/yield.js')
group('yield')
eq('1% is 1000 rate units', Y.pctToRate('1'), 1000)
eq('the ledger ceiling is 100%', Y.rateToPct(Y.MAX_RATE), 100)
eq('formats to two places', Y.formatRate(9400), '9.40%')
eq('an absent rate is a dash, not zero', Y.formatRate(null), '—')

const HOUR = 3600_000
eq('nothing to measure before capital is at work',
  Y.realisedYield({ pps: 1, since: Date.now() + 1000, nowMs: Date.now() }), null)
{
  // A vault a year old whose price per share doubled returned 100%.
  const r = Y.realisedYield({ pps: 2, since: 0, nowMs: 365 * 24 * HOUR })
  eq('a doubled price per share over a year is 100% APY', Math.round(r.apy * 100), 100)
  ok('a year is long enough to annualise', r.reliable)
}
{
  // The demo case: a tiny gain over six minutes annualises to a large number.
  const r = Y.realisedYield({ pps: 1.00000128, since: 0, nowMs: 6 * 60_000 })
  ok('a six minute sample is flagged unreliable', !r.reliable)
  ok('but the gain itself is still reported', r.gain > 0)
}
eq('gain reads as a signed percentage', Y.formatGain(0.0000128), '+0.0013%')

group('super vault blend')
const bps = (id, target_bps) => ({ sub_vault_id: id, target_bps })
{
  const b = Y.blendedTarget([bps('a', 5000), bps('b', 5000)], (id) => ({ a: 8000, b: 10000 }[id]))
  eq('50/50 of 8% and 10% blends to 9%', b.rate, 9000)
  ok('fully covered', b.complete)
}
{
  // Half the allocation published no target: blend what is known, say so.
  const b = Y.blendedTarget([bps('a', 5000), bps('b', 5000)], (id) => (id === 'a' ? 8000 : null))
  eq('an unpublished sub-fund is excluded, not counted as zero', b.rate, 8000)
  ok('and the gap is reported', !b.complete)
  eq('coverage is the weight that answered', b.coverage, 0.5)
}
eq('no allocations means no blend', Y.blendedTarget([], () => 5000), null)
eq('no published targets means no blend', Y.blendedTarget([bps('a', 10000)], () => null), null)

group('weights and NAV')
eq('50/50 accepted', S.weightErrors([{ target_bps: 5000 }, { target_bps: 5000 }]), [])
ok('90% refused', S.weightErrors([{ target_bps: 9000 }]).length)
eq('unfunded positions are worth zero, not unknown',
  S.aggregateNav([{ value: 0 }, { value: 100, lastLedger: 5 }]), { total: 100, counted: 2, missing: 0, stalestLedger: 5 })
eq('unreadable positions are counted as missing',
  S.aggregateNav([{ value: null }, { value: 100, lastLedger: 5 }]).missing, 1)

/* ── list shaping ── */
const F = await import('../web/src/lib/vaultFilters.js')
group('fund browser')
const v = (name, issuer, phase, assets, at, ends) => ({
  vault_id: name, name, company_address: issuer, company_name: issuer, created_at: at,
  phase: phase ? { phase, endsAt: ends } : null, vault: { AssetsTotal: String(assets) } })
const list = [v('a','rA','Subscription',300,'3',5000), v('b','rA','Investment',900,'2',9000),
              v('c','rB','Subscription',100,'1',2000)]
eq('open filter', F.filterVaults(list, { phase: 'open' }).map((x) => x.name), ['a','c'])
eq('issuer filter', F.filterVaults(list, { phase: 'all', issuer: 'rB' }).map((x) => x.name), ['c'])
eq('closing soonest first', F.sortVaults(list, 'closing').map((x) => x.name), ['c','a','b'])
eq('most raised first', F.sortVaults(list, 'raised').map((x) => x.name), ['b','a','c'])
eq('input is not mutated', list.map((x) => x.name), ['a','b','c'])

/* ── series naming ── */
const R = await import('../web/src/lib/relaunch.js')
group('next series')
eq('roman numerals', R.nextSeriesName('Credit Fund I'), 'Credit Fund II')
eq('roman rollover', R.nextSeriesName('Credit Fund IX'), 'Credit Fund X')
eq('lettered series', R.nextSeriesName('Trade Finance Series A'), 'Trade Finance Series B')
eq('trailing digits', R.nextSeriesName('Working Capital 2'), 'Working Capital 3')
eq('no marker appends II', R.nextSeriesName('Solar Bridge Fund'), 'Solar Bridge Fund II')

/* ── profile validation ── */
const P = await import('../api/src/validation/profiles.js')
group('profiles')
eq('a real address passes', P.validateAddress('rBW7CwNfjKiamdn6YRhiQvr1krcAuDmWW7'), null)
ok('a malformed address fails', P.validateAddress('nope'))
ok('country must be ISO-2', P.validateCountry('France'))
eq('ISO-2 accepted', P.validateCountry('fr'), null)
ok('nested validator output is flattened', P.collect(['a', 'b'], null, 'c').every((x) => typeof x === 'string'))

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
