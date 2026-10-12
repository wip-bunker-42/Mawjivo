ALTER TABLE targets ADD COLUMN facebook_like_state TEXT
  CHECK (facebook_like_state IN ('sending','liked','failed','unknown'));
ALTER TABLE targets ADD COLUMN facebook_like_claimed_at_ms INTEGER;
