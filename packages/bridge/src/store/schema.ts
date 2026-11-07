/**
 * SQLite schema — plan §7.2 (v4.2). SCHEMA_VERSION is independent of the
 * plan document version.
 *
 * Sentinel '' for gateway stream task_id; NO FK on events.task_id (gateway
 * rows use ''); cascade for task deletion is explicit in-transaction.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  conversation_key TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1)),
  provider_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('opening','open','closed','stale')),
  persistence_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conversations_task ON conversations(task_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_one_current
  ON conversations(task_id) WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','active','paused','completed','failed','cancelled')),
  pause_reason TEXT CHECK (pause_reason IS NULL OR pause_reason IN
    ('user_requested','gateway_restart','browser_unavailable','provider_unavailable')),
  title TEXT,
  profile_id TEXT NOT NULL,
  origin_browser_instance_id TEXT,
  binding_json TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  conversation_key TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT, mode_id TEXT, thinking_option_id TEXT,
  provider_options_json TEXT,
  backend_json TEXT NOT NULL,
  tab_intent_json TEXT NOT NULL,
  last_seq INTEGER NOT NULL DEFAULT 0,
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  error_json TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  CHECK ((status = 'paused') = (pause_reason IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_tasks_profile_status ON tasks(profile_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_status_updated ON tasks(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS turns (
  turn_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','completed','failed','cancelled','unknown')),
  client_message_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  queued_at INTEGER,
  started_at INTEGER,
  ended_at INTEGER,
  stop_reason TEXT, error_json TEXT,
  CHECK (
    (status = 'queued'  AND started_at IS NULL AND ended_at IS NULL AND queued_at IS NOT NULL) OR
    (status = 'running' AND started_at IS NOT NULL AND ended_at IS NULL AND queued_at IS NOT NULL) OR
    (status IN ('completed','failed','cancelled','unknown')
       AND started_at IS NOT NULL AND ended_at IS NOT NULL) OR
    (status IN ('cancelled','failed') AND started_at IS NULL AND ended_at IS NOT NULL AND queued_at IS NOT NULL)
  ),
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE,
  UNIQUE (task_id, client_message_id)
);
CREATE INDEX IF NOT EXISTS idx_turns_task ON turns(task_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_turns_one_running
  ON turns(task_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS events (
  stream TEXT NOT NULL CHECK (stream IN ('task','gateway')),
  task_id TEXT NOT NULL DEFAULT '',
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  turn_id TEXT,
  payload_json TEXT NOT NULL,
  milestone INTEGER NOT NULL DEFAULT 0,
  redacted INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (stream, task_id, seq),
  CHECK ((stream = 'gateway' AND task_id = '') OR (stream = 'task' AND task_id <> ''))
);
CREATE INDEX IF NOT EXISTS idx_events_task_seq ON events(task_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_turn ON events(turn_id);
CREATE INDEX IF NOT EXISTS idx_events_gateway_seq ON events(seq) WHERE stream = 'gateway';

CREATE TABLE IF NOT EXISTS gateway_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  approval_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL, turn_id TEXT,
  request_json TEXT NOT NULL,
  action_digest TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','allowed','denied','expired')),
  decision_json TEXT,
  created_at INTEGER NOT NULL, decided_at INTEGER,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(task_id, status);

CREATE TABLE IF NOT EXISTS artifacts (
  artifact_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL, sha256 TEXT NOT NULL, path TEXT NOT NULL,
  mime TEXT, bytes INTEGER, created_at INTEGER NOT NULL,
  FOREIGN KEY (task_id) REFERENCES tasks(task_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);

CREATE TABLE IF NOT EXISTS provider_state (
  provider_id TEXT PRIMARY KEY,
  catalog_json TEXT, fetched_at INTEGER,
  auth_state_json TEXT
);
`;

/** Seed required by §7.2 P1.9 — idempotent. */
export const SEED_SQL = `
INSERT INTO gateway_state (key, value, updated_at)
VALUES ('gateway.last_seq', '0', CAST(strftime('%s','now') AS INTEGER) * 1000)
ON CONFLICT(key) DO NOTHING;
`;
