# Liquidity marketplace — implementation plan on top of `main`

Read [`MARKETPLACE.md`](./MARKETPLACE.md) first: it holds the **measured ledger rules**.
Respect them or the feature does not work. This file is the ordered plan for porting the
sandbox on `feature/credentials-onboarding-digital-identity-wallet` onto current `main`.

The logic already exists and is proven on Devnet. **This is a port, not a design task.**
`scripts/lib/*.mjs` has no HTTP or Vite coupling, so most of it moves unchanged.

---

## The one architectural decision

`main`'s API deliberately does not touch the ledger — `schema.sql` says *"On-chain state
(phase, assets, price per share) is never cached here: it is read live from the ledger and
joined in the client."*

**The marketplace must break that rule, and only that rule.** Two reasons, both
non-negotiable:

1. **Custody signs.** Releasing or returning shares is a `Payment` from the custody
   account, so the server holds `CUSTODY_SEED`. This cannot move to the browser.
2. **Verification cannot be client-trusted.** A browser reporting "I paid the seller" is
   a claim. The server re-reads the transaction and checks destination, amount, MPT id and
   result code before releasing shares.

So `api/` gains an XRPL client. Keep the existing convention everywhere else: NAV and
phase are still **read live, never cached** in SQLite.

---

## Phase 0 — merge

```bash
git checkout feature/credentials-onboarding-digital-identity-wallet
git merge origin/main
```

Four files conflict. Resolve as follows:

| file | resolution |
|---|---|
| `web/vite.config.js` | take **main's** (keep the `/api` proxy). **Drop `devApi()`** — it is replaced in Phase 2. |
| `web/src/App.jsx` | take **main's** role-based `TABS_BY_ROLE`. Re-add our two tabs into the role map (Phase 5). |
| `web/src/styles.css` | keep both — our additions are appended blocks (`.qr`, `.verdict`, `.listing`, `.scenariolog`). |
| `package.json` | take **main's** scripts, keep the `qrcode` dependency. |

Then delete `web/dev-api.js`. Everything it did moves to `api/`.

Note `web/src/components/Depositor.jsx` is gone on main (now `components/vaults/Invest.jsx`);
`Marketplace.jsx` mentions "Depositor tab" in copy — update the wording.

## Phase 1 — move the libraries into `api/`

```bash
cd api && npm i xrpl@5.2.0-beta.1 qrcode
```

Move, keeping the code as-is:

```
scripts/lib/marketplace.mjs  ->  api/src/services/marketplace.js
scripts/lib/issuer.mjs       ->  api/src/services/issuer.js
scripts/lib/eudi.mjs         ->  api/src/services/eudi.js
scripts/lib/claims.mjs       ->  api/src/services/claims.js
scripts/lib/scenario.mjs     ->  api/src/services/scenario.js
```

Two edits only:

1. **Replace the JSON store** — `listings()`, `listing()`, `saveListing()` and the
   `fs`/`STORE` constants come out; call the repository from Phase 2 instead. Every other
   function is untouched.
2. **Wrap the public entry points in main's result convention** so routes stay dumb:

```js
const fail = (status, ...errors) => ({ ok: false, status, errors: errors.flat() })
const ok = (data) => ({ ok: true, data })
```

Keep `scripts/lib/*` as thin re-exports so `scripts/20/21/22-*.mjs` keep working — those
spikes are the regression suite for the ledger rules and should not rot.

**Env** — `api/` reads `MASTER_SEED`, `CUSTODY_SEED`, `EUDI_*`, `DEMO_WINDOW_SECONDS`
from the root `.env` (gitignored). `api/src/db/index.js` already resolves paths relative
to itself; do the same for `.env`.

## Phase 2 — schema and repository

Append to `api/src/db/schema.sql`:

```sql
-- Secondary-market listings for locked vault shares. A listing is an intent, so it
-- lives here rather than on-chain; every leg that moves value is a transaction and is
-- recorded by hash. NAV is never stored: it is read live, like all on-chain state.
CREATE TABLE IF NOT EXISTS listings (
  id             TEXT PRIMARY KEY,          -- first 16 chars of transfer_hash
  vault_id       TEXT NOT NULL,
  share_mpt_id   TEXT NOT NULL,
  domain_id      TEXT,                      -- null for a public vault
  seller_address TEXT NOT NULL,
  shares         TEXT NOT NULL,             -- integer as TEXT; exceeds 2^53
  ask_drops      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open',   -- open | sold | cancelled
  buyer_address  TEXT,
  transfer_hash  TEXT NOT NULL,             -- seller -> custody, verified on-ledger
  payment_hash   TEXT,                      -- buyer -> seller
  delivery_hash  TEXT,                      -- custody -> buyer
  return_hash    TEXT,                      -- custody -> seller on cancel
  created_at     TEXT NOT NULL,
  settled_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_vault  ON listings(vault_id);
```

`shares` and `ask_drops` are **TEXT**: a 50 XRP position is 50,000,000 shares and share
counts exceed what SQLite integers and JS numbers handle safely together.

`api/src/repositories/listings.js`, mirroring `repositories/vaults.js`:

```js
findById(id) · list({ status, vaultId }) · insert(row) · update(id, fields)
openForShareMpt(shareMptId)   // for strandedShares()
```

## Phase 3 — routes

`api/src/routes/marketplace.js`, registered in `server.js` alongside the others:

```
GET  /api/market/listings                              live NAV + discount joined in
GET  /api/market/vaults/:vaultId                       vaultSnapshot
GET  /api/market/eligibility/:vaultId/:address         { credentialed, optedIn, ready }
POST /api/market/prepare            { vault_id }       custody opts in to the share MPT
POST /api/market/listings           { vault_id, shares, ask_drops, transfer_hash }
POST /api/market/listings/:id/settle { payment_hash }
POST /api/market/listings/:id/cancel
GET  /api/market/stranded/:vaultId
```

Credentials (from the Identity work):

```
GET  /api/credentials/issuer
POST /api/credentials            { subject }           master issues CredentialCreate
GET  /api/credentials/:address
POST /api/verification                                 start an EUDI presentation
GET  /api/verification/:id                             poll -> { state, claims, age, over18 }
```

Then one function per endpoint in `web/src/lib/api.js`, following its existing style.

**Two invariants the routes must not lose** (both already in the service):

- `settleListing` verifies the payment **and re-checks buyer eligibility** immediately
  before custody moves the shares. `Batch` does not exist on Devnet, so the legs are not
  atomic — a `tecNO_AUTH` at that moment leaves a buyer paid and empty-handed.
- `createListing` verifies the share transfer on-ledger **before** the row is written.

## Phase 4 — the scenario runner

`runScenario({ log, holder })` already takes a log callback. Keep it detached with the
same two endpoints; a run takes ~2 minutes because it funds five accounts and waits out a
real Subscription window.

```
POST /api/market/scenario   { holder }   -> { started: true }
GET  /api/market/scenario                -> { running, log: [...], summary, error }
```

In-memory job state is fine. Better: write the summary into `vaults` via
`recordVault()` so the demo vault appears in main's own fund list — which makes the
scenario useful beyond the marketplace tab.

## Phase 5 — UI

**Tabs.** `main` uses `TABS_BY_ROLE` driven by `useProfile()`. Add:

- `{ id: 'market', label: 'Liquidity' }` — **both** roles. A company sells locked
  positions, a user buys them; the tab handles both sides already.
- Identity does **not** get its own tab. Fold it into onboarding (Phase 6).

**`Marketplace.jsx`** carries over nearly unchanged. Repoint it at `lib/api.js`
instead of its own `fetch` helper, and keep the three UI states that matter:

1. no accepted credential → send the user to verification, do not offer Buy
2. credential but no `MPToken` → an explicit **Opt in** button signing `MPTokenAuthorize`
3. both → **Buy**

State 2 is the one that will otherwise blow up mid-demo. **Do not infer eligibility from
the `MPToken` object existing** — opt-in is permissionless (see `MARKETPLACE.md` §2).

## Phase 6 — join Identity to onboarding

`schema.sql` already states the seam:

```sql
-- 'pending' until the credential flow verifies the company. Owned by the
-- credentials work, not by onboarding: this column is the seam between them.
status TEXT NOT NULL DEFAULT 'pending',
```

So wire it: a successful EUDI verification plus an **accepted** on-chain credential flips
`companies.status` / `users.status` to `verified`. Put that in
`api/src/services/onboarding.js` next to the existing status logic, not in the
marketplace service.

This replaces the standalone Identity tab: onboarding collects the profile, verification
proves the human, the credential makes them eligible on-ledger. One flow.

## Phase 7 — make the credential usable by real vaults

Currently the custody credential is `{ MASTER_ADDRESS, KYC_EUDI_18PLUS }`, so custody can
only hold shares of vaults whose domain accepts that exact pair. `scripts/01-spike.mjs`
authorises a different pair (`{ issuer from data/accounts.json, KYC_TIER1 }`).

When a company creates a **private** vault through the platform, the domain it gates on
must accept the platform's credential. Options:

- have `CreateVault` always include `{ MASTER_ADDRESS, KYC_EUDI_18PLUS }` in
  `AcceptedCredentials` (a domain takes up to 10, AND-ed; separate objects give OR), or
- mint a per-domain credential for custody at vault-creation time.

Until this is done the marketplace only works with vaults the scenario created.

---

## Verify as you go

Each phase has a cheap check; do not stack them.

| phase | check |
|---|---|
| 0 | `npm run web` boots, existing tabs still work |
| 1 | `node scripts/20-share-transfer-spike.mjs` still passes — it exercises the moved lib |
| 2 | `npm --prefix api run reset` recreates the db with the new table |
| 3 | `curl localhost:8787/api/market/listings` after a scenario |
| 4 | the scenario button streams a log and produces two listings |
| 5 | buy a listing end to end: credential → opt in → pay → shares delivered |
| 6 | a verified user's `status` flips to `verified` |

## Do not re-litigate

These are measured, in `MARKETPLACE.md` §2, and each cost a probe:

- MPTs cannot be traded on the DEX (`temDISABLED`) — that is *why* custody exists.
- There is no issuer-side MPT authorize for vault shares; the issuer is a keyless
  pseudo-account and domain membership substitutes.
- Opt-in is permissionless; an `MPToken` object proves nothing.
- `InterestRate` is capped at 100000, and a loan may not outlive the vault
  (`tecNO_PERMISSION`). NAV moving only ~1.00000761 in a demo is correct, not a bug.
- `submitAndWait` can throw *after* a transaction applied. `submit()` handles it; keep
  that behaviour or shares will strand in custody.
