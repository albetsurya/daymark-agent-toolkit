import {
  type AgentSource,
  type BackupArchive,
  DaymarkError,
  type ImportMode,
  type SettingsDto,
  SettingsDtoSchema,
} from '@daymark/contracts';
import type {
  BackupRepository,
  DaymarkRepositories,
  FocusSessionRecord,
  FocusSessionRepository,
  IdempotencyRepository,
  ProjectRecord,
  ProjectRepository,
  SettingsRepository,
  TaskListFilter,
  TaskRecord,
  TaskRepository,
  WorklogEntryRecord,
  WorklogRepository,
} from '@daymark/core';
import type Database from 'better-sqlite3';
import { and, asc, desc, eq, gte, inArray, lte, or, sql } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import {
  type daymarkSchema,
  focusSessionsTable,
  idempotencyRecordsTable,
  projectsTable,
  schemaMigrationsTable,
  settingsTable,
  tagsTable,
  tasksTable,
  taskTagsTable,
  worklogEntriesTable,
} from './schema.js';

export type DrizzleDb = BetterSQLite3Database<typeof daymarkSchema>;

function mapProjectRow(row: typeof projectsTable.$inferSelect): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    createdAtMs: row.createdAt,
    updatedAtMs: row.updatedAt,
    archivedAtMs: row.archivedAt,
  };
}

function mapFocusRow(row: typeof focusSessionsTable.$inferSelect): FocusSessionRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    status: row.status,
    startedAtMs: row.startedAt,
    endedAtMs: row.endedAt,
    durationSeconds: row.durationSeconds,
    note: row.note,
    sourceAgent: row.sourceAgent as AgentSource,
    createdAtMs: row.createdAt,
    updatedAtMs: row.updatedAt,
  };
}

function mapWorklogRow(row: typeof worklogEntriesTable.$inferSelect): WorklogEntryRecord {
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    focusSessionId: row.focusSessionId,
    summary: row.summary,
    details: row.details,
    durationMinutes: row.durationMinutes,
    occurredAtMs: row.occurredAt,
    sourceAgent: row.sourceAgent as AgentSource,
    createdAtMs: row.createdAt,
  };
}

export function createSqliteRepositories(
  db: DrizzleDb,
  raw: Database.Database,
): DaymarkRepositories {
  function loadTagsForTasks(taskIds: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (taskIds.length === 0) return result;
    const rows = db
      .select({
        taskId: taskTagsTable.taskId,
        tagName: tagsTable.name,
      })
      .from(taskTagsTable)
      .innerJoin(tagsTable, eq(taskTagsTable.tagId, tagsTable.id))
      .where(inArray(taskTagsTable.taskId, taskIds))
      .orderBy(asc(tagsTable.name))
      .all();

    for (const row of rows) {
      const list = result.get(row.taskId) ?? [];
      list.push(row.tagName);
      result.set(row.taskId, list);
    }
    return result;
  }

  function syncTaskTags(taskId: string, tagNames: string[], nowMs: number): void {
    db.delete(taskTagsTable).where(eq(taskTagsTable.taskId, taskId)).run();
    for (const name of tagNames) {
      let existingTag = db.select().from(tagsTable).where(eq(tagsTable.name, name)).get();
      if (!existingTag) {
        const tagId = crypto.randomUUID();
        db.insert(tagsTable).values({ id: tagId, name, createdAt: nowMs }).run();
        existingTag = { id: tagId, name, createdAt: nowMs };
      }
      db.insert(taskTagsTable).values({ taskId, tagId: existingTag.id }).run();
    }
  }

  function hydrateTaskRows(
    rows: { task: typeof tasksTable.$inferSelect; projectName: string | null }[],
  ): TaskRecord[] {
    const tagMap = loadTagsForTasks(rows.map((r) => r.task.id));
    return rows.map(({ task, projectName }) => ({
      id: task.id,
      title: task.title,
      description: task.description,
      projectId: task.projectId,
      projectName,
      status: task.status,
      priority: task.priority,
      estimateMinutes: task.estimateMinutes,
      dueAtMs: task.dueAt,
      dueDate: task.dueDate,
      completedAtMs: task.completedAt,
      createdAtMs: task.createdAt,
      updatedAtMs: task.updatedAt,
      sourceAgent: task.sourceAgent as AgentSource,
      externalRef: task.externalRef,
      tags: tagMap.get(task.id) ?? [],
    }));
  }

  const projects: ProjectRepository = {
    findById(id) {
      const row = db.select().from(projectsTable).where(eq(projectsTable.id, id)).get();
      return row ? mapProjectRow(row) : null;
    },
    list({ status, limit, offset }) {
      const whereClause = status === 'all' ? undefined : eq(projectsTable.status, status);
      const rows = db
        .select()
        .from(projectsTable)
        .where(whereClause)
        .orderBy(desc(projectsTable.createdAt), asc(projectsTable.id))
        .limit(limit + 1)
        .offset(offset)
        .all();
      const hasMore = rows.length > limit;
      return {
        items: rows.slice(0, limit).map(mapProjectRow),
        hasMore,
      };
    },
    create(record) {
      db.insert(projectsTable)
        .values({
          id: record.id,
          name: record.name,
          description: record.description,
          status: record.status,
          createdAt: record.createdAtMs,
          updatedAt: record.updatedAtMs,
          archivedAt: record.archivedAtMs,
        })
        .run();
    },
    update(id, patch) {
      const existing = projects.findById(id);
      if (!existing) return null;
      db.update(projectsTable)
        .set({
          name: patch.name ?? existing.name,
          description: patch.description === undefined ? existing.description : patch.description,
          status: patch.status ?? existing.status,
          updatedAt: patch.updatedAtMs ?? existing.updatedAtMs,
          archivedAt: patch.archivedAtMs === undefined ? existing.archivedAtMs : patch.archivedAtMs,
        })
        .where(eq(projectsTable.id, id))
        .run();
      return projects.findById(id);
    },
  };

  const tasks: TaskRepository = {
    findById(id) {
      const row = db
        .select({ task: tasksTable, projectName: projectsTable.name })
        .from(tasksTable)
        .leftJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
        .where(eq(tasksTable.id, id))
        .get();
      if (!row) return null;
      return hydrateTaskRows([row])[0] ?? null;
    },
    listAll(filter?: TaskListFilter) {
      const conditions = [];
      if (filter?.statuses && filter.statuses.length > 0) {
        conditions.push(inArray(tasksTable.status, filter.statuses));
      }
      if (filter?.priority) {
        conditions.push(eq(tasksTable.priority, filter.priority));
      }
      if (filter?.projectId) {
        conditions.push(eq(tasksTable.projectId, filter.projectId));
      }
      if (filter?.query && filter.query.trim().length > 0) {
        const pattern = `%${filter.query.trim().toLowerCase()}%`;
        conditions.push(
          or(
            sql`lower(${tasksTable.title}) LIKE ${pattern}`,
            sql`lower(coalesce(${tasksTable.description}, '')) LIKE ${pattern}`,
          ),
        );
      }

      const rows = db
        .select({ task: tasksTable, projectName: projectsTable.name })
        .from(tasksTable)
        .leftJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(tasksTable.updatedAt), asc(tasksTable.id))
        .all();

      return hydrateTaskRows(rows);
    },
    create(record) {
      db.insert(tasksTable)
        .values({
          id: record.id,
          title: record.title,
          description: record.description,
          projectId: record.projectId,
          status: record.status,
          priority: record.priority,
          estimateMinutes: record.estimateMinutes,
          dueAt: record.dueAtMs,
          dueDate: record.dueDate,
          completedAt: record.completedAtMs,
          createdAt: record.createdAtMs,
          updatedAt: record.updatedAtMs,
          sourceAgent: record.sourceAgent,
          externalRef: record.externalRef,
        })
        .run();
      if (record.tags.length > 0) {
        syncTaskTags(record.id, record.tags, record.createdAtMs);
      }
    },
    update(id, patch) {
      const existing = tasks.findById(id);
      if (!existing) return null;
      db.update(tasksTable)
        .set({
          title: patch.title ?? existing.title,
          description: patch.description === undefined ? existing.description : patch.description,
          projectId: patch.projectId === undefined ? existing.projectId : patch.projectId,
          status: patch.status ?? existing.status,
          priority: patch.priority ?? existing.priority,
          estimateMinutes:
            patch.estimateMinutes === undefined ? existing.estimateMinutes : patch.estimateMinutes,
          dueAt: patch.dueAtMs === undefined ? existing.dueAtMs : patch.dueAtMs,
          dueDate: patch.dueDate === undefined ? existing.dueDate : patch.dueDate,
          completedAt:
            patch.completedAtMs === undefined ? existing.completedAtMs : patch.completedAtMs,
          updatedAt: patch.updatedAtMs,
        })
        .where(eq(tasksTable.id, id))
        .run();

      if (patch.tags !== undefined) {
        syncTaskTags(id, patch.tags, patch.updatedAtMs);
      }
      return tasks.findById(id);
    },
    listCompletedInRange(fromMs, toMs) {
      const rows = db
        .select({ task: tasksTable, projectName: projectsTable.name })
        .from(tasksTable)
        .leftJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
        .where(
          and(
            eq(tasksTable.status, 'completed'),
            gte(tasksTable.completedAt, fromMs),
            lte(tasksTable.completedAt, toMs),
          ),
        )
        .orderBy(desc(tasksTable.completedAt), asc(tasksTable.id))
        .all();
      return hydrateTaskRows(rows);
    },
    listOpen() {
      const rows = db
        .select({ task: tasksTable, projectName: projectsTable.name })
        .from(tasksTable)
        .leftJoin(projectsTable, eq(tasksTable.projectId, projectsTable.id))
        .where(inArray(tasksTable.status, ['inbox', 'todo', 'in_progress']))
        .orderBy(asc(tasksTable.createdAt), asc(tasksTable.id))
        .all();
      return hydrateTaskRows(rows);
    },
  };

  const focusSessions: FocusSessionRepository = {
    findById(id) {
      const row = db.select().from(focusSessionsTable).where(eq(focusSessionsTable.id, id)).get();
      return row ? mapFocusRow(row) : null;
    },
    findActive() {
      const row = db
        .select()
        .from(focusSessionsTable)
        .where(eq(focusSessionsTable.status, 'active'))
        .get();
      return row ? mapFocusRow(row) : null;
    },
    list({ status, taskId, projectId, limit, offset }) {
      const conditions = [];
      if (status !== 'all') conditions.push(eq(focusSessionsTable.status, status));
      if (taskId) conditions.push(eq(focusSessionsTable.taskId, taskId));
      if (projectId) conditions.push(eq(focusSessionsTable.projectId, projectId));
      const rows = db
        .select()
        .from(focusSessionsTable)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(focusSessionsTable.startedAt), asc(focusSessionsTable.id))
        .limit(limit + 1)
        .offset(offset)
        .all();
      const hasMore = rows.length > limit;
      return {
        items: rows.slice(0, limit).map(mapFocusRow),
        hasMore,
      };
    },
    listInRange(fromMs, toMs) {
      const rows = db
        .select()
        .from(focusSessionsTable)
        .where(
          and(gte(focusSessionsTable.startedAt, fromMs), lte(focusSessionsTable.startedAt, toMs)),
        )
        .orderBy(desc(focusSessionsTable.startedAt), asc(focusSessionsTable.id))
        .all();
      return rows.map(mapFocusRow);
    },
    create(record) {
      db.insert(focusSessionsTable)
        .values({
          id: record.id,
          taskId: record.taskId,
          projectId: record.projectId,
          status: record.status,
          startedAt: record.startedAtMs,
          endedAt: record.endedAtMs,
          durationSeconds: record.durationSeconds,
          note: record.note,
          sourceAgent: record.sourceAgent,
          createdAt: record.createdAtMs,
          updatedAt: record.updatedAtMs,
        })
        .run();
    },
    finish(id, patch) {
      db.update(focusSessionsTable)
        .set({
          status: patch.status,
          endedAt: patch.endedAtMs,
          durationSeconds: patch.durationSeconds,
          note: patch.note,
          updatedAt: patch.updatedAtMs,
        })
        .where(eq(focusSessionsTable.id, id))
        .run();
      return focusSessions.findById(id);
    },
  };

  const worklogs: WorklogRepository = {
    findById(id) {
      const row = db.select().from(worklogEntriesTable).where(eq(worklogEntriesTable.id, id)).get();
      return row ? mapWorklogRow(row) : null;
    },
    listInRange({ fromMs, toMs, projectId, taskId, sourceAgent }) {
      const conditions = [
        gte(worklogEntriesTable.occurredAt, fromMs),
        lte(worklogEntriesTable.occurredAt, toMs),
      ];
      if (projectId) conditions.push(eq(worklogEntriesTable.projectId, projectId));
      if (taskId) conditions.push(eq(worklogEntriesTable.taskId, taskId));
      if (sourceAgent) conditions.push(eq(worklogEntriesTable.sourceAgent, sourceAgent));

      const rows = db
        .select()
        .from(worklogEntriesTable)
        .where(and(...conditions))
        .orderBy(desc(worklogEntriesTable.occurredAt), asc(worklogEntriesTable.id))
        .all();
      return rows.map(mapWorklogRow);
    },
    create(record) {
      db.insert(worklogEntriesTable)
        .values({
          id: record.id,
          taskId: record.taskId,
          projectId: record.projectId,
          focusSessionId: record.focusSessionId,
          summary: record.summary,
          details: record.details,
          durationMinutes: record.durationMinutes,
          occurredAt: record.occurredAtMs,
          sourceAgent: record.sourceAgent,
          createdAt: record.createdAtMs,
        })
        .run();
    },
  };

  const settings: SettingsRepository = {
    getSettings() {
      const rows = db.select().from(settingsTable).all();
      if (rows.length === 0) return null;
      const map = new Map(rows.map((r) => [r.key, JSON.parse(r.valueJson) as unknown]));
      const parsed = SettingsDtoSchema.safeParse({
        timezone: map.get('timezone') ?? 'UTC',
        weekStartsOn: map.get('week_starts_on') ?? 'monday',
        dayStartTime: map.get('day_start_time') ?? '09:00',
        defaultPlanMinutes: map.get('default_plan_minutes') ?? null,
      });
      if (!parsed.success) {
        throw new DaymarkError('VALIDATION_FAILED', 'Stored settings are invalid.');
      }
      return parsed.data;
    },
    saveSettings(next: SettingsDto, updatedAtMs: number) {
      const entries: [string, unknown][] = [
        ['timezone', next.timezone],
        ['week_starts_on', next.weekStartsOn],
        ['day_start_time', next.dayStartTime],
        ['default_plan_minutes', next.defaultPlanMinutes],
      ];
      for (const [key, value] of entries) {
        db.insert(settingsTable)
          .values({ key, valueJson: JSON.stringify(value), updatedAt: updatedAtMs })
          .onConflictDoUpdate({
            target: settingsTable.key,
            set: { valueJson: JSON.stringify(value), updatedAt: updatedAtMs },
          })
          .run();
      }
    },
    getSchemaVersion() {
      const rows = db
        .select()
        .from(schemaMigrationsTable)
        .orderBy(desc(schemaMigrationsTable.version))
        .limit(1)
        .all();
      return rows[0]?.version ?? null;
    },
  };

  const idempotency: IdempotencyRepository = {
    findResourceId(scope, key, nowMs) {
      const row = db
        .select()
        .from(idempotencyRecordsTable)
        .where(
          and(
            eq(idempotencyRecordsTable.scope, scope),
            eq(idempotencyRecordsTable.idempotencyKey, key),
          ),
        )
        .get();
      if (!row) return null;
      if (row.expiresAt !== null && row.expiresAt < nowMs) {
        db.delete(idempotencyRecordsTable)
          .where(
            and(
              eq(idempotencyRecordsTable.scope, scope),
              eq(idempotencyRecordsTable.idempotencyKey, key),
            ),
          )
          .run();
        return null;
      }
      return row.resourceId;
    },
    save(scope, key, resourceId, createdAtMs, expiresAtMs) {
      db.insert(idempotencyRecordsTable)
        .values({
          scope,
          idempotencyKey: key,
          resourceId,
          createdAt: createdAtMs,
          expiresAt: expiresAtMs,
        })
        .onConflictDoUpdate({
          target: [idempotencyRecordsTable.scope, idempotencyRecordsTable.idempotencyKey],
          set: { resourceId, createdAt: createdAtMs, expiresAt: expiresAtMs },
        })
        .run();
    },
  };

  const backup: BackupRepository = {
    exportSnapshot() {
      const currentSettings = settings.getSettings() ?? {
        timezone: 'UTC',
        weekStartsOn: 'monday',
        dayStartTime: '09:00',
        defaultPlanMinutes: null,
      };
      const allProjects = db
        .select()
        .from(projectsTable)
        .orderBy(asc(projectsTable.createdAt), asc(projectsTable.id))
        .all()
        .map(mapProjectRow);
      const allTasks = db
        .select()
        .from(tasksTable)
        .orderBy(asc(tasksTable.createdAt), asc(tasksTable.id))
        .all()
        .map((t) => ({
          id: t.id,
          title: t.title,
          description: t.description,
          projectId: t.projectId,
          status: t.status,
          priority: t.priority,
          estimateMinutes: t.estimateMinutes,
          dueAtMs: t.dueAt,
          dueDate: t.dueDate,
          completedAtMs: t.completedAt,
          createdAtMs: t.createdAt,
          updatedAtMs: t.updatedAt,
          sourceAgent: t.sourceAgent as AgentSource,
          externalRef: t.externalRef,
        }));
      const allTags = db
        .select()
        .from(tagsTable)
        .orderBy(asc(tagsTable.name))
        .all()
        .map((tag) => ({ id: tag.id, name: tag.name, createdAtMs: tag.createdAt }));
      const allTaskTags = db.select().from(taskTagsTable).all();
      const allFocus = db
        .select()
        .from(focusSessionsTable)
        .orderBy(asc(focusSessionsTable.startedAt), asc(focusSessionsTable.id))
        .all()
        .map(mapFocusRow);
      const allWorklogs = db
        .select()
        .from(worklogEntriesTable)
        .orderBy(asc(worklogEntriesTable.occurredAt), asc(worklogEntriesTable.id))
        .all()
        .map(mapWorklogRow);

      return {
        settings: currentSettings,
        projects: allProjects,
        tasks: allTasks,
        tags: allTags,
        taskTags: allTaskTags,
        focusSessions: allFocus,
        worklogEntries: allWorklogs,
      };
    },
    findConflictingIds(archive: BackupArchive) {
      const conflicts: string[] = [];
      const checkIds = (tableName: string, ids: string[]) => {
        if (ids.length === 0) return;
        const stmt = raw.prepare(`SELECT id FROM ${tableName} WHERE id = ?`);
        for (const id of ids) {
          if (stmt.get(id)) conflicts.push(id);
        }
      };
      checkIds(
        'projects',
        archive.data.projects.map((p) => p.id),
      );
      checkIds(
        'tasks',
        archive.data.tasks.map((t) => t.id),
      );
      checkIds(
        'tags',
        archive.data.tags.map((t) => t.id),
      );
      checkIds(
        'focus_sessions',
        archive.data.focusSessions.map((f) => f.id),
      );
      checkIds(
        'worklog_entries',
        archive.data.worklogEntries.map((w) => w.id),
      );
      return conflicts;
    },
    importSnapshot(archive: BackupArchive, mode: ImportMode, nowMs: number) {
      if (mode === 'replace') {
        db.delete(worklogEntriesTable).run();
        db.delete(focusSessionsTable).run();
        db.delete(taskTagsTable).run();
        db.delete(tagsTable).run();
        db.delete(tasksTable).run();
        db.delete(projectsTable).run();
        db.delete(idempotencyRecordsTable).run();
        settings.saveSettings(archive.data.settings, nowMs);
      }

      for (const p of archive.data.projects) {
        db.insert(projectsTable)
          .values({
            id: p.id,
            name: p.name,
            description: p.description,
            status: p.status,
            createdAt: Date.parse(p.createdAt),
            updatedAt: Date.parse(p.updatedAt),
            archivedAt: p.archivedAt ? Date.parse(p.archivedAt) : null,
          })
          .run();
      }

      for (const t of archive.data.tasks) {
        db.insert(tasksTable)
          .values({
            id: t.id,
            title: t.title,
            description: t.description,
            projectId: t.projectId,
            status: t.status,
            priority: t.priority,
            estimateMinutes: t.estimateMinutes,
            dueAt: t.dueAt ? Date.parse(t.dueAt) : null,
            dueDate: t.dueDate,
            completedAt: t.completedAt ? Date.parse(t.completedAt) : null,
            createdAt: Date.parse(t.createdAt),
            updatedAt: Date.parse(t.updatedAt),
            sourceAgent: t.sourceAgent,
            externalRef: t.externalRef,
          })
          .run();
      }

      const tagRemap = new Map<string, string>();
      for (const tag of archive.data.tags) {
        const existingByName = db
          .select()
          .from(tagsTable)
          .where(eq(tagsTable.name, tag.name))
          .get();
        if (existingByName) {
          tagRemap.set(tag.id, existingByName.id);
        } else {
          db.insert(tagsTable)
            .values({
              id: tag.id,
              name: tag.name,
              createdAt: Date.parse(tag.createdAt),
            })
            .run();
          tagRemap.set(tag.id, tag.id);
        }
      }

      for (const tt of archive.data.taskTags) {
        const resolvedTagId = tagRemap.get(tt.tagId) ?? tt.tagId;
        db.insert(taskTagsTable)
          .values({ taskId: tt.taskId, tagId: resolvedTagId })
          .onConflictDoNothing()
          .run();
      }

      for (const fs of archive.data.focusSessions) {
        db.insert(focusSessionsTable)
          .values({
            id: fs.id,
            taskId: fs.taskId,
            projectId: fs.projectId,
            status: fs.status,
            startedAt: Date.parse(fs.startedAt),
            endedAt: fs.endedAt ? Date.parse(fs.endedAt) : null,
            durationSeconds: fs.durationSeconds,
            note: fs.note,
            sourceAgent: fs.sourceAgent,
            createdAt: Date.parse(fs.createdAt),
            updatedAt: Date.parse(fs.updatedAt),
          })
          .run();
      }

      for (const wl of archive.data.worklogEntries) {
        db.insert(worklogEntriesTable)
          .values({
            id: wl.id,
            taskId: wl.taskId,
            projectId: wl.projectId,
            focusSessionId: wl.focusSessionId,
            summary: wl.summary,
            details: wl.details,
            durationMinutes: wl.durationMinutes,
            occurredAt: Date.parse(wl.occurredAt),
            sourceAgent: wl.sourceAgent,
            createdAt: Date.parse(wl.createdAt),
          })
          .run();
      }
    },
  };

  return {
    projects,
    tasks,
    focusSessions,
    worklogs,
    settings,
    idempotency,
    backup,
  };
}
