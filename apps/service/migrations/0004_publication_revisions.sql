ALTER TABLE posts ADD COLUMN cancel_requested_ms INTEGER;
ALTER TABLE posts ADD COLUMN dispatch_generation INTEGER NOT NULL DEFAULT 0;
ALTER TABLE targets ADD COLUMN provider_state_json TEXT;
ALTER TABLE targets ADD COLUMN receipt_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE targets ADD COLUMN continuation_claim_id TEXT;
ALTER TABLE targets ADD COLUMN continuation_rejected INTEGER NOT NULL DEFAULT 0;
ALTER TABLE dispatch_outbox ADD COLUMN claim_id TEXT;
ALTER TABLE dispatch_outbox ADD COLUMN claimed_at_ms INTEGER;
ALTER TABLE dispatch_outbox RENAME TO dispatch_outbox_before_publication;
CREATE TABLE dispatch_outbox (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL REFERENCES posts(id),
  revision INTEGER NOT NULL,
  workflow_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','terminate')),
  state TEXT NOT NULL,
  next_attempt_ms INTEGER NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  claim_id TEXT,
  claimed_at_ms INTEGER,
  UNIQUE(post_id,revision,action),
  UNIQUE(workflow_id,action)
);
INSERT INTO dispatch_outbox SELECT * FROM dispatch_outbox_before_publication;
DROP TABLE dispatch_outbox_before_publication;
CREATE INDEX dispatch_due ON dispatch_outbox(state,next_attempt_ms);
CREATE TABLE post_revisions (
  post_id TEXT NOT NULL REFERENCES posts(id),
  revision INTEGER NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  draft_id TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  channel_snapshot_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  PRIMARY KEY(post_id,revision),
  UNIQUE(workspace_id,draft_id,revision)
);
INSERT INTO post_revisions(post_id,revision,workspace_id,draft_id,plan_hash,plan_json,channel_snapshot_json,created_at_ms)
 SELECT id,revision,workspace_id,draft_id,plan_hash,plan_json,'[]',created_at_ms FROM posts;
