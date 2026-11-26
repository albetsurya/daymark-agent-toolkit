import {
  APP_VERSION,
  BACKUP_FORMAT_VERSION,
  type BackupArchive,
  BackupArchiveSchema,
  type CaptureTaskInput,
  CaptureTaskInputSchema,
  type CaptureTaskOutput,
  type CompleteTaskInput,
  CompleteTaskInputSchema,
  type CompleteTaskOutput,
  type CreateProjectInput,
  CreateProjectInputSchema,
  type CreateProjectOutput,
  type DailyReviewOutput,
  DaymarkError,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  DEFAULT_LIST_LIMIT,
  type FinishFocusInput,
  FinishFocusInputSchema,
  type FinishFocusOutput,
  type GenerateDailyReviewInput,
  GenerateDailyReviewInputSchema,
  type GenerateWeeklyReviewInput,
  GenerateWeeklyReviewInputSchema,
  type GetStatusInput,
  GetStatusInputSchema,
  type GetTaskInput,
  GetTaskInputSchema,
  type GetTaskOutput,
  type GetTodayPlanInput,
  GetTodayPlanInputSchema,
  type GetTodayPlanOutput,
  type ImportMode,
  type ImportResult,
  type ImportValidationResult,
  type ListFocusSessionsInput,
  ListFocusSessionsInputSchema,
  type ListFocusSessionsOutput,
  type ListProjectsInput,
  ListProjectsInputSchema,
  type ListProjectsOutput,
  type ListTasksInput,
  ListTasksInputSchema,
  type ListTasksOutput,
  type ListWorklogInput,
  ListWorklogInputSchema,
  type ListWorklogOutput,
  type LogWorkInput,
  LogWorkInputSchema,
  type LogWorkOutput,
  type SettingsDto,
  type StartFocusInput,
  StartFocusInputSchema,
  type StartFocusOutput,
  type SystemStatus,
  type UpdateProjectInput,
  UpdateProjectInputSchema,
  type UpdateProjectOutput,
  type UpdateTaskInput,
  UpdateTaskInputSchema,
  type UpdateTaskOutput,
  type WeeklyReviewOutput,
} from '@daymark/contracts';
import type * as z from 'zod';
import { computeDailyPlan } from './planner.js';
import {
  type DaymarkRepositories,
  type DaymarkStore,
  decodeOffsetCursor,
  encodeOffsetCursor,
} from './ports.js';
import { computeDailyReview, computeWeeklyReview } from './reviews.js';
import {
  normalizeTags,
  toFocusSessionDto,
  toProjectDto,
  toTaskDto,
  toTaskSummaryDto,
  toWorklogEntryDto,
  validateTaskStatusTransition,
} from './rules.js';
import {
  type Clock,
  cryptoIdGenerator,
  endOfLocalDayUtcMs,
  formatUtcMsInTimezoneDate,
  type IdGenerator,
  parseDueInput,
  parseInstantInput,
  parseRangeBoundary,
  resolveEffectiveDueAtMs,
  startOfLocalDayUtcMs,
  systemClock,
  toIsoUtc,
} from './time.js';

function parseWithSchema<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new DaymarkError(
      'VALIDATION_FAILED',
      result.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
      {
        details: {
          issues: result.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
      },
    );
  }
  return result.data;
}

function requireSettings(repos: DaymarkRepositories): SettingsDto {
  const settings = repos.settings.getSettings();
  if (!settings) {
    throw new DaymarkError('PROFILE_NOT_INITIALIZED', 'Daymark profile is not initialized.', {
      nextStep: 'Run `daymark init` to initialize the local Daymark database.',
    });
  }
  return settings;
}

export interface DaymarkServiceDeps {
  store: DaymarkStore;
  clock?: Clock;
  idGenerator?: IdGenerator;
}

export function createDaymarkService(deps: DaymarkServiceDeps) {
  const clock = deps.clock ?? systemClock;
  const idGen = deps.idGenerator ?? cryptoIdGenerator;
  const { store } = deps;

  function ensureStoreReady(): void {
    if (!store.isInitialized()) {
      throw new DaymarkError('PROFILE_NOT_INITIALIZED', 'Daymark profile is not initialized.', {
        nextStep: 'Run `daymark init` to create the local profile and database.',
      });
    }
  }

  return {
    getStatus(input: GetStatusInput = {}): SystemStatus {
      parseWithSchema(GetStatusInputSchema, input);
      const dataDir = store.getDataDir();
      if (!store.isInitialized()) {
        return {
          initialized: false,
          appVersion: APP_VERSION,
          schemaVersion: null,
          timezone: null,
          activeFocusSession: null,
          dataDir,
          dataDirConfigured: dataDir !== null,
          databaseReady: false,
        };
      }
      return store.transaction((repos) => {
        const settings = repos.settings.getSettings();
        const active = repos.focusSessions.findActive();
        return {
          initialized: settings !== null,
          appVersion: APP_VERSION,
          schemaVersion: store.getSchemaVersion(),
          timezone: settings?.timezone ?? null,
          activeFocusSession: active
            ? {
                id: active.id,
                taskId: active.taskId,
                projectId: active.projectId,
                startedAt: toIsoUtc(active.startedAtMs),
                sourceAgent: active.sourceAgent,
                note: active.note,
              }
            : null,
          dataDir,
          dataDirConfigured: dataDir !== null,
          databaseReady: true,
        };
      });
    },

    listProjects(input: ListProjectsInput = {}): ListProjectsOutput {
      const args = parseWithSchema(ListProjectsInputSchema, input);
      ensureStoreReady();
      const limit = args.limit ?? DEFAULT_LIST_LIMIT;
      const offset = decodeOffsetCursor(args.cursor);
      return store.transaction((repos) => {
        requireSettings(repos);
        const page = repos.projects.list({
          status: args.status ?? 'active',
          limit,
          offset,
        });
        return {
          projects: page.items.map(toProjectDto),
          nextCursor: page.hasMore ? encodeOffsetCursor(offset + page.items.length) : null,
        };
      });
    },

    createProject(input: CreateProjectInput): CreateProjectOutput {
      const args = parseWithSchema(CreateProjectInputSchema, input);
      ensureStoreReady();
      const nowMs = clock.nowMs();
      return store.transaction((repos) => {
        requireSettings(repos);
        const record = {
          id: idGen.nextId(),
          name: args.name,
          description: args.description?.trim() ? args.description.trim() : null,
          status: 'active' as const,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          archivedAtMs: null,
        };
        repos.projects.create(record);
        return { project: toProjectDto(record) };
      });
    },

    updateProject(input: UpdateProjectInput): UpdateProjectOutput {
      const args = parseWithSchema(UpdateProjectInputSchema, input);
      ensureStoreReady();
      const nowMs = clock.nowMs();
      return store.transaction((repos) => {
        requireSettings(repos);
        const existing = repos.projects.findById(args.projectId);
        if (!existing) {
          throw new DaymarkError(
            'PROJECT_NOT_FOUND',
            `Project "${args.projectId}" was not found.`,
            {
              nextStep: 'List available projects with daymark_list_projects.',
            },
          );
        }
        let archivedAtMs = existing.archivedAtMs;
        if (args.status === 'archived' && existing.status !== 'archived') {
          archivedAtMs = nowMs;
        } else if (args.status === 'active') {
          archivedAtMs = null;
        }
        const updated = repos.projects.update(args.projectId, {
          name: args.name,
          description:
            args.description === undefined
              ? undefined
              : args.description === null
                ? null
                : args.description.trim() || null,
          status: args.status,
          updatedAtMs: nowMs,
          archivedAtMs,
        });
        if (!updated) {
          throw new DaymarkError('PROJECT_NOT_FOUND', `Project "${args.projectId}" was not found.`);
        }
        return { project: toProjectDto(updated) };
      });
    },

    listTasks(input: ListTasksInput = {}): ListTasksOutput {
      const args = parseWithSchema(ListTasksInputSchema, input);
      ensureStoreReady();
      const limit = args.limit ?? DEFAULT_LIST_LIMIT;
      const offset = decodeOffsetCursor(args.cursor);

      return store.transaction((repos) => {
        const settings = requireSettings(repos);
        const dueBeforeMs =
          args.dueBefore !== undefined
            ? parseRangeBoundary(args.dueBefore, settings.timezone, 'end')
            : undefined;
        const dueAfterMs =
          args.dueAfter !== undefined
            ? parseRangeBoundary(args.dueAfter, settings.timezone, 'start')
            : undefined;
        if (dueBeforeMs !== undefined && dueAfterMs !== undefined && dueAfterMs > dueBeforeMs) {
          throw new DaymarkError(
            'INVALID_TIME_RANGE',
            'dueAfter must not be later than dueBefore.',
          );
        }

        const statuses =
          args.status === undefined
            ? undefined
            : Array.isArray(args.status)
              ? args.status
              : [args.status];

        const all = repos.tasks.listAll({
          statuses,
          priority: args.priority,
          projectId: args.projectId,
          query: args.query,
        });

        const filtered =
          dueBeforeMs !== undefined || dueAfterMs !== undefined
            ? all.filter((task) => {
                const eff = resolveEffectiveDueAtMs(task, settings.timezone);
                if (eff === null) return false;
                if (dueAfterMs !== undefined && eff < dueAfterMs) return false;
                if (dueBeforeMs !== undefined && eff > dueBeforeMs) return false;
                return true;
              })
            : all;

        const slice = filtered.slice(offset, offset + limit);
        const hasMore = offset + slice.length < filtered.length;
        return {
          tasks: slice.map((t) => toTaskSummaryDto(t, settings.timezone)),
          nextCursor: hasMore ? encodeOffsetCursor(offset + slice.length) : null,
        };
      });
    },

    getTask(input: GetTaskInput): GetTaskOutput {
      const args = parseWithSchema(GetTaskInputSchema, input);
      ensureStoreReady();
      return store.transaction((repos) => {
        const settings = requireSettings(repos);
        const found = repos.tasks.findById(args.taskId);
        if (!found) {
          throw new DaymarkError('TASK_NOT_FOUND', `Task "${args.taskId}" was not found.`, {
            nextStep: 'Search tasks with daymark_list_tasks.',
          });
        }
        return {
          task: toTaskDto(found, settings.timezone),
          projectName: found.projectName,
        };
      });
    },

    captureTask(input: CaptureTaskInput): CaptureTaskOutput {
      const args = parseWithSchema(CaptureTaskInputSchema, input);
      ensureStoreReady();
      const nowMs = clock.nowMs();

      const unspecifiedFields: string[] = [];
      if (args.description === undefined) unspecifiedFields.push('description');
      if (args.projectId === undefined) unspecifiedFields.push('projectId');
      if (args.priority === undefined) unspecifiedFields.push('priority');
      if (args.estimateMinutes === undefined) unspecifiedFields.push('estimateMinutes');
      if (args.dueAt === undefined) unspecifiedFields.push('dueAt');
      if (args.tags === undefined || args.tags.length === 0) unspecifiedFields.push('tags');

      return store.transaction((repos) => {
        const settings = requireSettings(repos);

        if (args.idempotencyKey) {
          const existingId = repos.idempotency.findResourceId(
            'capture_task',
            args.idempotencyKey,
            nowMs,
          );
          if (existingId) {
            const existingTask = repos.tasks.findById(existingId);
            if (existingTask) {
              return {
                task: toTaskDto(existingTask, settings.timezone),
                unspecifiedFields,
                deduplicated: true,
              };
            }
          }
        }

        if (args.projectId !== undefined && !repos.projects.findById(args.projectId)) {
          throw new DaymarkError(
            'PROJECT_NOT_FOUND',
            `Project "${args.projectId}" was not found.`,
            {
              nextStep: 'Create or list projects before assigning a projectId.',
            },
          );
        }

        const parsedDue =
          args.dueAt !== undefined
            ? parseDueInput(args.dueAt, settings.timezone)
            : { dueAtMs: null, dueDate: null };

        const taskId = idGen.nextId();
        const tags = normalizeTags(args.tags);
        repos.tasks.create({
          id: taskId,
          title: args.title,
          description: args.description?.trim() ? args.description.trim() : null,
          projectId: args.projectId ?? null,
          status: 'todo',
          priority: args.priority ?? 'none',
          estimateMinutes: args.estimateMinutes ?? null,
          dueAtMs: parsedDue.dueAtMs,
          dueDate: parsedDue.dueDate,
          completedAtMs: null,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
          sourceAgent: args.sourceAgent ?? 'unknown',
          externalRef: null,
          tags,
        });

        if (args.idempotencyKey) {
          repos.idempotency.save(
            'capture_task',
            args.idempotencyKey,
            taskId,
            nowMs,
            nowMs + DEFAULT_IDEMPOTENCY_TTL_MS,
          );
        }

        const created = repos.tasks.findById(taskId);
        if (!created) {
          throw new DaymarkError('INTERNAL_ERROR', 'Captured task could not be reloaded.');
        }
        return {
          task: toTaskDto(created, settings.timezone),
          unspecifiedFields,
          deduplicated: false,
        };
      });
    },

    updateTask(input: UpdateTaskInput): UpdateTaskOutput {
      const args = parseWithSchema(UpdateTaskInputSchema, input);
      ensureStoreReady();
      const nowMs = clock.nowMs();

      return store.transaction((repos) => {
        const settings = requireSettings(repos);
        const existing = repos.tasks.findById(args.taskId);
        if (!existing) {
          throw new DaymarkError('TASK_NOT_FOUND', `Task "${args.taskId}" was not found.`);
        }

        if (args.projectId !== undefined && args.projectId !== null) {
          if (!repos.projects.findById(args.projectId)) {
            throw new DaymarkError(
              'PROJECT_NOT_FOUND',
              `Project "${args.projectId}" was not found.`,
            );
          }
        }

        let completedAtMs: number | null | undefined;
        if (args.status !== undefined) {
          validateTaskStatusTransition(existing.status, args.status);
          if (args.status === 'completed' && existing.status !== 'completed') {
            completedAtMs = nowMs;
          } else if (
            existing.status === 'completed' &&
            (args.status === 'inbox' || args.status === 'todo' || args.status === 'in_progress')
          ) {
            completedAtMs = null;
          }
        }

        let dueAtMs: number | null | undefined;
        let dueDate: string | null | undefined;
        if (args.dueAt === null) {
          dueAtMs = null;
          dueDate = null;
        } else if (args.dueAt !== undefined) {
          const parsed = parseDueInput(args.dueAt, settings.timezone);
          dueAtMs = parsed.dueAtMs;
          dueDate = parsed.dueDate;
        }

        const updated = repos.tasks.update(args.taskId, {
          title: args.title,
          description:
            args.description === undefined
              ? undefined
              : args.description === null
                ? null
                : args.description.trim() || null,
          projectId: args.projectId,
          status: args.status,
          priority: args.priority,
          estimateMinutes: args.estimateMinutes,
          dueAtMs,
          dueDate,
          completedAtMs,
          updatedAtMs: nowMs,
          tags: args.tags !== undefined ? normalizeTags(args.tags) : undefined,
        });

        if (!updated) {
          throw new DaymarkError('TASK_NOT_FOUND', `Task "${args.taskId}" was not found.`);
        }
        return { task: toTaskDto(updated, settings.timezone) };
      });
    },

    completeTask(input: CompleteTaskInput): CompleteTaskOutput {
      const args = parseWithSchema(CompleteTaskInputSchema, input);
      ensureStoreReady();
      const nowMs = clock.nowMs();

      return store.transaction((repos) => {
        const settings = requireSettings(repos);
        const existing = repos.tasks.findById(args.taskId);
        if (!existing) {
          throw new DaymarkError('TASK_NOT_FOUND', `Task "${args.taskId}" was not found.`);
        }
        if (existing.status === 'completed') {
          throw new DaymarkError(
            'INVALID_STATUS_TRANSITION',
            `Task "${args.taskId}" is already completed.`,
          );
        }
        validateTaskStatusTransition(existing.status, 'completed');

        const updated = repos.tasks.update(args.taskId, {
          status: 'completed',
          completedAtMs: nowMs,
          updatedAtMs: nowMs,
        });
        if (!updated) {
          throw new DaymarkError('TASK_NOT_FOUND', `Task "${args.taskId}" was not found.`);
        }

        let worklogEntry = null;
        if (args.completionNote !== undefined) {
          const entry = {
            id: idGen.nextId(),
            taskId: updated.id,
            projectId: updated.projectId,
            focusSessionId: null,
            summary: args.completionNote,
            details: null,
            durationMinutes: null,
            occurredAtMs: nowMs,
            sourceAgent: args.sourceAgent ?? 'unknown',
            createdAtMs: nowMs,
          };
          repos.worklogs.create(entry);
          worklogEntry = toWorklogEntryDto(entry);
        }

        return {
          task: toTaskDto(updated, settings.timezone),
          worklogEntry,
        };
      });
    },

    getTodayPlan(input: GetTodayPlanInput = {}): GetTodayPlanOutput {
      const args = parseWithSchema(GetTodayPlanInputSchema, input);
      ensureStoreReady();
      const nowMs = clock.nowMs();

      return store.transaction((repos) => {
        const settings = requireSettings(repos);
        const availableMinutes = args.availableMinutes ?? settings.defaultPlanMinutes;
        if (availableMinutes === null || availableMinutes === undefined) {
          throw new DaymarkError(
            'VALIDATION_FAILED',
            'Available time budget (availableMinutes) is required when default_plan_minutes is not configured.',
            {
              nextStep:
                'Ask the user how many minutes are available today and pass availableMinutes.',
            },
          );
        }
        const planDate = args.date ?? formatUtcMsInTimezoneDate(nowMs, settings.timezone);
        const openTasks = repos.tasks.listOpen();
        return computeDailyPlan({
          tasks: openTasks,
          planDate,
          timezone: settings.timezone,
          availableMinutes,
          nowMs,
        });
      });
    },

    startFocus(input: StartFocusInput = {}): StartFocusOutput {
      const args = parseWithSchema(StartFocusInputSchema, input);
      ensureStoreReady();
      const nowMs = clock.nowMs();

      return store.transaction((repos) => {
        requireSettings(repos);
        const active = repos.focusSessions.findActive();
        if (active) {
          throw new DaymarkError(
            'FOCUS_SESSION_ALREADY_ACTIVE',
            `Focus session "${active.id}" is already active.`,
            {
              nextStep: 'Finish or interrupt the active focus session before starting another.',
              details: { activeSessionId: active.id },
            },
          );
        }

        let resolvedProjectId = args.projectId ?? null;
        if (args.taskId !== undefined) {
          const task = repos.tasks.findById(args.taskId);
          if (!task) {
            throw new DaymarkError('TASK_NOT_FOUND', `Task "${args.taskId}" was not found.`);
          }
          if (args.projectId === undefined) {
            resolvedProjectId = task.projectId;
          }
        }
        if (resolvedProjectId !== null && !repos.projects.findById(resolvedProjectId)) {
          throw new DaymarkError(
            'PROJECT_NOT_FOUND',
            `Project "${resolvedProjectId}" was not found.`,
          );
        }

        const record = {
          id: idGen.nextId(),
          taskId: args.taskId ?? null,
          projectId: resolvedProjectId,
          status: 'active' as const,
          startedAtMs: nowMs,
          endedAtMs: null,
          durationSeconds: null,
          note: args.note?.trim() ? args.note.trim() : null,
          sourceAgent: args.sourceAgent ?? 'unknown',
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        };
        repos.focusSessions.create(record);
        return { session: toFocusSessionDto(record) };
      });
    },

    finishFocus(input: FinishFocusInput = {}): FinishFocusOutput {
      const args = parseWithSchema(FinishFocusInputSchema, input);
      ensureStoreReady();
      const nowMs = clock.nowMs();

      return store.transaction((repos) => {
        requireSettings(repos);
        const session =
          args.sessionId !== undefined
            ? repos.focusSessions.findById(args.sessionId)
            : repos.focusSessions.findActive();

        if (!session) {
          if (args.sessionId !== undefined) {
            throw new DaymarkError(
              'FOCUS_SESSION_NOT_FOUND',
              `Focus session "${args.sessionId}" was not found.`,
            );
          }
          throw new DaymarkError(
            'FOCUS_SESSION_NOT_ACTIVE',
            'There is no active focus session to finish.',
            { nextStep: 'Start a focus session first before calling finish.' },
          );
        }

        if (session.status !== 'active') {
          throw new DaymarkError(
            'FOCUS_SESSION_NOT_ACTIVE',
            `Focus session "${session.id}" is already ${session.status}.`,
          );
        }

        if (nowMs < session.startedAtMs) {
          throw new DaymarkError(
            'INVALID_TIME_RANGE',
            'Focus finish timestamp cannot precede start timestamp.',
          );
        }

        const durationSeconds = Math.floor((nowMs - session.startedAtMs) / 1000);
        const finalNote = args.note !== undefined ? args.note.trim() || null : session.note;
        const targetStatus = args.status ?? 'completed';

        const finished = repos.focusSessions.finish(session.id, {
          status: targetStatus,
          endedAtMs: nowMs,
          durationSeconds,
          note: finalNote,
          updatedAtMs: nowMs,
        });
        if (!finished) {
          throw new DaymarkError(
            'FOCUS_SESSION_NOT_FOUND',
            `Focus session "${session.id}" not found.`,
          );
        }

        let worklogEntry = null;
        if (args.createWorklog) {
          let summary = finalNote;
          if (!summary && finished.taskId) {
            const task = repos.tasks.findById(finished.taskId);
            summary = task ? `Focus session on: ${task.title}` : 'Focus session completed';
          }
          if (!summary) {
            summary =
              targetStatus === 'interrupted'
                ? 'Focus session interrupted'
                : 'Focus session completed';
          }
          const durationMinutes = Math.min(1_440, Math.max(0, Math.round(durationSeconds / 60)));
          const entry = {
            id: idGen.nextId(),
            taskId: finished.taskId,
            projectId: finished.projectId,
            focusSessionId: finished.id,
            summary,
            details: null,
            durationMinutes,
            occurredAtMs: nowMs,
            sourceAgent: finished.sourceAgent,
            createdAtMs: nowMs,
          };
          repos.worklogs.create(entry);
          worklogEntry = toWorklogEntryDto(entry);
        }

        return {
          session: toFocusSessionDto(finished),
          worklogEntry,
        };
      });
    },

    listFocusSessions(input: ListFocusSessionsInput = {}): ListFocusSessionsOutput {
      const args = parseWithSchema(ListFocusSessionsInputSchema, input);
      ensureStoreReady();
      const limit = args.limit ?? DEFAULT_LIST_LIMIT;
      const offset = decodeOffsetCursor(args.cursor);
      return store.transaction((repos) => {
        requireSettings(repos);
        const page = repos.focusSessions.list({
          status: args.status ?? 'all',
          taskId: args.taskId,
          projectId: args.projectId,
          limit,
          offset,
        });
        return {
          sessions: page.items.map(toFocusSessionDto),
          nextCursor: page.hasMore ? encodeOffsetCursor(offset + page.items.length) : null,
        };
      });
    },

    logWork(input: LogWorkInput): LogWorkOutput {
      const args = parseWithSchema(LogWorkInputSchema, input);
      ensureStoreReady();
      const nowMs = clock.nowMs();

      return store.transaction((repos) => {
        const settings = requireSettings(repos);

        if (args.idempotencyKey) {
          const existingId = repos.idempotency.findResourceId(
            'log_work',
            args.idempotencyKey,
            nowMs,
          );
          if (existingId) {
            const existing = repos.worklogs.findById(existingId);
            if (existing) {
              return { entry: toWorklogEntryDto(existing), deduplicated: true };
            }
          }
        }

        let resolvedProjectId = args.projectId ?? null;
        if (args.taskId !== undefined) {
          const task = repos.tasks.findById(args.taskId);
          if (!task) {
            throw new DaymarkError('TASK_NOT_FOUND', `Task "${args.taskId}" was not found.`);
          }
          if (args.projectId === undefined) {
            resolvedProjectId = task.projectId;
          }
        }
        if (resolvedProjectId !== null && !repos.projects.findById(resolvedProjectId)) {
          throw new DaymarkError(
            'PROJECT_NOT_FOUND',
            `Project "${resolvedProjectId}" was not found.`,
          );
        }
        if (
          args.focusSessionId !== undefined &&
          !repos.focusSessions.findById(args.focusSessionId)
        ) {
          throw new DaymarkError(
            'FOCUS_SESSION_NOT_FOUND',
            `Focus session "${args.focusSessionId}" was not found.`,
          );
        }

        let occurredAtMs = nowMs;
        if (args.occurredAt !== undefined) {
          occurredAtMs = /^\d{4}-\d{2}-\d{2}$/.test(args.occurredAt)
            ? endOfLocalDayUtcMs(args.occurredAt, settings.timezone)
            : parseInstantInput(args.occurredAt);
        }

        const entryId = idGen.nextId();
        const record = {
          id: entryId,
          taskId: args.taskId ?? null,
          projectId: resolvedProjectId,
          focusSessionId: args.focusSessionId ?? null,
          summary: args.summary,
          details: args.details?.trim() ? args.details.trim() : null,
          durationMinutes: args.durationMinutes ?? null,
          occurredAtMs,
          sourceAgent: args.sourceAgent ?? 'unknown',
          createdAtMs: nowMs,
        };
        repos.worklogs.create(record);

        if (args.idempotencyKey) {
          repos.idempotency.save(
            'log_work',
            args.idempotencyKey,
            entryId,
            nowMs,
            nowMs + DEFAULT_IDEMPOTENCY_TTL_MS,
          );
        }

        return { entry: toWorklogEntryDto(record), deduplicated: false };
      });
    },

    listWorklog(input: ListWorklogInput): ListWorklogOutput {
      const args = parseWithSchema(ListWorklogInputSchema, input);
      ensureStoreReady();
      const limit = args.limit ?? DEFAULT_LIST_LIMIT;
      const offset = decodeOffsetCursor(args.cursor);

      return store.transaction((repos) => {
        const settings = requireSettings(repos);
        const fromMs = parseRangeBoundary(args.from, settings.timezone, 'start');
        const toMs = parseRangeBoundary(args.to, settings.timezone, 'end');
        if (fromMs > toMs) {
          throw new DaymarkError(
            'INVALID_TIME_RANGE',
            'Worklog query "from" must not be later than "to".',
          );
        }

        const all = repos.worklogs.listInRange({
          fromMs,
          toMs,
          projectId: args.projectId,
          taskId: args.taskId,
          sourceAgent: args.sourceAgent,
        });

        const totalDurationMinutes = all.reduce((sum, w) => sum + (w.durationMinutes ?? 0), 0);
        const entriesWithoutDuration = all.filter((w) => w.durationMinutes === null).length;
        const page = all.slice(offset, offset + limit);
        const hasMore = offset + page.length < all.length;

        return {
          entries: page.map(toWorklogEntryDto),
          totalEntries: all.length,
          totalDurationMinutes,
          entriesWithoutDuration,
          nextCursor: hasMore ? encodeOffsetCursor(offset + page.length) : null,
        };
      });
    },

    generateDailyReview(input: GenerateDailyReviewInput = {}): DailyReviewOutput {
      const args = parseWithSchema(GenerateDailyReviewInputSchema, input);
      ensureStoreReady();
      const nowMs = clock.nowMs();

      return store.transaction((repos) => {
        const settings = requireSettings(repos);
        const date = args.date ?? formatUtcMsInTimezoneDate(nowMs, settings.timezone);
        const fromMs = startOfLocalDayUtcMs(date, settings.timezone);
        const toMs = endOfLocalDayUtcMs(date, settings.timezone);

        const completedTasks = repos.tasks.listCompletedInRange(fromMs, toMs);
        const openTasks = repos.tasks.listOpen();
        const focusSessionsInRange = repos.focusSessions.listInRange(fromMs, toMs);
        const activeFocus = repos.focusSessions.findActive();
        const worklogEntries = repos.worklogs.listInRange({ fromMs, toMs });

        return computeDailyReview({
          date,
          timezone: settings.timezone,
          nowMs,
          completedTasks,
          openTasks,
          focusSessionsInRange,
          activeFocusSessions: activeFocus ? [activeFocus] : [],
          worklogEntries,
        });
      });
    },

    generateWeeklyReview(input: GenerateWeeklyReviewInput = {}): WeeklyReviewOutput {
      const args = parseWithSchema(GenerateWeeklyReviewInputSchema, input);
      ensureStoreReady();
      const nowMs = clock.nowMs();

      return store.transaction((repos) => {
        const settings = requireSettings(repos);
        const weekOfDate = args.weekOf ?? formatUtcMsInTimezoneDate(nowMs, settings.timezone);
        const tentative = computeWeeklyReview({
          weekOfDate,
          weekStartsOn: settings.weekStartsOn,
          timezone: settings.timezone,
          nowMs,
          completedTasks: [],
          openTasks: [],
          focusSessionsInRange: [],
          activeFocusSessions: [],
          worklogEntries: [],
        });

        const fromMs = startOfLocalDayUtcMs(tentative.weekStartDate, settings.timezone);
        const toMs = endOfLocalDayUtcMs(tentative.weekEndDate, settings.timezone);

        const completedTasks = repos.tasks.listCompletedInRange(fromMs, toMs);
        const openTasks = repos.tasks.listOpen();
        const focusSessionsInRange = repos.focusSessions.listInRange(fromMs, toMs);
        const activeFocus = repos.focusSessions.findActive();
        const worklogEntries = repos.worklogs.listInRange({ fromMs, toMs });

        return computeWeeklyReview({
          weekOfDate,
          weekStartsOn: settings.weekStartsOn,
          timezone: settings.timezone,
          nowMs,
          completedTasks,
          openTasks,
          focusSessionsInRange,
          activeFocusSessions: activeFocus ? [activeFocus] : [],
          worklogEntries,
        });
      });
    },

    exportBackup(): BackupArchive {
      ensureStoreReady();
      const nowMs = clock.nowMs();
      return store.transaction((repos) => {
        const snap = repos.backup.exportSnapshot();
        return {
          formatVersion: BACKUP_FORMAT_VERSION,
          appVersion: APP_VERSION,
          exportedAt: toIsoUtc(nowMs),
          data: {
            settings: snap.settings,
            projects: snap.projects.map(toProjectDto),
            tasks: snap.tasks.map((t) => ({
              id: t.id,
              title: t.title,
              description: t.description,
              projectId: t.projectId,
              status: t.status,
              priority: t.priority,
              estimateMinutes: t.estimateMinutes,
              dueAt: t.dueAtMs !== null ? toIsoUtc(t.dueAtMs) : null,
              dueDate: t.dueDate,
              completedAt: t.completedAtMs !== null ? toIsoUtc(t.completedAtMs) : null,
              createdAt: toIsoUtc(t.createdAtMs),
              updatedAt: toIsoUtc(t.updatedAtMs),
              sourceAgent: t.sourceAgent,
              externalRef: t.externalRef,
            })),
            tags: snap.tags.map((tag) => ({
              id: tag.id,
              name: tag.name,
              createdAt: toIsoUtc(tag.createdAtMs),
            })),
            taskTags: snap.taskTags,
            focusSessions: snap.focusSessions.map(toFocusSessionDto),
            worklogEntries: snap.worklogEntries.map(toWorklogEntryDto),
          },
        };
      });
    },

    validateImport(rawArchive: unknown, mode: ImportMode = 'merge'): ImportValidationResult {
      ensureStoreReady();
      const parsed = BackupArchiveSchema.safeParse(rawArchive);
      if (!parsed.success) {
        return {
          valid: false,
          formatVersion: null,
          mode,
          counts: {
            projects: 0,
            tasks: 0,
            tags: 0,
            taskTags: 0,
            focusSessions: 0,
            worklogEntries: 0,
          },
          conflicts: [],
          errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'archive'}: ${i.message}`),
        };
      }
      const archive = parsed.data;
      const errors: string[] = [];
      if (archive.formatVersion !== BACKUP_FORMAT_VERSION) {
        errors.push(`Unsupported backup formatVersion: ${archive.formatVersion}`);
      }

      const checkDuplicates = (items: { id: string }[], label: string) => {
        const seen = new Set<string>();
        for (const item of items) {
          if (seen.has(item.id)) errors.push(`Duplicate ${label} ID in archive: ${item.id}`);
          seen.add(item.id);
        }
        return seen;
      };

      const projectIds = checkDuplicates(archive.data.projects, 'project');
      const taskIds = checkDuplicates(archive.data.tasks, 'task');
      const tagIds = checkDuplicates(archive.data.tags, 'tag');
      const focusIds = checkDuplicates(archive.data.focusSessions, 'focusSession');
      checkDuplicates(archive.data.worklogEntries, 'worklogEntry');

      for (const task of archive.data.tasks) {
        if (task.projectId && !projectIds.has(task.projectId)) {
          errors.push(`Task ${task.id} references missing project ${task.projectId}`);
        }
      }
      for (const tt of archive.data.taskTags) {
        if (!taskIds.has(tt.taskId) || !tagIds.has(tt.tagId)) {
          errors.push(`TaskTag (${tt.taskId}, ${tt.tagId}) references missing task or tag`);
        }
      }
      for (const fs of archive.data.focusSessions) {
        if (fs.taskId && !taskIds.has(fs.taskId)) {
          errors.push(`FocusSession ${fs.id} references missing task ${fs.taskId}`);
        }
        if (fs.projectId && !projectIds.has(fs.projectId)) {
          errors.push(`FocusSession ${fs.id} references missing project ${fs.projectId}`);
        }
      }
      for (const wl of archive.data.worklogEntries) {
        if (wl.taskId && !taskIds.has(wl.taskId)) {
          errors.push(`Worklog ${wl.id} references missing task ${wl.taskId}`);
        }
        if (wl.projectId && !projectIds.has(wl.projectId)) {
          errors.push(`Worklog ${wl.id} references missing project ${wl.projectId}`);
        }
        if (wl.focusSessionId && !focusIds.has(wl.focusSessionId)) {
          errors.push(`Worklog ${wl.id} references missing focusSession ${wl.focusSessionId}`);
        }
      }

      const activeFocusCount = archive.data.focusSessions.filter(
        (f) => f.status === 'active',
      ).length;
      if (activeFocusCount > 1) {
        errors.push(
          `Archive contains ${activeFocusCount} active focus sessions; at most 1 is allowed.`,
        );
      }

      const conflicts =
        mode === 'merge'
          ? store.transaction((repos) => repos.backup.findConflictingIds(archive))
          : [];

      return {
        valid: errors.length === 0 && conflicts.length === 0,
        formatVersion: archive.formatVersion,
        mode,
        counts: {
          projects: archive.data.projects.length,
          tasks: archive.data.tasks.length,
          tags: archive.data.tags.length,
          taskTags: archive.data.taskTags.length,
          focusSessions: archive.data.focusSessions.length,
          worklogEntries: archive.data.worklogEntries.length,
        },
        conflicts,
        errors,
      };
    },

    importBackup(
      rawArchive: unknown,
      options: { mode?: ImportMode; confirm?: boolean } = {},
    ): ImportResult {
      ensureStoreReady();
      const mode = options.mode ?? 'merge';
      if (mode === 'replace' && !options.confirm) {
        throw new DaymarkError(
          'CONFIRMATION_REQUIRED',
          'Destructive replace import requires explicit confirmation.',
          {
            nextStep: 'Pass confirm: true (or --confirm in CLI) after running dry-run validation.',
          },
        );
      }

      const validation = this.validateImport(rawArchive, mode);
      if (validation.formatVersion !== null && validation.formatVersion !== BACKUP_FORMAT_VERSION) {
        throw new DaymarkError(
          'BACKUP_VERSION_UNSUPPORTED',
          `Backup version ${validation.formatVersion} is not supported.`,
        );
      }
      if (validation.errors.length > 0) {
        throw new DaymarkError('VALIDATION_FAILED', validation.errors.join('; '));
      }
      if (validation.conflicts.length > 0) {
        throw new DaymarkError(
          'IMPORT_CONFLICT',
          `Import conflicts on existing IDs: ${validation.conflicts.slice(0, 5).join(', ')}`,
          {
            nextStep:
              'Use mode="replace" with explicit confirmation if overwriting an existing profile.',
          },
        );
      }

      const archive = BackupArchiveSchema.parse(rawArchive);
      const nowMs = clock.nowMs();
      store.transaction((repos) => {
        if (mode === 'merge') {
          const existingActive = repos.focusSessions.findActive();
          const incomingActive = archive.data.focusSessions.some((f) => f.status === 'active');
          if (existingActive && incomingActive) {
            throw new DaymarkError(
              'FOCUS_SESSION_ALREADY_ACTIVE',
              'Cannot merge an archive containing an active focus session while one is already active.',
            );
          }
        }
        repos.backup.importSnapshot(archive, mode, nowMs);
      });

      return {
        mode,
        imported: validation.counts,
      };
    },
  };
}

export type DaymarkService = ReturnType<typeof createDaymarkService>;
