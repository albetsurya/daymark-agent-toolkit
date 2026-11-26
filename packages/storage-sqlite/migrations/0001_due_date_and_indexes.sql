ALTER TABLE tasks ADD COLUMN due_date TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_tasks_status_priority ON tasks(status, priority);
CREATE INDEX IF NOT EXISTS idx_tasks_due_at ON tasks(due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_sessions_single_active
  ON focus_sessions(status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_focus_sessions_started_at ON focus_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_worklog_entries_occurred_at ON worklog_entries(occurred_at);
