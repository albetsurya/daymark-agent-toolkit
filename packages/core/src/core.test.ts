import {
  type AgentSource,
  BACKUP_FORMAT_VERSION,
  type BackupArchive,
  DaymarkError,
  type ImportMode,
  type Priority,
  type SettingsDto,
  type TaskStatus,
} from '@daymark/contracts';
import { describe, expect, it } from 'vitest';
import {
  type Clock,
  computeDailyPlan,
  createDaymarkService,
  type DaymarkRepositories,
  type DaymarkStore,
  endOfLocalDayUtcMs,
  type FocusSessionRecord,
  formatUtcMsInTimezoneDate,
  getCalendarWeekDates,
  type IdGenerator,
  type ProjectRecord,
  startOfLocalDayUtcMs,
  type TagRecord,
  type TaskRecord,
  type TaskTagRecord,
  validateTaskStatusTransition,
  type WorklogEntryRecord,
} from './index.js';

function createInMemoryStore(
  initialSettings: SettingsDto | null = {
    timezone: 'Asia/Jakarta',
    weekStartsOn: 'monday',
    dayStartTime: '09:00',
    defaultPlanMinutes: null,
  },
): DaymarkStore {
  let settings = initialSettings ? { ...initialSettings } : null;
  const projects = new Map<string, ProjectRecord>();
  const tasks = new Map<string, Omit<TaskRecord, 'projectName'>>();
  const tags = new Map<string, TagRecord>();
  let taskTags: TaskTagRecord[] = [];
  const focusSessions = new Map<string, FocusSessionRecord>();
  const worklogs = new Map<string, WorklogEntryRecord>();
  const idempotency = new Map<string, { resourceId: string; expiresAtMs: number }>();

  const hydrateTask = (t: Omit<TaskRecord, 'projectName'>): TaskRecord => ({
    ...t,
    projectName: t.projectId ? (projects.get(t.projectId)?.name ?? null) : null,
  });

  const repos: DaymarkRepositories = {
    projects: {
      findById: (id) => projects.get(id) ?? null,
      list: ({ status, limit, offset }) => {
        const filtered = [...projects.values()]
          .filter((p) => status === 'all' || p.status === status)
          .sort((a, b) => b.createdAtMs - a.createdAtMs || a.id.localeCompare(b.id));
        const items = filtered.slice(offset, offset + limit);
        return { items, hasMore: offset + items.length < filtered.length };
      },
      create: (r) => {
        projects.set(r.id, { ...r });
      },
      update: (id, patch) => {
        const cur = projects.get(id);
        if (!cur) return null;
        const next: ProjectRecord = {
          ...cur,
          name: patch.name ?? cur.name,
          description: patch.description === undefined ? cur.description : patch.description,
          status: patch.status ?? cur.status,
          updatedAtMs: patch.updatedAtMs ?? cur.updatedAtMs,
          archivedAtMs: patch.archivedAtMs === undefined ? cur.archivedAtMs : patch.archivedAtMs,
        };
        projects.set(id, next);
        return next;
      },
    },
    tasks: {
      findById: (id) => {
        const t = tasks.get(id);
        return t ? hydrateTask(t) : null;
      },
      listAll: (filter) => {
        return [...tasks.values()]
          .filter((t) => {
            if (filter?.statuses && !filter.statuses.includes(t.status)) return false;
            if (filter?.priority && t.priority !== filter.priority) return false;
            if (filter?.projectId && t.projectId !== filter.projectId) return false;
            if (filter?.query) {
              const q = filter.query.toLowerCase();
              const hay = `${t.title}\n${t.description ?? ''}`.toLowerCase();
              if (!hay.includes(q)) return false;
            }
            return true;
          })
          .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id))
          .map(hydrateTask);
      },
      create: (r) => {
        tasks.set(r.id, { ...r });
      },
      update: (id, patch) => {
        const cur = tasks.get(id);
        if (!cur) return null;
        const next: Omit<TaskRecord, 'projectName'> = {
          ...cur,
          title: patch.title ?? cur.title,
          description: patch.description === undefined ? cur.description : patch.description,
          projectId: patch.projectId === undefined ? cur.projectId : patch.projectId,
          status: patch.status ?? cur.status,
          priority: patch.priority ?? cur.priority,
          estimateMinutes:
            patch.estimateMinutes === undefined ? cur.estimateMinutes : patch.estimateMinutes,
          dueAtMs: patch.dueAtMs === undefined ? cur.dueAtMs : patch.dueAtMs,
          dueDate: patch.dueDate === undefined ? cur.dueDate : patch.dueDate,
          completedAtMs:
            patch.completedAtMs === undefined ? cur.completedAtMs : patch.completedAtMs,
          updatedAtMs: patch.updatedAtMs,
          tags: patch.tags ?? cur.tags,
        };
        tasks.set(id, next);
        return hydrateTask(next);
      },
      listCompletedInRange: (fromMs, toMs) =>
        [...tasks.values()]
          .filter(
            (t) =>
              t.status === 'completed' &&
              t.completedAtMs !== null &&
              t.completedAtMs >= fromMs &&
              t.completedAtMs <= toMs,
          )
          .map(hydrateTask),
      listOpen: () =>
        [...tasks.values()]
          .filter((t) => t.status === 'inbox' || t.status === 'todo' || t.status === 'in_progress')
          .map(hydrateTask),
    },
    focusSessions: {
      findById: (id) => focusSessions.get(id) ?? null,
      findActive: () => [...focusSessions.values()].find((s) => s.status === 'active') ?? null,
      list: ({ status, taskId, projectId, limit, offset }) => {
        const filtered = [...focusSessions.values()]
          .filter(
            (s) =>
              (status === 'all' || s.status === status) &&
              (!taskId || s.taskId === taskId) &&
              (!projectId || s.projectId === projectId),
          )
          .sort((a, b) => b.startedAtMs - a.startedAtMs || a.id.localeCompare(b.id));
        const items = filtered.slice(offset, offset + limit);
        return { items, hasMore: offset + items.length < filtered.length };
      },
      listInRange: (fromMs, toMs) =>
        [...focusSessions.values()].filter((s) => s.startedAtMs >= fromMs && s.startedAtMs <= toMs),
      create: (r) => {
        focusSessions.set(r.id, { ...r });
      },
      finish: (id, patch) => {
        const cur = focusSessions.get(id);
        if (!cur) return null;
        const next: FocusSessionRecord = {
          ...cur,
          status: patch.status,
          endedAtMs: patch.endedAtMs,
          durationSeconds: patch.durationSeconds,
          note: patch.note,
          updatedAtMs: patch.updatedAtMs,
        };
        focusSessions.set(id, next);
        return next;
      },
    },
    worklogs: {
      findById: (id) => worklogs.get(id) ?? null,
      listInRange: ({ fromMs, toMs, projectId, taskId, sourceAgent }) =>
        [...worklogs.values()]
          .filter(
            (w) =>
              w.occurredAtMs >= fromMs &&
              w.occurredAtMs <= toMs &&
              (!projectId || w.projectId === projectId) &&
              (!taskId || w.taskId === taskId) &&
              (!sourceAgent || w.sourceAgent === sourceAgent),
          )
          .sort((a, b) => b.occurredAtMs - a.occurredAtMs || a.id.localeCompare(b.id)),
      create: (r) => {
        worklogs.set(r.id, { ...r });
      },
    },
    settings: {
      getSettings: () => settings,
      saveSettings: (s) => {
        settings = { ...s };
      },
      getSchemaVersion: () => '0001_due_date_and_indexes',
    },
    idempotency: {
      findResourceId: (scope, key, nowMs) => {
        const hit = idempotency.get(`${scope}:${key}`);
        if (!hit || hit.expiresAtMs < nowMs) return null;
        return hit.resourceId;
      },
      save: (scope, key, resourceId, _createdAtMs, expiresAtMs) => {
        idempotency.set(`${scope}:${key}`, { resourceId, expiresAtMs });
      },
    },
    backup: {
      exportSnapshot: () => ({
        settings: settings ?? {
          timezone: 'UTC',
          weekStartsOn: 'monday',
          dayStartTime: '09:00',
          defaultPlanMinutes: null,
        },
        projects: [...projects.values()],
        tasks: [...tasks.values()],
        tags: [...tags.values()],
        taskTags: [...taskTags],
        focusSessions: [...focusSessions.values()],
        worklogEntries: [...worklogs.values()],
      }),
      findConflictingIds: (archive) => {
        const conflicts: string[] = [];
        for (const p of archive.data.projects) if (projects.has(p.id)) conflicts.push(p.id);
        for (const t of archive.data.tasks) if (tasks.has(t.id)) conflicts.push(t.id);
        return conflicts;
      },
      importSnapshot: (archive: BackupArchive, mode: ImportMode) => {
        if (mode === 'replace') {
          projects.clear();
          tasks.clear();
          tags.clear();
          taskTags = [];
          focusSessions.clear();
          worklogs.clear();
          settings = { ...archive.data.settings };
        }
        for (const p of archive.data.projects) {
          projects.set(p.id, {
            id: p.id,
            name: p.name,
            description: p.description,
            status: p.status,
            createdAtMs: Date.parse(p.createdAt),
            updatedAtMs: Date.parse(p.updatedAt),
            archivedAtMs: p.archivedAt ? Date.parse(p.archivedAt) : null,
          });
        }
        for (const t of archive.data.tasks) {
          tasks.set(t.id, {
            id: t.id,
            title: t.title,
            description: t.description,
            projectId: t.projectId,
            status: t.status,
            priority: t.priority,
            estimateMinutes: t.estimateMinutes,
            dueAtMs: t.dueAt ? Date.parse(t.dueAt) : null,
            dueDate: t.dueDate,
            completedAtMs: t.completedAt ? Date.parse(t.completedAt) : null,
            createdAtMs: Date.parse(t.createdAt),
            updatedAtMs: Date.parse(t.updatedAt),
            sourceAgent: t.sourceAgent,
            externalRef: t.externalRef,
            tags: [],
          });
        }
      },
    },
  };

  return {
    isInitialized: () => settings !== null,
    getDataDir: () => '/tmp/in-memory',
    getSchemaVersion: () => '0001_due_date_and_indexes',
    transaction: (fn) => fn(repos),
  };
}

function makeTestClock(initialIso: string): { clock: Clock; advanceMs: (ms: number) => void } {
  let now = Date.parse(initialIso);
  return {
    clock: { nowMs: () => now },
    advanceMs: (ms: number) => {
      now += ms;
    },
  };
}

function makeSeqIds(): IdGenerator {
  let counter = 1;
  return {
    nextId: () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`,
  };
}

describe('@daymark/core time and DST calculations', () => {
  it('computes exact 23-hour spring-forward and 25-hour fall-back day spans in America/New_York', () => {
    const springStart = startOfLocalDayUtcMs('2026-03-08', 'America/New_York');
    const springEnd = endOfLocalDayUtcMs('2026-03-08', 'America/New_York');
    expect(springEnd - springStart + 1).toBe(23 * 60 * 60 * 1000);

    const fallStart = startOfLocalDayUtcMs('2026-11-01', 'America/New_York');
    const fallEnd = endOfLocalDayUtcMs('2026-11-01', 'America/New_York');
    expect(fallEnd - fallStart + 1).toBe(25 * 60 * 60 * 1000);

    expect(formatUtcMsInTimezoneDate(Date.parse('2026-11-26T18:30:00Z'), 'Asia/Jakarta')).toBe(
      '2026-11-27',
    );
  });

  it('computes week boundaries for monday and sunday starts', () => {
    // 2026-11-26 is Thursday
    const monWeek = getCalendarWeekDates('2026-11-26', 'monday');
    expect(monWeek.weekStartDate).toBe('2026-11-23');
    expect(monWeek.weekEndDate).toBe('2026-11-29');

    const sunWeek = getCalendarWeekDates('2026-11-26', 'sunday');
    expect(sunWeek.weekStartDate).toBe('2026-11-22');
    expect(sunWeek.weekEndDate).toBe('2026-11-28');
  });
});

describe('@daymark/core transitions and planner', () => {
  it('enforces valid task status transitions', () => {
    expect(() => validateTaskStatusTransition('todo', 'in_progress')).not.toThrow();
    expect(() => validateTaskStatusTransition('completed', 'archived')).not.toThrow();
    expect(() => validateTaskStatusTransition('archived', 'completed')).toThrow(DaymarkError);
    expect(() => validateTaskStatusTransition('cancelled', 'in_progress')).toThrow(DaymarkError);
  });

  it('produces deterministic daily plan putting overdue first, respecting budget and missing estimates', () => {
    const makeTask = (
      id: string,
      title: string,
      status: TaskStatus,
      priority: Priority,
      estimateMinutes: number | null,
      dueDate: string | null,
      createdAtMs: number,
    ): TaskRecord => ({
      id,
      title,
      description: null,
      projectId: null,
      projectName: null,
      status,
      priority,
      estimateMinutes,
      dueAtMs: null,
      dueDate,
      completedAtMs: null,
      createdAtMs,
      updatedAtMs: createdAtMs,
      sourceAgent: 'cli',
      externalRef: null,
      tags: [],
    });

    const plan = computeDailyPlan({
      planDate: '2026-11-26',
      timezone: 'Asia/Jakarta',
      availableMinutes: 90,
      nowMs: Date.parse('2026-11-26T02:00:00Z'),
      tasks: [
        makeTask('t1', 'Done task', 'completed', 'high', 30, '2026-11-25', 1),
        makeTask('t2', 'Overdue medium', 'todo', 'medium', 40, '2026-11-25', 2),
        makeTask('t3', 'Today high', 'in_progress', 'high', 50, '2026-11-26', 3),
        makeTask('t4', 'Unestimated high', 'todo', 'high', null, null, 4),
        makeTask('t5', 'Too big low', 'todo', 'low', 60, null, 5),
      ],
    });

    expect(plan.isRecommendation).toBe(true);
    expect(plan.overdueCount).toBe(1);
    expect(plan.plannedTasks.map((p) => p.task.id)).toEqual(['t2', 't3']);
    expect(plan.plannedTasks[0]?.reasons).toContain('OVERDUE');
    expect(plan.totalEstimatedMinutes).toBe(90);
    expect(plan.remainingMinutes).toBe(0);
    expect(plan.unscheduledMissingEstimate.map((p) => p.task.id)).toEqual(['t4']);
    expect(plan.excludedTasks.map((e) => e.task.id)).toEqual(['t5']);
    expect(plan.excludedTasks[0]?.reason).toBe('EXCEEDS_REMAINING_BUDGET');
  });
});

describe('@daymark/core use cases', () => {
  it('supports task capture idempotency, focus single-active conflict, worklog creation, and honest reviews', () => {
    const store = createInMemoryStore();
    const { clock, advanceMs } = makeTestClock('2026-11-26T02:00:00Z'); // 09:00 Asia/Jakarta
    const service = createDaymarkService({ store, clock, idGenerator: makeSeqIds() });

    const proj = service.createProject({ name: 'Daymark Core' });
    const c1 = service.captureTask({
      title: 'Build storage layer',
      projectId: proj.project.id,
      priority: 'high',
      estimateMinutes: 45,
      dueAt: '2026-11-26',
      idempotencyKey: 'cap-1',
      sourceAgent: 'claude-code' as AgentSource,
    });
    expect(c1.deduplicated).toBe(false);
    expect(c1.task.dueDate).toBe('2026-11-26');
    expect(c1.unspecifiedFields).toEqual(['description', 'tags']);

    const c2 = service.captureTask({
      title: 'Build storage layer',
      idempotencyKey: 'cap-1',
    });
    expect(c2.deduplicated).toBe(true);
    expect(c2.task.id).toBe(c1.task.id);

    // Requires budget when default_plan_minutes is null
    expect(() => service.getTodayPlan({})).toThrow(/availableMinutes/i);
    const plan = service.getTodayPlan({ availableMinutes: 60 });
    expect(plan.plannedTasks).toHaveLength(1);

    // Focus single-active invariant
    const started = service.startFocus({ taskId: c1.task.id, sourceAgent: 'cursor' });
    expect(started.session.status).toBe('active');
    expect(() => service.startFocus({ note: 'Competing focus' })).toThrow(DaymarkError);

    advanceMs(25 * 60 * 1000);
    const finished = service.finishFocus({ createWorklog: true });
    expect(finished.session.durationSeconds).toBe(1500);
    expect(finished.worklogEntry?.durationMinutes).toBe(25);
    expect(finished.worklogEntry?.sourceAgent).toBe('cursor');

    // Complete task with note creates linked worklog
    advanceMs(5 * 60 * 1000);
    const completed = service.completeTask({
      taskId: c1.task.id,
      completionNote: 'Finished Drizzle schema and tests',
      sourceAgent: 'codex',
    });
    expect(completed.task.status).toBe('completed');
    expect(completed.worklogEntry?.summary).toBe('Finished Drizzle schema and tests');

    // Daily & weekly review aggregate strictly recorded data
    const daily = service.generateDailyReview({ date: '2026-11-26' });
    expect(daily.completedTasks).toHaveLength(1);
    expect(daily.totalFocusSeconds).toBe(1500);
    expect(daily.totalWorklogMinutes).toBe(25);
    expect(daily.dataGaps.some((g) => g.includes('no duration recorded'))).toBe(true);

    const weekly = service.generateWeeklyReview({ weekOf: '2026-11-26' });
    expect(weekly.weekStartDate).toBe('2026-11-23');
    expect(weekly.dailyTotals).toHaveLength(7);
    const thursday = weekly.dailyTotals.find((d) => d.date === '2026-11-26');
    expect(thursday?.completedTasksCount).toBe(1);
    expect(thursday?.focusSeconds).toBe(1500);

    // Backup export + dry-run validation + unconfirmed replace refusal
    const backup = service.exportBackup();
    expect(backup.formatVersion).toBe(BACKUP_FORMAT_VERSION);
    const conflictValidation = service.validateImport(backup, 'merge');
    expect(conflictValidation.valid).toBe(false);
    expect(conflictValidation.conflicts.length).toBeGreaterThan(0);

    expect(() => service.importBackup(backup, { mode: 'replace', confirm: false })).toThrow(
      DaymarkError,
    );
  });
});
