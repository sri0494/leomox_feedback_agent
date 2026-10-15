CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN','ADMIN','MANAGER','VIEWER')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  sid_hash TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id),
  tab_id TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);
CREATE TABLE feedback_campaigns (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'te',
  start_date TEXT,
  end_date TEXT,
  window_start TEXT NOT NULL DEFAULT '09:00',
  window_end TEXT NOT NULL DEFAULT '19:00',
  max_duration_s INTEGER NOT NULL DEFAULT 150,
  retries INTEGER NOT NULL DEFAULT 2,
  concurrency INTEGER NOT NULL DEFAULT 5,
  recording TEXT NOT NULL DEFAULT 'off' CHECK (recording IN ('off','on')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','closed')),
  questions JSONB NOT NULL,
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE feedback_contacts (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES feedback_campaigns(id),
  number TEXT NOT NULL,
  language TEXT NOT NULL,
  locality TEXT,
  mandal TEXT,
  constituency TEXT,
  permission TEXT NOT NULL,
  permission_at TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, number)
);
CREATE INDEX contacts_campaign_status_idx ON feedback_contacts (campaign_id, status);
CREATE TABLE feedback_suppression_entries (
  number TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE feedback_calls (
  id TEXT PRIMARY KEY,
  campaign_id TEXT NOT NULL REFERENCES feedback_campaigns(id),
  contact_id TEXT NOT NULL REFERENCES feedback_contacts(id),
  provider TEXT NOT NULL,
  provider_call_id TEXT NOT NULL UNIQUE,
  is_mock BOOLEAN NOT NULL DEFAULT TRUE,
  outcome TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  duration_s INTEGER NOT NULL DEFAULT 0,
  language TEXT NOT NULL,
  recording_stored BOOLEAN NOT NULL DEFAULT FALSE,
  timeline JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX calls_campaign_outcome_idx ON feedback_calls (campaign_id, outcome);
CREATE INDEX calls_created_idx ON feedback_calls (created_at);
CREATE TABLE feedback_responses (
  id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL REFERENCES feedback_calls(id),
  question_id TEXT NOT NULL,
  category TEXT NOT NULL,
  transcript TEXT,
  skipped BOOLEAN NOT NULL DEFAULT FALSE,
  stt_confidence REAL,
  classification_status TEXT NOT NULL DEFAULT 'pending' CHECK (classification_status IN ('pending','done')),
  classification JSONB,
  needs_review BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX responses_call_idx ON feedback_responses (call_id);
CREATE TABLE feedback_webhook_events (
  event_id TEXT PRIMARY KEY,
  provider_call_id TEXT,
  event_type TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE feedback_audit_logs (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON feedback_audit_logs (created_at);
