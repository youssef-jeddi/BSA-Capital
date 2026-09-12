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
