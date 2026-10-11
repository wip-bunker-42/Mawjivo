ALTER TABLE targets ADD COLUMN published_at_ms INTEGER;
CREATE INDEX posts_workspace_created ON posts(workspace_id,created_at_ms DESC,id DESC);
CREATE INDEX targets_workspace_published ON targets(workspace_id,state,published_at_ms);
