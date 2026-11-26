CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NULL,
  project_id TEXT NULL REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('inbox', 'todo', 'in_progress', 'completed', 'cancelled', 'archived')),
  priority TEXT NOT NULL CHECK (priority IN ('none', 'low', 'medium', 'high')),
  estimate_minutes INTEGER NULL CHECK (estimate_minutes IS NULL OR (estimate_minutes > 0 AND estimate_minutes <= 10080)),
  due_at INTEGER NULL,
  completed_at INTEGER NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  source_agent TEXT NOT NULL DEFAULT 'unknown',
  external_ref TEXT NULL
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);

CREATE TABLE IF NOT EXISTS focus_sessions (
  id TEXT PRIMARY KEY,
  task_id TEXT NULL REFERENCES tasks(id) ON DELETE SET NULL,
  project_id TEXT NULL REFERENCES projects(id) ON DELETE SET NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'interrupted')),
  started_at INTEGER NOT NULL,
  ended_at INTEGER NULL,
  duration_seconds INTEGER NULL,
  note TEXT NULL,
  source_agent TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS worklog_entries (
  id TEXT PRIMARY KEY,
  task_id TEXT NULL REFERENCES tasks(id) ON DELETE SET NULL,
  project_id TEXT NULL REFERENCES projects(id) ON DELETE SET NULL,
  focus_session_id TEXT NULL REFERENCES focus_sessions(id) ON DELETE SET NULL,
  summary TEXT NOT NULL,
  details TEXT NULL,
  duration_minutes INTEGER NULL CHECK (duration_minutes IS NULL OR (duration_minutes >= 0 AND duration_minutes <= 1440)),
  occurred_at INTEGER NOT NULL,
  source_agent TEXT NOT NULL DEFAULT 'unknown',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_records (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NULL,
  PRIMARY KEY (scope, idempotency_key)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
