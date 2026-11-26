import * as z from 'zod';

export const APP_VERSION = '0.1.0';
export const BACKUP_FORMAT_VERSION = 1;
export const LATEST_SCHEMA_VERSION = '0001_due_date_and_indexes';
export const MAX_LIST_LIMIT = 100;
export const DEFAULT_LIST_LIMIT = 50;
export const DEFAULT_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const ErrorCodeSchema = z.enum([
  'PROFILE_NOT_INITIALIZED',
  'TASK_NOT_FOUND',
  'PROJECT_NOT_FOUND',
  'FOCUS_SESSION_NOT_FOUND',
  'INVALID_STATUS_TRANSITION',
  'INVALID_TIME_RANGE',
  'INVALID_TIMEZONE',
  'FOCUS_SESSION_ALREADY_ACTIVE',
  'FOCUS_SESSION_NOT_ACTIVE',
  'VALIDATION_FAILED',
  'DATABASE_BUSY',
  'IMPORT_CONFLICT',
  'BACKUP_VERSION_UNSUPPORTED',
  'CONFIRMATION_REQUIRED',
  'INTERNAL_ERROR',
]);

export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export class DaymarkError extends Error {
  readonly code: ErrorCode;
  readonly nextStep?: string;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: {
      nextStep?: string;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'DaymarkError';
    this.code = code;
    this.nextStep = options?.nextStep;
    this.details = options?.details;
  }
}

export const AgentSourceSchema = z.enum([
  'claude-code',
  'codex',
  'cursor',
  'antigravity',
  'opencode',
  'cli',
  'other',
  'unknown',
]);
export type AgentSource = z.infer<typeof AgentSourceSchema>;

export const ProjectStatusSchema = z.enum(['active', 'archived']);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

export const TaskStatusSchema = z.enum([
  'inbox',
  'todo',
  'in_progress',
  'completed',
  'cancelled',
  'archived',
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const PrioritySchema = z.enum(['none', 'low', 'medium', 'high']);
export type Priority = z.infer<typeof PrioritySchema>;

export const FocusSessionStatusSchema = z.enum(['active', 'completed', 'interrupted']);
export type FocusSessionStatus = z.infer<typeof FocusSessionStatusSchema>;

export const WeekStartsOnSchema = z.enum(['monday', 'sunday']);
export type WeekStartsOn = z.infer<typeof WeekStartsOnSchema>;

export const DateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must use YYYY-MM-DD format');

export const IsoUtcTimestampSchema = z
  .string()
  .datetime({ offset: true, message: 'Timestamp must be an ISO-8601 datetime with timezone/Z' });

export const DueInputSchema = z.union([DateOnlySchema, IsoUtcTimestampSchema]);

export const TimeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must use 24-hour HH:MM format');

export const IdempotencyKeySchema = z.string().trim().min(1).max(128);
export const TagNameSchema = z.string().trim().min(1).max(64);
export const TaskTitleSchema = z.string().trim().min(1).max(240);
export const TaskDescriptionSchema = z.string().max(10_000);
export const ProjectNameSchema = z.string().trim().min(1).max(120);
export const ProjectDescriptionSchema = z.string().max(4_000);
export const WorklogSummarySchema = z.string().trim().min(1).max(2_000);
export const WorklogDetailsSchema = z.string().max(10_000);
export const FocusNoteSchema = z.string().max(2_000);
export const EstimateMinutesSchema = z.number().int().gt(0).lte(10_080);
export const DurationMinutesSchema = z.number().int().gte(0).lte(1_440);
export const ListLimitSchema = z.number().int().min(1).max(MAX_LIST_LIMIT);

// --- Entity DTOs ---

export const ProjectDtoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string().nullable(),
  status: ProjectStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type ProjectDto = z.infer<typeof ProjectDtoSchema>;

export const TaskSummaryDtoSchema = z.object({
  id: z.string().uuid(),
  title: z.string(),
  projectId: z.string().uuid().nullable(),
  projectName: z.string().nullable(),
  status: TaskStatusSchema,
  priority: PrioritySchema,
  estimateMinutes: z.number().int().nullable(),
  dueAt: z.string().nullable(),
  dueDate: DateOnlySchema.nullable(),
  effectiveDueAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sourceAgent: AgentSourceSchema,
  tags: z.array(z.string()),
});
export type TaskSummaryDto = z.infer<typeof TaskSummaryDtoSchema>;

export const TaskDtoSchema = TaskSummaryDtoSchema.extend({
  description: z.string().nullable(),
  externalRef: z.string().nullable(),
});
export type TaskDto = z.infer<typeof TaskDtoSchema>;

export const FocusSessionDtoSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  status: FocusSessionStatusSchema,
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  durationSeconds: z.number().int().nullable(),
  note: z.string().nullable(),
  sourceAgent: AgentSourceSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FocusSessionDto = z.infer<typeof FocusSessionDtoSchema>;

export const ActiveFocusSummarySchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  startedAt: z.string(),
  sourceAgent: AgentSourceSchema,
  note: z.string().nullable(),
});
export type ActiveFocusSummary = z.infer<typeof ActiveFocusSummarySchema>;

export const WorklogEntryDtoSchema = z.object({
  id: z.string().uuid(),
  taskId: z.string().uuid().nullable(),
  projectId: z.string().uuid().nullable(),
  focusSessionId: z.string().uuid().nullable(),
  summary: z.string(),
  details: z.string().nullable(),
  durationMinutes: z.number().int().nullable(),
  occurredAt: z.string(),
  sourceAgent: AgentSourceSchema,
  createdAt: z.string(),
});
export type WorklogEntryDto = z.infer<typeof WorklogEntryDtoSchema>;

export const SettingsDtoSchema = z.object({
  timezone: z.string(),
  weekStartsOn: WeekStartsOnSchema,
  dayStartTime: TimeOfDaySchema,
  defaultPlanMinutes: z.number().int().gt(0).lte(1_440).nullable(),
});
export type SettingsDto = z.infer<typeof SettingsDtoSchema>;

// --- Tool / Use Case Input & Output Schemas ---

export const GetStatusInputSchema = z.object({}).strict();
export type GetStatusInput = z.infer<typeof GetStatusInputSchema>;

export const SystemStatusSchema = z.object({
  initialized: z.boolean(),
  appVersion: z.string(),
  schemaVersion: z.string().nullable(),
  timezone: z.string().nullable(),
  activeFocusSession: ActiveFocusSummarySchema.nullable(),
  dataDir: z.string().nullable(),
  dataDirConfigured: z.boolean(),
  databaseReady: z.boolean(),
});
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

export const ListProjectsInputSchema = z
  .object({
    status: z.enum(['active', 'archived', 'all']).optional(),
    limit: ListLimitSchema.optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type ListProjectsInput = z.infer<typeof ListProjectsInputSchema>;

export const ListProjectsOutputSchema = z.object({
  projects: z.array(ProjectDtoSchema),
  nextCursor: z.string().nullable(),
});
export type ListProjectsOutput = z.infer<typeof ListProjectsOutputSchema>;

export const CreateProjectInputSchema = z
  .object({
    name: ProjectNameSchema,
    description: ProjectDescriptionSchema.optional(),
  })
  .strict();
export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>;

export const CreateProjectOutputSchema = z.object({
  project: ProjectDtoSchema,
});
export type CreateProjectOutput = z.infer<typeof CreateProjectOutputSchema>;

export const UpdateProjectInputSchema = z
  .object({
    projectId: z.string().uuid(),
    name: ProjectNameSchema.optional(),
    description: ProjectDescriptionSchema.nullable().optional(),
    status: ProjectStatusSchema.optional(),
  })
  .strict();
export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>;

export const UpdateProjectOutputSchema = z.object({
  project: ProjectDtoSchema,
});
export type UpdateProjectOutput = z.infer<typeof UpdateProjectOutputSchema>;

export const ListTasksInputSchema = z
  .object({
    status: z.union([TaskStatusSchema, z.array(TaskStatusSchema).min(1)]).optional(),
    priority: PrioritySchema.optional(),
    projectId: z.string().uuid().optional(),
    dueBefore: DueInputSchema.optional(),
    dueAfter: DueInputSchema.optional(),
    query: z.string().trim().max(200).optional(),
    limit: ListLimitSchema.optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type ListTasksInput = z.infer<typeof ListTasksInputSchema>;

export const ListTasksOutputSchema = z.object({
  tasks: z.array(TaskSummaryDtoSchema),
  nextCursor: z.string().nullable(),
});
export type ListTasksOutput = z.infer<typeof ListTasksOutputSchema>;

export const GetTaskInputSchema = z
  .object({
    taskId: z.string().uuid(),
  })
  .strict();
export type GetTaskInput = z.infer<typeof GetTaskInputSchema>;

export const GetTaskOutputSchema = z.object({
  task: TaskDtoSchema,
  projectName: z.string().nullable(),
});
export type GetTaskOutput = z.infer<typeof GetTaskOutputSchema>;

export const CaptureTaskInputSchema = z
  .object({
    title: TaskTitleSchema,
    description: TaskDescriptionSchema.optional(),
    projectId: z.string().uuid().optional(),
    priority: PrioritySchema.optional(),
    estimateMinutes: EstimateMinutesSchema.optional(),
    dueAt: DueInputSchema.optional(),
    tags: z.array(TagNameSchema).max(20).optional(),
    sourceAgent: AgentSourceSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();
export type CaptureTaskInput = z.infer<typeof CaptureTaskInputSchema>;

export const CaptureTaskOutputSchema = z.object({
  task: TaskDtoSchema,
  unspecifiedFields: z.array(z.string()),
  deduplicated: z.boolean(),
});
export type CaptureTaskOutput = z.infer<typeof CaptureTaskOutputSchema>;

export const UpdateTaskInputSchema = z
  .object({
    taskId: z.string().uuid(),
    title: TaskTitleSchema.optional(),
    description: TaskDescriptionSchema.nullable().optional(),
    projectId: z.string().uuid().nullable().optional(),
    priority: PrioritySchema.optional(),
    estimateMinutes: EstimateMinutesSchema.nullable().optional(),
    dueAt: DueInputSchema.nullable().optional(),
    status: TaskStatusSchema.optional(),
    tags: z.array(TagNameSchema).max(20).optional(),
  })
  .strict();
export type UpdateTaskInput = z.infer<typeof UpdateTaskInputSchema>;

export const UpdateTaskOutputSchema = z.object({
  task: TaskDtoSchema,
});
export type UpdateTaskOutput = z.infer<typeof UpdateTaskOutputSchema>;

export const CompleteTaskInputSchema = z
  .object({
    taskId: z.string().uuid(),
    completionNote: WorklogSummarySchema.optional(),
    sourceAgent: AgentSourceSchema.optional(),
  })
  .strict();
export type CompleteTaskInput = z.infer<typeof CompleteTaskInputSchema>;

export const CompleteTaskOutputSchema = z.object({
  task: TaskDtoSchema,
  worklogEntry: WorklogEntryDtoSchema.nullable(),
});
export type CompleteTaskOutput = z.infer<typeof CompleteTaskOutputSchema>;

export const PlanRuleReasonSchema = z.enum([
  'OVERDUE',
  'DUE_TODAY',
  'PRIORITY_HIGH',
  'PRIORITY_MEDIUM',
  'PRIORITY_LOW',
  'PRIORITY_NONE',
  'FITS_BUDGET',
  'MISSING_ESTIMATE',
  'EXCEEDS_REMAINING_BUDGET',
]);
export type PlanRuleReason = z.infer<typeof PlanRuleReasonSchema>;

export const PlannedTaskItemSchema = z.object({
  task: TaskSummaryDtoSchema,
  rank: z.number().int().positive(),
  isOverdue: z.boolean(),
  reasons: z.array(PlanRuleReasonSchema),
  explanation: z.string(),
});
export type PlannedTaskItem = z.infer<typeof PlannedTaskItemSchema>;

export const ExcludedTaskItemSchema = z.object({
  task: TaskSummaryDtoSchema,
  reason: PlanRuleReasonSchema,
  explanation: z.string(),
});
export type ExcludedTaskItem = z.infer<typeof ExcludedTaskItemSchema>;

export const GetTodayPlanInputSchema = z
  .object({
    date: DateOnlySchema.optional(),
    availableMinutes: z.number().int().gte(0).lte(1_440).optional(),
  })
  .strict();
export type GetTodayPlanInput = z.infer<typeof GetTodayPlanInputSchema>;

export const GetTodayPlanOutputSchema = z.object({
  date: DateOnlySchema,
  timezone: z.string(),
  isRecommendation: z.literal(true),
  disclaimer: z.string(),
  availableMinutes: z.number().int().gte(0),
  totalEstimatedMinutes: z.number().int().gte(0),
  remainingMinutes: z.number().int().gte(0),
  overdueCount: z.number().int().gte(0),
  plannedTasks: z.array(PlannedTaskItemSchema),
  unscheduledMissingEstimate: z.array(PlannedTaskItemSchema),
  excludedTasks: z.array(ExcludedTaskItemSchema),
});
export type GetTodayPlanOutput = z.infer<typeof GetTodayPlanOutputSchema>;

export const StartFocusInputSchema = z
  .object({
    taskId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    note: FocusNoteSchema.optional(),
    sourceAgent: AgentSourceSchema.optional(),
  })
  .strict();
export type StartFocusInput = z.infer<typeof StartFocusInputSchema>;

export const StartFocusOutputSchema = z.object({
  session: FocusSessionDtoSchema,
});
export type StartFocusOutput = z.infer<typeof StartFocusOutputSchema>;

export const FinishFocusInputSchema = z
  .object({
    sessionId: z.string().uuid().optional(),
    note: FocusNoteSchema.optional(),
    createWorklog: z.boolean().optional(),
    status: z.enum(['completed', 'interrupted']).optional(),
  })
  .strict();
export type FinishFocusInput = z.infer<typeof FinishFocusInputSchema>;

export const FinishFocusOutputSchema = z.object({
  session: FocusSessionDtoSchema,
  worklogEntry: WorklogEntryDtoSchema.nullable(),
});
export type FinishFocusOutput = z.infer<typeof FinishFocusOutputSchema>;

export const ListFocusSessionsInputSchema = z
  .object({
    status: z.enum(['active', 'completed', 'interrupted', 'all']).optional(),
    taskId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    limit: ListLimitSchema.optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type ListFocusSessionsInput = z.infer<typeof ListFocusSessionsInputSchema>;

export const ListFocusSessionsOutputSchema = z.object({
  sessions: z.array(FocusSessionDtoSchema),
  nextCursor: z.string().nullable(),
});
export type ListFocusSessionsOutput = z.infer<typeof ListFocusSessionsOutputSchema>;

export const LogWorkInputSchema = z
  .object({
    summary: WorklogSummarySchema,
    details: WorklogDetailsSchema.optional(),
    taskId: z.string().uuid().optional(),
    projectId: z.string().uuid().optional(),
    focusSessionId: z.string().uuid().optional(),
    durationMinutes: DurationMinutesSchema.optional(),
    occurredAt: DueInputSchema.optional(),
    sourceAgent: AgentSourceSchema.optional(),
    idempotencyKey: IdempotencyKeySchema.optional(),
  })
  .strict();
export type LogWorkInput = z.infer<typeof LogWorkInputSchema>;

export const LogWorkOutputSchema = z.object({
  entry: WorklogEntryDtoSchema,
  deduplicated: z.boolean(),
});
export type LogWorkOutput = z.infer<typeof LogWorkOutputSchema>;

export const ListWorklogInputSchema = z
  .object({
    from: DueInputSchema,
    to: DueInputSchema,
    projectId: z.string().uuid().optional(),
    taskId: z.string().uuid().optional(),
    sourceAgent: AgentSourceSchema.optional(),
    limit: ListLimitSchema.optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type ListWorklogInput = z.infer<typeof ListWorklogInputSchema>;

export const ListWorklogOutputSchema = z.object({
  entries: z.array(WorklogEntryDtoSchema),
  totalEntries: z.number().int().gte(0),
  totalDurationMinutes: z.number().int().gte(0),
  entriesWithoutDuration: z.number().int().gte(0),
  nextCursor: z.string().nullable(),
});
export type ListWorklogOutput = z.infer<typeof ListWorklogOutputSchema>;

export const SuggestedActionSchema = z.object({
  kind: z.enum([
    'finish_active_focus',
    'resolve_overdue_task',
    'continue_in_progress_task',
    'start_next_task',
    'add_missing_estimate',
    'capture_worklog',
  ]),
  taskId: z.string().uuid().nullable(),
  focusSessionId: z.string().uuid().nullable(),
  message: z.string(),
});
export type SuggestedAction = z.infer<typeof SuggestedActionSchema>;

export const GenerateDailyReviewInputSchema = z
  .object({
    date: DateOnlySchema.optional(),
  })
  .strict();
export type GenerateDailyReviewInput = z.infer<typeof GenerateDailyReviewInputSchema>;

export const DailyReviewOutputSchema = z.object({
  date: DateOnlySchema,
  timezone: z.string(),
  completedTasks: z.array(TaskSummaryDtoSchema),
  inProgressTasks: z.array(TaskSummaryDtoSchema),
  overdueTasks: z.array(TaskSummaryDtoSchema),
  focusSessions: z.array(FocusSessionDtoSchema),
  activeFocusSessions: z.array(FocusSessionDtoSchema),
  totalFocusSeconds: z.number().int().gte(0),
  worklogEntries: z.array(WorklogEntryDtoSchema),
  totalWorklogMinutes: z.number().int().gte(0),
  dataGaps: z.array(z.string()),
  suggestedNextActions: z.array(SuggestedActionSchema),
});
export type DailyReviewOutput = z.infer<typeof DailyReviewOutputSchema>;

export const DailyReviewTotalSchema = z.object({
  date: DateOnlySchema,
  completedTasksCount: z.number().int().gte(0),
  focusSeconds: z.number().int().gte(0),
  worklogCount: z.number().int().gte(0),
  worklogMinutes: z.number().int().gte(0),
});
export type DailyReviewTotal = z.infer<typeof DailyReviewTotalSchema>;

export const GenerateWeeklyReviewInputSchema = z
  .object({
    weekOf: DateOnlySchema.optional(),
  })
  .strict();
export type GenerateWeeklyReviewInput = z.infer<typeof GenerateWeeklyReviewInputSchema>;

export const WeeklyReviewOutputSchema = z.object({
  weekStartDate: DateOnlySchema,
  weekEndDate: DateOnlySchema,
  weekStartsOn: WeekStartsOnSchema,
  timezone: z.string(),
  completedTasks: z.array(TaskSummaryDtoSchema),
  inProgressTasks: z.array(TaskSummaryDtoSchema),
  overdueTasks: z.array(TaskSummaryDtoSchema),
  focusSessions: z.array(FocusSessionDtoSchema),
  activeFocusSessions: z.array(FocusSessionDtoSchema),
  totalFocusSeconds: z.number().int().gte(0),
  worklogEntries: z.array(WorklogEntryDtoSchema),
  totalWorklogMinutes: z.number().int().gte(0),
  dailyTotals: z.array(DailyReviewTotalSchema),
  dataGaps: z.array(z.string()),
  suggestedNextActions: z.array(SuggestedActionSchema),
});
export type WeeklyReviewOutput = z.infer<typeof WeeklyReviewOutputSchema>;

// --- Backup Export / Import Contracts ---

export const BackupTagSchema = z.object({
  id: z.string().uuid(),
  name: TagNameSchema,
  createdAt: IsoUtcTimestampSchema,
});

export const BackupTaskTagSchema = z.object({
  taskId: z.string().uuid(),
  tagId: z.string().uuid(),
});

export const BackupTaskSchema = z.object({
  id: z.string().uuid(),
  title: TaskTitleSchema,
  description: TaskDescriptionSchema.nullable(),
  projectId: z.string().uuid().nullable(),
  status: TaskStatusSchema,
  priority: PrioritySchema,
  estimateMinutes: EstimateMinutesSchema.nullable(),
  dueAt: IsoUtcTimestampSchema.nullable(),
  dueDate: DateOnlySchema.nullable(),
  completedAt: IsoUtcTimestampSchema.nullable(),
  createdAt: IsoUtcTimestampSchema,
  updatedAt: IsoUtcTimestampSchema,
  sourceAgent: AgentSourceSchema,
  externalRef: z.string().nullable(),
});

export const BackupArchiveSchema = z.object({
  formatVersion: z.number().int().positive(),
  appVersion: z.string(),
  exportedAt: IsoUtcTimestampSchema,
  data: z.object({
    settings: SettingsDtoSchema,
    projects: z.array(ProjectDtoSchema),
    tasks: z.array(BackupTaskSchema),
    tags: z.array(BackupTagSchema),
    taskTags: z.array(BackupTaskTagSchema),
    focusSessions: z.array(FocusSessionDtoSchema),
    worklogEntries: z.array(WorklogEntryDtoSchema),
  }),
});
export type BackupArchive = z.infer<typeof BackupArchiveSchema>;

export const ImportModeSchema = z.enum(['merge', 'replace']);
export type ImportMode = z.infer<typeof ImportModeSchema>;

export const ImportValidationResultSchema = z.object({
  valid: z.boolean(),
  formatVersion: z.number().int().nullable(),
  mode: ImportModeSchema,
  counts: z.object({
    projects: z.number().int().gte(0),
    tasks: z.number().int().gte(0),
    tags: z.number().int().gte(0),
    taskTags: z.number().int().gte(0),
    focusSessions: z.number().int().gte(0),
    worklogEntries: z.number().int().gte(0),
  }),
  conflicts: z.array(z.string()),
  errors: z.array(z.string()),
});
export type ImportValidationResult = z.infer<typeof ImportValidationResultSchema>;

export const ImportResultSchema = z.object({
  mode: ImportModeSchema,
  imported: z.object({
    projects: z.number().int().gte(0),
    tasks: z.number().int().gte(0),
    tags: z.number().int().gte(0),
    taskTags: z.number().int().gte(0),
    focusSessions: z.number().int().gte(0),
    worklogEntries: z.number().int().gte(0),
  }),
});
export type ImportResult = z.infer<typeof ImportResultSchema>;
