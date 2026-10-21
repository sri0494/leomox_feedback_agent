ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited','active','disabled'));
UPDATE users SET status = 'disabled' WHERE active = FALSE;
ALTER TABLE users ADD COLUMN phone TEXT;
ALTER TABLE users ADD COLUMN campaign_scope TEXT NOT NULL DEFAULT 'all' CHECK (campaign_scope IN ('all','assigned'));
ALTER TABLE users ADD COLUMN can_archive BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN disabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN disabled_by TEXT;
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
UPDATE users SET password_changed_at = created_at;
CREATE TABLE user_campaigns (
  user_id TEXT NOT NULL REFERENCES users(id),
  campaign_id TEXT NOT NULL REFERENCES feedback_campaigns(id),
  PRIMARY KEY (user_id, campaign_id)
);
CREATE TABLE user_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('invite','reset')),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX user_tokens_user_idx ON user_tokens (user_id);
ALTER TABLE feedback_campaigns ADD COLUMN campaign_type TEXT NOT NULL DEFAULT 'feedback_survey';
ALTER TABLE feedback_campaigns ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE feedback_campaigns ADD COLUMN updated_at TIMESTAMPTZ;
ALTER TABLE feedback_campaigns ADD COLUMN updated_by TEXT;
ALTER TABLE feedback_campaigns ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE feedback_campaigns ADD COLUMN archived_by TEXT;
CREATE TABLE feedback_campaign_changes (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES feedback_campaigns(id),
  user_id TEXT,
  action TEXT NOT NULL,
  version INTEGER,
  changes JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX campaign_changes_idx ON feedback_campaign_changes (campaign_id, created_at);
