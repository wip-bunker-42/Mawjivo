ALTER TABLE report_outbox ADD COLUMN error_code TEXT;
ALTER TABLE dispatch_outbox ADD COLUMN receipts_only INTEGER NOT NULL DEFAULT 0;
CREATE TABLE workspace_daily (workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id), next_due_ms INTEGER NOT NULL, local_date TEXT NOT NULL, last_evaluated_date TEXT, claim_id TEXT, lease_until_ms INTEGER);
CREATE INDEX daily_due ON workspace_daily(next_due_ms,lease_until_ms);
CREATE TABLE workspace_activity (id INTEGER PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), occurred_at_ms INTEGER NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL, UNIQUE(workspace_id,occurred_at_ms,kind,entity_id));
CREATE INDEX activity_day ON workspace_activity(workspace_id,occurred_at_ms);
CREATE TRIGGER activity_confirm AFTER INSERT ON posts BEGIN
 INSERT OR IGNORE INTO workspace_activity(workspace_id,occurred_at_ms,kind,entity_id) VALUES(NEW.workspace_id,NEW.created_at_ms,'confirm',NEW.id);
END;
CREATE TRIGGER activity_edit AFTER UPDATE OF revision,cancel_requested_ms ON posts WHEN NEW.revision!=OLD.revision OR (NEW.cancel_requested_ms IS NOT NULL AND OLD.cancel_requested_ms IS NULL) BEGIN
 INSERT OR IGNORE INTO workspace_activity(workspace_id,occurred_at_ms,kind,entity_id) VALUES(NEW.workspace_id,NEW.updated_at_ms,CASE WHEN NEW.cancel_requested_ms IS NOT NULL THEN 'cancel' ELSE 'edit' END,NEW.id);
END;
CREATE TRIGGER activity_outcome AFTER UPDATE OF state ON targets WHEN NEW.state!=OLD.state AND (NEW.state IN ('published','failed','uncertain') OR (NEW.state='ready' AND NEW.error_json IS NOT NULL)) BEGIN
 INSERT OR IGNORE INTO workspace_activity(workspace_id,occurred_at_ms,kind,entity_id) VALUES(NEW.workspace_id,NEW.updated_at_ms,NEW.state,NEW.post_id||':'||NEW.revision||':'||NEW.channel_id);
END;
