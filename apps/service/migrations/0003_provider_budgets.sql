-- A credential fingerprint is shared across workspaces; credentials never appear here.
-- One versioned row makes reservation of all rolling windows atomic.
CREATE TABLE IF NOT EXISTS provider_budgets (
  client_id TEXT PRIMARY KEY,
  state_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
