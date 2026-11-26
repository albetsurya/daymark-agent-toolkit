import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const projectsTable = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  status: text('status').$type<'active' | 'archived'>().notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  archivedAt: integer('archived_at'),
});

export const tasksTable = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  projectId: text('project_id').references(() => projectsTable.id, { onDelete: 'set null' }),
  status: text('status')
    .$type<'inbox' | 'todo' | 'in_progress' | 'completed' | 'cancelled' | 'archived'>()
    .notNull(),
  priority: text('priority').$type<'none' | 'low' | 'medium' | 'high'>().notNull(),
  estimateMinutes: integer('estimate_minutes'),
  dueAt: integer('due_at'),
  dueDate: text('due_date'),
  completedAt: integer('completed_at'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  sourceAgent: text('source_agent').notNull().default('unknown'),
  externalRef: text('external_ref'),
});

export const tagsTable = sqliteTable('tags', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  createdAt: integer('created_at').notNull(),
});

export const taskTagsTable = sqliteTable(
  'task_tags',
  {
    taskId: text('task_id')
      .notNull()
      .references(() => tasksTable.id, { onDelete: 'cascade' }),
    tagId: text('tag_id')
      .notNull()
      .references(() => tagsTable.id, { onDelete: 'cascade' }),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.tagId] })],
);

export const focusSessionsTable = sqliteTable('focus_sessions', {
  id: text('id').primaryKey(),
  taskId: text('task_id').references(() => tasksTable.id, { onDelete: 'set null' }),
  projectId: text('project_id').references(() => projectsTable.id, { onDelete: 'set null' }),
  status: text('status').$type<'active' | 'completed' | 'interrupted'>().notNull(),
  startedAt: integer('started_at').notNull(),
  endedAt: integer('ended_at'),
  durationSeconds: integer('duration_seconds'),
  note: text('note'),
  sourceAgent: text('source_agent').notNull().default('unknown'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const worklogEntriesTable = sqliteTable('worklog_entries', {
  id: text('id').primaryKey(),
  taskId: text('task_id').references(() => tasksTable.id, { onDelete: 'set null' }),
  projectId: text('project_id').references(() => projectsTable.id, { onDelete: 'set null' }),
  focusSessionId: text('focus_session_id').references(() => focusSessionsTable.id, {
    onDelete: 'set null',
  }),
  summary: text('summary').notNull(),
  details: text('details'),
  durationMinutes: integer('duration_minutes'),
  occurredAt: integer('occurred_at').notNull(),
  sourceAgent: text('source_agent').notNull().default('unknown'),
  createdAt: integer('created_at').notNull(),
});

export const settingsTable = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const idempotencyRecordsTable = sqliteTable(
  'idempotency_records',
  {
    scope: text('scope').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    resourceId: text('resource_id').notNull(),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at'),
  },
  (table) => [primaryKey({ columns: [table.scope, table.idempotencyKey] })],
);

export const schemaMigrationsTable = sqliteTable('schema_migrations', {
  version: text('version').primaryKey(),
  appliedAt: integer('applied_at').notNull(),
});

export const daymarkSchema = {
  projectsTable,
  tasksTable,
  tagsTable,
  taskTagsTable,
  focusSessionsTable,
  worklogEntriesTable,
  settingsTable,
  idempotencyRecordsTable,
  schemaMigrationsTable,
};
