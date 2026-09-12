# Liquidity marketplace — handover

Branch: `feature/credentials-onboarding-digital-identity-wallet`
Devnet, verified 2026-09-12. Everything below was measured, not inferred from specs.

This branch is a **working sandbox**, deliberately isolated from the Broker/Depositor/
Borrower tabs. It is not integrated with `main`, which has since diverged substantially
(see [Integrating with main](#integrating-with-main)).

---

## 1. The problem it solves

A closed-ended vault has three phases. During **Investment** an LP cannot redeem —
`VaultWithdraw` returns `tecTOO_SOON` — but the shares still exist and still have a
computable value. The LP is locked in with an illiquid asset.

The marketplace lets that LP sell the position at a discount to NAV, to a buyer the
ledger considers eligible.

## 2. Proven ledger rules

These cost real time to establish and are not in the docs we could find.

### Share transfers

| test | result |
|---|---|
| `VaultWithdraw` during Investment | `tecTOO_SOON` — LP genuinely locked |
| `Payment`(share MPT) during Investment | **`tesSUCCESS`** — the market is possible |
| `Payment`(shares) → uncredentialed account | `tecNO_AUTH` |
| `Payment`(shares) → credentialed, not opted in | `tecNO_AUTH` |
| `Payment`(shares) → credentialed **and** opted in | `tesSUCCESS` |
| `MPTokenAuthorize` by an uncredentialed account | `tesSUCCESS` — **opt-in is permissionless** |

**To receive private-vault shares an account needs BOTH:**
1. an accepted credential in the vault's permissioned domain, **and**
2. its own `MPTokenAuthorize` opt-in on the `ShareMPTID`.

**Why there is no issuer-side authorize.** The share issuer is the vault's
**pseudo-account**, which has no keys and can never sign `MPTokenAuthorize(Holder)`.
The ledger substitutes the **domain membership check** for issuer authorization — which
is why `DomainID` lives on the share `MPTokenIssuance`, not on the `Vault`. So
"authorising a buyer" means *issuing them a credential*. There is no MPT-level step for
the issuer to perform.

Consequence for any UI: **an existing `MPToken` object proves nothing.** Opt-in is
permissionless and the gate is only enforced at payment time, so eligibility must be
checked explicitly.

### Why settlement is a custody account, not the DEX

MPTs cannot be traded on the order book at all:

```
OfferCreate  TakerGets {mpt_issuance_id, value}              -> temDISABLED
OfferCreate  same + DomainID  (permissioned DEX, XLS-81)     -> temDISABLED
```

`lsfMPTCanTrade` is set on the issuance but the logic is switched off on Devnet. So the
permissioned DEX — which would otherwise be the ideal fit, since offers carry a
`DomainID` — is not an option. Hence a custody account.

`Batch` / `AtomicBatch` are **absent** on Devnet, so a buy cannot be made atomic.
`TokenEscrow` **is** enabled and the share MPT has `lsfMPTCanEscrow`, but escrow needs a
fixed `Destination` and the buyer is unknown at listing time, so it does not fit either.

### Why NAV barely moves in a demo

`InterestRate` is annual in 1/10th bps; `periodicRate = (rate/1e6) × PaymentInterval / 31_536_000`.

- `InterestRate` is capped at **100000** (10% annual). Above it:
  `"InterestRate must be between 0 and 100000 inclusive"`.
- At the cap, a 20-minute loan on 40 XRP accrues interest that **rounds to 0 drops**.
- `PaymentInterval` of 30 or 365 days is refused `tecNO_PERMISSION`: a loan may not
  outlive the vault's `RedemptionDate`.
- `LoanOriginationFee` accrues to the **broker**, not the vault — `AssetsTotal` unchanged.

So NAV moves only on `LoanPay`, and only slightly: the scenario observes
`1 -> 1.00000761` (761 drops on a 100 XRP vault). A percentage-scale rise needs roughly
**91 days** of loan term at the rate ceiling. This does not affect the marketplace — the
discount is quoted against whatever NAV the vault reports.

---

## 3. What is on the branch

```
scripts/lib/marketplace.mjs      the marketplace core
scripts/lib/issuer.mjs           master account + XLS-70 credential issuance
scripts/lib/scenario.mjs         end-to-end scenario builder (CLI and UI share it)
scripts/lib/eudi.mjs             EU reference verifier, called directly (no auth)
scripts/lib/edelid.mjs           Edel-ID gateway path (VERIFY_PROVIDER=edelid)
scripts/lib/claims.mjs           claim flattening + calendar-correct age derivation

scripts/10-master-account.mjs    create + fund the master (credential issuer)
scripts/20-share-transfer-spike.mjs   proves every rule in section 2
scripts/21-setup-custody.mjs     create + fund + credential the custody account
scripts/22-demo-scenario.mjs     thin CLI wrapper over scenario.mjs

web/dev-api.js                   Vite dev-only middleware exposing the above over HTTP
web/src/components/Identity.jsx  EUDI verification -> on-chain KYC credential
web/src/components/Marketplace.jsx  listings, buy, sell, cancel, scenario runner
```

Accounts live in the gitignored root `.env`:
`MASTER_ADDRESS/MASTER_SEED` (credential issuer), `CUSTODY_ADDRESS/CUSTODY_SEED`.
Listings live in `data/listings.json` (gitignored).

### `scripts/lib/marketplace.mjs`

| function | does |
|---|---|
| `custody()` | the custody `Wallet` from `CUSTODY_SEED` |
| `submit(wallet, tx)` | submit, never throw; returns `{ok, code, hash}` |
| `vaultSnapshot(vaultId)` | `{shareMPTID, domainID, navDrops, phase, assetsTotal, assetsAvailable, outstanding, transferable, subscriptionMs, redemptionMs}` |
| `eligibility(account, shareMPTID, domainID)` | `{credentialed, optedIn, ready}` — the two gates, checked separately |
| `ensureCustodyOptedIn(shareMPTID)` | custody's `MPTokenAuthorize`, idempotent |
| `verifyShareTransfer(hash, {...})` | re-reads the tx; asserts destination, MPT id, amount, result |
| `verifyXrpPayment(hash, {...})` | same for the buyer's cash leg |
| `createListing({vaultId, shares, askDrops, transferHash})` | verifies then records |
| `settleListing(id, {paymentHash})` | verifies payment, re-checks eligibility, custody delivers shares |
| `cancelListing(id)` | custody returns shares to the seller |
| `strandedShares(shareMPTID)` | `{held, listed, stranded}` — see below |
| `listings()` / `listing(id)` / `saveListing(row)` | the JSON store |

**`submit()` resolves a genuine failure mode.** `submitAndWait` can throw *after* the
transaction has applied (dropped socket, expired `LastLedgerSequence`). In a marketplace
that is the worst ambiguity: shares move, no listing is recorded, and they strand in
custody — which happened on the first scenario run (10,000,000 shares). `submit()` now
fixes the hash at signing time and, on any error, asks the ledger what actually
happened. `strandedShares()` surfaces any residue.

### `scripts/lib/issuer.mjs`

`master()`, `ledger()`, `findCredential(subject, typeHex)`,
`issueCredential({subject, credentialType, uri})`, `toHex()`, `CREDENTIAL_TYPE`
(`KYC_EUDI_18PLUS`).

`issueCredential` returns `{already: true}` rather than resubmitting a duplicate
(`tecDUPLICATE`), because a user clicking twice is normal. **Its `uri` must never carry
personal data** — it holds a pointer to the off-chain verification
(`edel-id:eu:<verificationId>`), never the name or birthdate. The ledger is permanent
and world-readable.

### Identity: `scripts/lib/eudi.mjs`

Calls `verifier-backend.eudiw.dev` directly — **no auth, no API key**.
`POST /ui/presentations` → `{transaction_id, client_id, request_uri}`; the deep link is
**not** returned and must be assembled; `GET /ui/presentations/{id}` answers **400 with an
empty body** until the wallet responds (that is "not ready", not an error).

Two things that cost time:
- `response_mode` defaults to `direct_post.jwt`, which obliges the wallet to
  **JARM-encrypt** its response. A wallet that cannot (Procivis, error `BR_0395`) builds
  the presentation then fails POSTing it, and the verifier answers 400. We send
  `response_mode: direct_post`. Configurable via `EUDI_RESPONSE_MODE`.
- The EUDI PID carries **`birthdate` and no `age_over_18`**, so the age is derived. The
  mdoc PID spells it `birth_date` and namespaces claims under
  `eu.europa.ec.eudi.pid.1.*`. `ageFrom()` uses calendar arithmetic — a ms-diff is wrong
  on the birthday itself, the one day an 18+ check changes answer.

---

## 4. HTTP surface (`web/dev-api.js`)

Dev-only: a Vite plugin with `apply: 'serve'`. It reads the root `.env` in Node so
neither the org client secret nor the master/custody seeds ever reach the browser bundle.

```
GET  /dev-api/issuer                              issuer address + CredentialType hex
POST /dev-api/verification                        start an EUDI presentation
GET  /dev-api/verification/:id                    poll -> {state, claims, age, over18}
GET  /dev-api/credential?subject=r...             does this account hold ours?
POST /dev-api/credential                          master issues CredentialCreate

GET  /dev-api/market                              listings + live NAV + discount
GET  /dev-api/market/vault/:id                    vaultSnapshot
GET  /dev-api/market/eligibility?vault=&account=  the two gates
GET  /dev-api/market/stranded?vault=              custody residue
POST /dev-api/market/prepare                      custody opts in to the share MPT
POST /dev-api/market/listings                     record a verified listing
POST /dev-api/market/listings/:id/settle          verify payment, deliver shares
POST /dev-api/market/listings/:id/cancel          return shares to seller
POST /dev-api/market/scenario                     run a scenario (detached)
GET  /dev-api/market/scenario                     follow its log
```

## 5. The flows

**Sell** — `POST /market/prepare` (custody opts in) → seller signs
`Payment(shares → custody)` in their own wallet → `POST /market/listings` with the hash,
which is verified on-ledger before the listing exists.

**Buy** — buyer needs a credential (Identity tab) and then `MPTokenAuthorize` → buyer
signs `Payment(askDrops → seller)` → `POST .../settle` verifies that payment, re-checks
eligibility, and custody releases the shares.

Two deliberate properties:
- **Custody holds only the shares, never the cash.** The buyer pays the seller directly.
- **Eligibility is re-checked immediately before the shares move.** With no `Batch`
  amendment the legs cannot be atomic, so a `tecNO_AUTH` at that point would leave a
  buyer paid and empty-handed.

## 6. Running it

```bash
node scripts/10-master-account.mjs     # once — credential issuer
node scripts/21-setup-custody.mjs      # once — custody, funded + credentialed
node scripts/22-demo-scenario.mjs      # ~2 min, repeatable
npm run dev --prefix web               # then the Marketplace tab
```

The scenario builds: credentials + domain, a private closed-ended vault, three LPs
subscribing, the phase flip (alice's `VaultWithdraw` refused on the record), a two-party
`LoanSet` + `LoanPay`, and two discounted listings. An uncredentialed `outsider` is left
over for negative testing. `DEMO_WINDOW_SECONDS` (default 7200) controls how long the
vault stays in Investment — **past it the vault reaches Redemption and the premise no
longer holds**, so scenarios age out and must be re-run.

Pre-demo check: `curl -s localhost:5173/dev-api/market | grep -o '"phase":"[^"]*"' | head -1`

---

## 7. Integrating with main

`main` has moved on and this branch has **not** been merged. Overlapping files:
`package.json`, `web/src/App.jsx`, `web/src/styles.css`, `web/vite.config.js`.

What changed on main that matters:

1. **There is now a real backend** — `api/`, Fastify on `:8787`, SQLite via
   `better-sqlite3`, layered `routes/ → services/ → repositories/ → db/`. Vite proxies
   `/api` to it.
   → **`web/dev-api.js` should not survive the merge.** Port it: `scripts/lib/marketplace.mjs`
   becomes `api/src/services/marketplace.js`, the JSON store becomes
   `api/src/repositories/listings.js` over SQLite, and the routes become
   `api/src/routes/marketplace.js` in Fastify style. The lib is already free of any
   HTTP or Vite coupling, so this is a mechanical move.

2. **Tabs are now role-based** — `TABS_BY_ROLE` driven by `useProfile()`, not a flat
   `TABS` array. The Identity and Marketplace tabs must be placed into the role map
   rather than appended.

3. **`web/src/components/Depositor.jsx` was deleted**, replaced by
   `components/vaults/Invest.jsx`. Nothing here depends on it, but the Marketplace tab's
   copy references the Depositor tab by name.

4. **Onboarding already exists** — `components/onboarding/` plus `users`/`companies`
   repositories with a `status` field. This **overlaps with the Identity tab**. The
   natural join: an EUDI verification plus the on-chain credential is what flips an
   onboarding record to approved, so the two should become one flow rather than two.

5. `main`'s `package.json` does not have `qrcode` (this branch added it for QR rendering)
   and has different scripts.

## 8. Known gaps

- **Not integrated with main** — see above. This is the main task.
- **Partial fills are not supported.** A listing is all-or-nothing; custody holds the
  whole lot. The store already keys by transfer hash, so splitting is additive work.
- **No fee.** The marketplace takes nothing.
- **The custody credential is per-domain.** `21-setup-custody.mjs` credentials custody
  with the master's `KYC_EUDI_18PLUS`, so it can only hold shares of vaults whose domain
  accepts that pair. In production every permissioned vault created on the platform would
  need to mint one for custody.
- **The demo vault's domain differs from the spike's.** `scripts/01-spike.mjs` authorises
  `{issuer from data/accounts.json, KYC_TIER1}`; this branch uses
  `{MASTER_ADDRESS, KYC_EUDI_18PLUS}`. Wiring the Identity credential into the *existing*
  vaults means re-running `PermissionedDomainSet` with the master's credential.
- **Listings are off-ledger** (a JSON file). A listing is an intent, not ledger state, but
  nothing reconstructs listings from the ledger if that file is lost — only
  `strandedShares()` tells you something is unaccounted for.
- **Edel-ID gateway is unreachable** (`*.edel-id.app`, all ports filtered). Irrelevant
  while `VERIFY_PROVIDER` defaults to `eudi`.
