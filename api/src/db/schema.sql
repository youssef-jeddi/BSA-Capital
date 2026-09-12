-- Onboarding records. The XRPL account address is the primary key: a profile
-- only exists once a wallet has connected, so there is no separate user id.
CREATE TABLE IF NOT EXISTS companies (
  address       TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  activity      TEXT NOT NULL,
  country       TEXT NOT NULL,
  website       TEXT,
  contact_email TEXT,
  -- 'pending' until the credential flow verifies the company. Owned by the
  -- credentials work, not by onboarding: this column is the seam between them.
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  address       TEXT PRIMARY KEY,
  display_name  TEXT NOT NULL,
  country       TEXT NOT NULL,
  investor_type TEXT NOT NULL,
  contact_email TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- Vaults created through the platform. The ledger has no global vault index,
-- so this table is what makes a browsable list of funds possible at all.
-- On-chain state (phase, assets, price per share) is never cached here: it is
-- read live from the ledger and joined in the client.
CREATE TABLE IF NOT EXISTS vaults (
  vault_id          TEXT PRIMARY KEY,
  company_address   TEXT NOT NULL REFERENCES companies(address),
  loan_broker_id    TEXT,
  share_mpt_id      TEXT,
  name              TEXT NOT NULL,
  activity          TEXT,
  asset_code        TEXT NOT NULL DEFAULT 'XRP',
  subscription_date INTEGER,
  redemption_date   INTEGER,
  is_private        INTEGER NOT NULL DEFAULT 0,
  zones             TEXT,               -- JSON array of zone codes, null = open to all
  domain_id         TEXT,
  tx_hash           TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_vaults_company ON vaults(company_address);

-- Super vaults: a curated fund-of-funds.
--
-- A vault pseudo-account cannot sign, so a vault can never be a depositor in
-- another vault and native composition is impossible. The workaround is the
-- protocol's own escape hatch: the super vault is itself a close-ended XLS-65
-- vault that lends its capital to the curator via XLS-66, and the curator
-- deposits that principal into the chosen sub-vaults. Repayment with interest
-- flows back and steps the super vault's price per share.
CREATE TABLE IF NOT EXISTS super_vaults (
  vault_id          TEXT PRIMARY KEY,
  curator_address   TEXT NOT NULL REFERENCES companies(address),
  -- The curator borrows the raise from its own super vault, but a LoanSet is
  -- rejected when Account equals Counterparty, so the borrowing arm must be a
  -- separate account. In a real structure that is the SPV.
  deployment_address TEXT NOT NULL,
  loan_broker_id    TEXT,
  loan_id           TEXT,              -- super vault -> curator, set on deploy
  name              TEXT NOT NULL,
  strategy          TEXT,
  subscription_date INTEGER,
  redemption_date   INTEGER,
  loan_maturity     INTEGER,          -- when the curator loan must be fully repaid
  status            TEXT NOT NULL DEFAULT 'raising',  -- raising | deployed | unwinding
  created_at        TEXT NOT NULL
);

-- Target allocation across sub-vaults, in basis points of the raise.
CREATE TABLE IF NOT EXISTS super_vault_allocations (
  super_vault_id TEXT NOT NULL REFERENCES super_vaults(vault_id),
  sub_vault_id   TEXT NOT NULL,
  target_bps     INTEGER NOT NULL,
  deposited_tx   TEXT,
  PRIMARY KEY (super_vault_id, sub_vault_id)
);

CREATE INDEX IF NOT EXISTS idx_super_curator ON super_vaults(curator_address);

-- Regulatory zones the platform operates, and the permissioned domain backing
-- each combination of them.
--
-- A vault carries a single DomainID, but a domain accepts several credential
-- types, so "EU or CH" is one domain accepting both zone credentials. We
-- pre-create every non-empty subset of the zones and hand managers a zone
-- picker instead of a 64-character id.
CREATE TABLE IF NOT EXISTS zone_domains (
  combo_key  TEXT PRIMARY KEY,   -- sorted zone codes joined by '+', e.g. "CH+EU"
  zones      TEXT NOT NULL,      -- JSON array of zone codes
  domain_id  TEXT NOT NULL,
  tx_hash    TEXT,
  created_at TEXT NOT NULL
);

-- Credentials the platform has issued, so the UI can show pending acceptances.
CREATE TABLE IF NOT EXISTS zone_credentials (
  subject     TEXT NOT NULL,
  zone        TEXT NOT NULL,
  issued_tx   TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (subject, zone)
);

-- Secondary-market listings for locked vault shares.
--
-- During a close-ended vault's Investment phase VaultWithdraw returns tecTOO_SOON,
-- but the share MPT still transfers, so a locked LP can sell instead of redeem.
--
-- A listing is an intent and lives here; every leg that moves value is a ledger
-- transaction, recorded by hash and verified server-side before it is trusted.
-- NAV is never stored: it is read live, like all on-chain state.
--
-- shares and ask_drops are TEXT: 50 XRP is 50,000,000 shares, which exceeds what
-- SQLite integers and JS numbers handle safely together.
CREATE TABLE IF NOT EXISTS listings (
  id             TEXT PRIMARY KEY,        -- first 16 chars of transfer_hash
  vault_id       TEXT NOT NULL,
  share_mpt_id   TEXT NOT NULL,
  domain_id      TEXT,                    -- null for a public vault
  seller_address TEXT NOT NULL,
  shares         TEXT NOT NULL,
  ask_drops      TEXT NOT NULL,
  nav_at_listing TEXT,                    -- drops per share when listed, for context only
  status         TEXT NOT NULL DEFAULT 'open',   -- open | sold | cancelled
  buyer_address  TEXT,
  transfer_hash  TEXT NOT NULL,           -- seller -> custody
  payment_hash   TEXT,                    -- buyer  -> seller
  delivery_hash  TEXT,                    -- custody -> buyer
  return_hash    TEXT,                    -- custody -> seller on cancel
  created_at     TEXT NOT NULL,
  settled_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_vault  ON listings(vault_id);
CREATE INDEX IF NOT EXISTS idx_listings_seller ON listings(seller_address);
