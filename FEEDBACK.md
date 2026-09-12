# Developer Feedback Report

**Track:** 2 — close-ended vault, Lending Protocol V1.1
**Flavour:** Loaded — XLS-65 + XLS-66 + XLS-70 + XLS-80
**Environment:** Public XRPL Devnet, rippled 3.4.0-rc5 · `wss://s.devnet.rippletest.net:51233/`
**Library:** `xrpl.js@5.2.0-beta.0`, then `5.2.0-beta.1` mid-session
**Team:** SY-BSA-Capital

Everything below was measured on Devnet. Transaction hashes are on the public explorer.

---

## 1 · `signLoanSetByCounterparty` signed with the wrong hash prefix

**Category:** client libraries · **Severity:** critical (fixed in beta.1) · `xrpl.js@5.2.0-beta.0`

A counterparty signature on `LoanSet` is verified against the prefix `0x43505400` ("CPT"), not the
standard `0x53545800` ("STX"). `signLoanSetByCounterparty` used `encodeForSigning` unchanged, so
every signature it produced was rejected:

```
fails local checks: Counterparty: Invalid signature.
```

**Cost: about 100 minutes and 27 submissions.** No loan could be originated at all, which blocks the
entire lending protocol. We tried both SDK helpers, both signing orders, with and without the
`Counterparty` field, `SigningPubKey` swapped to the counterparty's key, `SigningPubKey` blanked, and
the multisign shape. All returned the same error. We found the answer by reading the event wallet's
source, where the swap is done explicitly.

Three separate things made this hard to diagnose:

- Omitting `CounterpartySignature` entirely fails `temBAD_SIGNER` with *"No signer may duplicate
  account or other signers"* — which points at multisigning, not at a missing counterparty approval.
- Signing counterparty-first fails *"Transaction must be first signed by first party"*, so the
  required order is only learnable by trial.
- `combineLoanSetCounterpartySigners` sits next to `signLoanSetByCounterparty` and mirrors the
  `signMultiBatch` / `combineBatchSigners` pair, so the natural read is sign-then-combine-then-submit.
  Combine is multisign-only and throws *"CounterpartySignature must have Signers"* for the single-key
  case.

**Fix:** shipped in `5.2.0-beta.1` as a `role` argument to `computeSignature`. We verified it end to
end: [`BBA1135E…`](https://devnet.xrpl.org/transactions/BBA1135EAE7913BD879AED908A02776834ACD5B4C4EDC3EBE689DD55D6046B5D).

**Still worth doing:** one worked `LoanSet` example showing signing order, the single-key versus
multisign branch, and the bytes each party signs.

---

## 2 · `GracePeriod` has an undocumented 60-second floor, reported as `temINVALID`

**Category:** client libraries · **Severity:** high (open) · `xrpl.js@5.2.0-beta.1`

`validateLoanSet` checks `GracePeriod <= PaymentInterval` and imposes no minimum, so a smaller value
passes client validation and dies on the ledger with a code that names no field. Bisected:

| GracePeriod | Result |
|---|---|
| 30 | `temINVALID` |
| 59 | `temINVALID` |
| **60** | **`tesSUCCESS`** — [`93C30D3F…`](https://devnet.xrpl.org/transactions/93C30D3F178569AB2D157F299174A10E4BEA5DE5A5FB75CBCBDA9EEBEE6EFDC9) |

**Repro:** any `LoanSet` with `PaymentInterval: 120, GracePeriod: 30`.

**Fix:** add the floor to `validateLoanSet` so it fails in the client naming the field. `temINVALID`
for an out-of-range parameter is a generic answer to a specific question.

---

## 3 · MPTs cannot be traded on the DEX, though `lsfMPTCanTrade` is set

**Category:** missing primitive · **Severity:** high · rippled 3.4.0-rc5

A close-ended vault sets `lsfMPTCanTrade` on its share issuance — we read flags `60` on a private
vault: `lsfMPTRequireAuth | lsfMPTCanEscrow | lsfMPTCanTrade | lsfMPTCanTransfer`. But:

```
OfferCreate  TakerGets {mpt_issuance_id, value}             -> temDISABLED
OfferCreate  same + DomainID (permissioned DEX, XLS-81)     -> temDISABLED
```

The permissioned DEX is the natural venue for gated share trading — offers already carry a
`DomainID` — and it is switched off for MPTs. We had to build a custody account instead: the seller
pays shares to it, the buyer pays the seller directly, custody releases. `Batch` is unavailable, so
the legs cannot be atomic and eligibility must be re-checked immediately before delivery.

**Fix:** either enable MPT support on the permissioned DEX, or stop setting `lsfMPTCanTrade` on
issuances where it has no effect. A flag that advertises a capability the ledger refuses is worse
than no flag.

---

## 4 · Two independent receive-gates, one error code

**Category:** documentation-tutorials · **Severity:** high

To receive private-vault shares an account needs **both**:

1. an accepted credential in the issuance's permissioned domain, and
2. its own `MPTokenAuthorize` on the `ShareMPTID`, signed by the recipient with no `Holder` field.

Missing either returns `tecNO_AUTH`, so three different fixes hide behind one code. Measured:

| step | result |
|---|---|
| deposit, no credential | `tecNO_AUTH` |
| credential issued, **not yet accepted** | `tecNO_AUTH` |
| credential accepted | `tesSUCCESS` |
| `MPTokenAuthorize` by an **uncredentialed** account | `tesSUCCESS` |
| share payment to a credentialed account that never opted in | `tecNO_AUTH` |

Two consequences that are easy to get wrong:

- **Opt-in is permissionless**, so an existing `MPToken` object proves nothing about eligibility. Any
  UI that infers "authorised" from its presence is wrong.
- **There is no issuer-side authorize for vault shares and there cannot be.** The issuer is the
  vault's keyless pseudo-account, which can never sign `MPTokenAuthorize(Holder)`. The ledger
  substitutes the domain check — which is why `DomainID` lives on the share `MPTokenIssuance` rather
  than on the `Vault`. Teams will look for an issuer-side step; there isn't one.

**Fix:** document both gates together, and distinguish them in the error — a missing credential and a
missing opt-in are not the same failure.

---

## 5 · A vault can never deposit into another vault

**Category:** missing primitive · **Severity:** medium

The vault pseudo-account cannot sign, so `VaultDeposit` from a vault is impossible and a fund-of-funds
cannot be protocol-native. We used the protocol's own escape hatch — the super vault *lends* its raise
to a separate account under XLS-66, which allocates into sub-vaults and repays with interest — proven
end to end: [`9D2981C0…`](https://devnet.xrpl.org/transactions/9D2981C0C56CA7AF9BBE7F787F36451507703931606266FDFBCA9109C0AC4AF8).

That works, but forces two compromises:

- The borrower must be a **second account**, because `Account == Counterparty` on a `LoanSet` is
  rejected. An accounting entity invented to satisfy a signing rule.
- **Custody splits.** The super vault holds a loan receivable while a different account holds the
  sub-fund shares, which is a weaker claim for depositors than owning the positions.

Also: XLS-66 enforces that a loan may not mature after its vault's `RedemptionDate` — exactly the
right rule — but nothing enforces it across nested vaults. We reimplemented the cascade
(`sub redemption ≤ loan maturity < super redemption`) in application code.

**Fix:** document whether a two-account structure is the intended pattern, and consider extending
maturity matching to nested structures.

---

## 6 · No way to enumerate vaults

**Category:** missing primitive · **Severity:** medium

`ledger_entry` fetches a vault by its 64-character id and `account_objects` lists vaults for an owner
you already know. Nothing lists vaults across the ledger, and a new depositor has neither the id nor
the owner. The first useful screen of any XLS-65 application — a list of funds — cannot be built from
the ledger alone. We run an off-chain index.

**Fix:** a clio or explorer API that can page `Vault` ledger entries, as one can already browse AMMs.

---

## 7 · XLS-89 share metadata rules are source-only, and non-compliance is silent

**Category:** documentation-tutorials · **Severity:** medium · `xrpl.js@5.2.0-beta.1`

Building a `VaultCreate` form we hit three rules that exist only in the validator:

- `asset_class` is a closed set of six (`rwa, memes, wrapped, gaming, defi, other`). We first read
  `private_credit`, `treasury`, `equity` as asset classes; they are **asset subclasses**.
- `asset_subclass` is typed optional but is **required when `asset_class` is `rwa`** — exactly the
  class a real-world lending fund needs.
- `icon` is required and rejects an empty string, while `desc` is genuinely optional.

`validateVaultCreate` calls `validateMPTokenMetadata` and, on failure, only emits `console.warn` with
a header saying adherence is not mandatory. The transaction still submits, so a vault can be created
with metadata explorers will not index — and in a browser build the warning is invisible.

**Fix:** a reference table for the class/subclass pairs, `icon` marked required, and either return the
warnings from `validate` or export a documented pre-flight helper.

---

## 8 · Smaller findings

- **`Loan.PeriodicPayment` is stored with fractional precision** (`6666669.203437892712`). Passing it
  straight into `LoanPay.Amount` throws *"is an illegal amount"* — an XRP amount must be whole drops.
  Rounding down underpays. *(documentation, low)*
- **`tecEXPIRED` on `LoanPay` is permanent and does not say so.** Past maturity plus grace, no
  repayment is ever possible and the capital is stranded with the borrower. Worth stating in the
  reference. *(documentation, low)*
- **A live vault's phase dates are immutable** — `VaultSet` accepts only `Data`, `AssetsMaximum`,
  `DomainID`. Correct and desirable, but discoverable only from the type definition, and operators
  assume a dashboard can adjust them. *(documentation, low)*
- **Phases follow wall clock and cannot be advanced on Devnet.** A meaningful share of our UI work
  existed only to observe transitions in real time. A settable devnet clock would remove it.
  *(other, low)*

## What worked well

- **`tecNO_AUTH` on a domain-gated deposit is exactly right.** A private vault with a `DomainID`
  enforced credential gating with no application-layer code from us. XLS-70 → XLS-80 → XLS-65
  composed on the first attempt.
- **`tecTOO_SOON`, `tecEXPIRED` and `tecNO_PERMISSION`** each named their cause clearly.
- **Cash-basis accounting behaved exactly as specified.** `LoanPay` raised `AssetsTotal` from
  60000000 to 60000005 drops with the share count unchanged, stepping price per share from `1` to
  `1.0000000833333333`. Interest recognised on payment, no dilution, a discrete step rather than a
  drift: [`D0B31D20…`](https://devnet.xrpl.org/transactions/D0B31D2034737E0B0209A0E9F8142B2C93C58C195F5CB6F23CF100F13535E27C).
- **The beta ships all 15 vault and loan transaction models fully typed**, including `VaultKind`,
  `SubscriptionDate`, `RedemptionDate` and `CounterpartySignature`. We hand-rolled no JSON.
- **`5.2.0-beta.1` landed mid-event and fixed item 1.** Fast turnaround.
