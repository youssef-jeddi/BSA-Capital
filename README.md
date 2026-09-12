# BSA Capital

> A compliant marketplace for close-ended lending funds on the XRP Ledger — issue a fund, invest in
> it, borrow from it, and sell your position before it matures.

Built at the **XRPL Lending Protocol Hackathon**, Paris, 12–13 September 2026.

## Submission facts

| | |
|---|---|
| Team | SY-BSA-Capital |
| Track | **2** — close-ended vault, Lending Protocol V1.1 |
| Flavour | **Loaded** — XLS-65 + XLS-66 + XLS-70 + XLS-80 |
| Network | Public XRPL Devnet (rippled 3.4.0-rc5) |
| RPC / WSS | `https://s.devnet.rippletest.net:51234/` · `wss://s.devnet.rippletest.net:51233/` |
| Explorer | `https://devnet.xrpl.org` |
| Library | **`xrpl.js@5.2.0-beta.1`** |
| Wallet | `oz-ross/xrpl-dev-wallet-extension` @ `upgrade-lending-protocol-1.1`, WalletConnect v2, chain `xrpl:2` |
| Feedback report | [`FEEDBACK.md`](./FEEDBACK.md) |

## What it does

A fund manager launches a **close-ended fund** — a real XLS-65 vault with immutable Subscription,
Investment and Redemption dates. Investors subscribe during Subscription and receive share MPTs.
During Investment the manager originates uncollateralised loans under XLS-66; repayments raise the
vault's assets without minting shares, so price per share steps up. At Redemption investors withdraw.

Three things sit on top of that:

**Compliance is the platform's job, not each fund's.** A platform account owns a permissioned domain
for every combination of three regulatory zones (EU, CH, US). A manager picks zones; investors need a
zone credential to deposit or borrow. The ledger enforces it — an uncredentialed deposit into a gated
vault is refused `tecNO_AUTH` with no application-layer check from us.

**A secondary market for locked positions.** During Investment `VaultWithdraw` returns `tecTOO_SOON`,
but the share MPT still transfers. An investor who needs liquidity early sells their position at a
discount to NAV to a buyer the ledger considers eligible. MPTs cannot be placed on the DEX, so
settlement runs through a custody account that only ever holds shares.

**Super vaults — a curated fund-of-funds.** A vault's pseudo-account cannot sign, so a vault can never
deposit into another vault. Instead the super vault *lends* its raise to a deployment account under
XLS-66, which allocates across sub-funds and repays with interest. The maturity cascade the protocol
enforces inside one vault — a loan may not outlive its vault — is enforced by us one level up:
`sub-fund redemption ≤ curator loan maturity < super vault redemption`.

## Transaction types used

**XLS-65** `VaultCreate` · `VaultSet` · `VaultDeposit` · `VaultWithdraw`
**XLS-66** `LoanBrokerSet` · `LoanBrokerCoverDeposit` · `LoanSet` (two-party) · `LoanPay`
**XLS-70** `CredentialCreate` · `CredentialAccept`
**XLS-80** `PermissionedDomainSet`
**MPT** `MPTokenAuthorize`
**Core** `Payment` (share MPT and XRP) · `AccountSet` (signed, never submitted, as proof of key control)

## Verified on-chain

| what | transaction |
|---|---|
| Close-ended private vault created | [`86AEA3DC…`](https://devnet.xrpl.org/transactions/86AEA3DC865EB109EE3751182F77BDF2B3E24A32621E6E073CB5FFCF460B702E) |
| Uncredentialed deposit refused `tecNO_AUTH` | [`B7C62798…`](https://devnet.xrpl.org/transactions/B7C6279833477E6C27892A4E50AF43C51724A5107778B667B14016EB890D6486) |
| Two-party `LoanSet` | [`BBA1135E…`](https://devnet.xrpl.org/transactions/BBA1135EAE7913BD879AED908A02776834ACD5B4C4EDC3EBE689DD55D6046B5D) |
| `LoanPay` — price per share 1 → 1.0000000833 | [`D0B31D20…`](https://devnet.xrpl.org/transactions/D0B31D2034737E0B0209A0E9F8142B2C93C58C195F5CB6F23CF100F13535E27C) |
| Super vault lends to its deployment account | [`9D2981C0…`](https://devnet.xrpl.org/transactions/9D2981C0C56CA7AF9BBE7F787F36451507703931606266FDFBCA9109C0AC4AF8) |
| `GracePeriod: 60` accepted where 59 is refused | [`93C30D3F…`](https://devnet.xrpl.org/transactions/93C30D3F178569AB2D157F299174A10E4BEA5DE5A5FB75CBCBDA9EEBEE6EFDC9) |
| Share transfer during Subscription | [`148ABCCF…`](https://devnet.xrpl.org/transactions/148ABCCF99EC1AC9202B7B4BB0BA14730BD750C3D9C184ED13992500034B02D3) |

## Setup

Node 20+. Nothing but Devnet is required — no API keys beyond a free WalletConnect project id.

```bash
git clone https://github.com/youssef-jeddi/BSA-Capital.git && cd BSA-Capital
npm install && npm --prefix api install && npm --prefix web install

npm run api                 # :8787 — creates api/data/bsa.db and migrates it
npm run setup-zones         # platform account + a permissioned domain per zone subset
npm run setup-custody       # custody account, credentialed for all three zones
npm run supervault-account  # the super vault's deployment account

echo 'VITE_WC_PROJECT_ID=<your id>' > web/.env   # free at cloud.reown.com
npm run web                 # :5173
```

The three setup commands are idempotent and create Devnet accounts whose seeds live in gitignored
files under `api/data/`. **Devnet only** — the API signs with them.

The wallet extension:

```bash
git clone -b upgrade-lending-protocol-1.1 https://github.com/oz-ross/xrpl-dev-wallet-extension.git
cd xrpl-dev-wallet-extension && npm install && npm run build
# chrome://extensions -> Developer mode -> Load unpacked -> dist/ -> set the network to Devnet
```

## Commands

| | |
|---|---|
| `npm test` | 46 unit tests over the pure logic — no network |
| `npm run seed` | create N funds on Devnet and index them |
| `npm run e2e` | full super vault lifecycle, ~4 min |
| `npm run market-e2e` | full marketplace lifecycle, ~4 min |
| `npm run spike` | credentials → domain → vault → deposit, with the rejection cases |
| `npm run lifecycle` | vault → loan → repayment, showing the price-per-share step |

`SUB_MINUTES` / `RED_MINUTES` / `COUNT` control the compressed lifecycles.

## Layout

```
api/     Fastify + SQLite. routes -> services -> repositories -> validation.
         Signs with three Devnet keys (platform, custody, deployment); every
         value-moving route requires a signed proof of account control.
web/     React + Vite. Talks to the wallet over WalletConnect v2 and reads the
         ledger directly. On-chain state is never cached in the database.
scripts/ Devnet lifecycle scripts; the end-to-end runs double as regression tests.
test/    Unit tests for the rules the ledger does not enforce for us.
```

## Known limits

Devnet only, and deliberately so: the API holds signing keys for three service accounts. Identity
verification is stubbed — an investor states their residency and the platform issues a zone
credential; they still accept it from their own wallet, so nothing is attached to an account without
its signature. Swapping in a real check replaces one confirmation step, not the ledger flow.
