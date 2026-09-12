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
