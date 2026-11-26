import { resolveDaymarkPaths } from '@daymark/config';
import {
  type AgentSource,
  APP_VERSION,
  CaptureTaskInputSchema,
  CaptureTaskOutputSchema,
  CompleteTaskInputSchema,
  CompleteTaskOutputSchema,
  CreateProjectInputSchema,
  CreateProjectOutputSchema,
  DailyReviewOutputSchema,
  DaymarkError,
  FinishFocusInputSchema,
  FinishFocusOutputSchema,
  GenerateDailyReviewInputSchema,
  GenerateWeeklyReviewInputSchema,
  GetStatusInputSchema,
  GetTaskInputSchema,
  GetTaskOutputSchema,
  GetTodayPlanInputSchema,
  GetTodayPlanOutputSchema,
  ListProjectsInputSchema,
  ListProjectsOutputSchema,
  ListTasksInputSchema,
  ListTasksOutputSchema,
  ListWorklogInputSchema,
  ListWorklogOutputSchema,
  LogWorkInputSchema,
  LogWorkOutputSchema,
  StartFocusInputSchema,
  StartFocusOutputSchema,
  SystemStatusSchema,
  UpdateProjectInputSchema,
  UpdateProjectOutputSchema,
  UpdateTaskInputSchema,
  UpdateTaskOutputSchema,
  WeeklyReviewOutputSchema,
} from '@daymark/contracts';
import { type Clock, createDaymarkService, type DaymarkService, systemClock } from '@daymark/core';
import { openDaymarkStore } from '@daymark/storage-sqlite';
import {
  McpServer,
  type StandardSchemaWithJSON,
  type ToolCallback,
} from '@modelcontextprotocol/server';
import { type StdioServerHandle, serveStdio } from '@modelcontextprotocol/server/stdio';
import pino from 'pino';
import type * as z from 'zod';

export interface DaymarkMcpServerOptions {
  env?: Record<string, string | undefined>;
  clock?: Clock;
}

function createStderrLogger(env: Record<string, string | undefined>) {
  const level = env.DAYMARK_LOG_LEVEL?.trim() || 'silent';
  return pino(
    {
      level,
      redact: {
        paths: ['title', 'description', 'note', 'summary', 'details', 'completionNote'],
        remove: true,
      },
    },
    pino.destination({ dest: 2, sync: true }),
  );
}

function inferAgentSourceFromClientName(name: string | undefined): AgentSource {
  if (!name) return 'unknown';
  const lower = name.toLowerCase();
  if (lower.includes('claude')) return 'claude-code';
  if (lower.includes('codex')) return 'codex';
  if (lower.includes('cursor')) return 'cursor';
  if (lower.includes('antigravity') || lower === 'agy') return 'antigravity';
  if (lower.includes('opencode')) return 'opencode';
  return 'other';
}

function toSafeMcpError(err: unknown) {
  if (err instanceof DaymarkError) {
    const payload = {
      error: {
        code: err.code,
        message: err.message,
        nextStep: err.nextStep ?? null,
      },
    };
    return {
      isError: true as const,
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
    };
  }
  const fallback = {
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.',
      nextStep: 'Check profile initialization or retry the operation.',
    },
  };
  return {
    isError: true as const,
    content: [{ type: 'text' as const, text: JSON.stringify(fallback) }],
  };
}

export function createDaymarkMcpServer(options: DaymarkMcpServerOptions = {}): McpServer {
  const env = options.env ?? process.env;
  const logger = createStderrLogger(env);
  const paths = resolveDaymarkPaths({ env });
  const store = openDaymarkStore(paths);
  const service = createDaymarkService({ store, clock: options.clock ?? systemClock });

  const server = new McpServer(
    { name: 'daymark', version: APP_VERSION },
    { capabilities: { tools: {} } },
  );

  server.server.onclose = () => {
    store.close();
  };

  function getClientAgentHint(): AgentSource {
    const clientInfo = server.server.getClientVersion();
    return inferAgentSourceFromClientName(clientInfo?.name);
  }

  function registerTool<
    TIn extends z.ZodType & StandardSchemaWithJSON,
    TOut extends z.ZodType & StandardSchemaWithJSON,
  >(config: {
    name: string;
    title: string;
    description: string;
    readOnly: boolean;
    idempotent?: boolean;
    inputSchema: TIn;
    outputSchema: TOut;
    execute: (input: z.infer<TIn>, svc: DaymarkService) => z.infer<TOut>;
    summarize: (output: z.infer<TOut>) => string;
  }): void {
    const handler: ToolCallback<StandardSchemaWithJSON> = async (rawInput) => {
      const start = Date.now();
      try {
        const parsed = config.inputSchema.parse(rawInput);
        const output = config.execute(parsed, service);
        logger.debug({ tool: config.name, durationMs: Date.now() - start }, 'tool succeeded');
        return {
          content: [{ type: 'text', text: config.summarize(output) }],
          structuredContent: output as Record<string, unknown>,
        };
      } catch (err) {
        const code = err instanceof DaymarkError ? err.code : 'INTERNAL_ERROR';
        logger.debug(
          { tool: config.name, code, durationMs: Date.now() - start },
          'tool returned error',
        );
        return toSafeMcpError(err);
      }
    };

    server.registerTool(
      config.name,
      {
        title: config.title,
        description: config.description,
        inputSchema: config.inputSchema as StandardSchemaWithJSON,
        outputSchema: config.outputSchema as StandardSchemaWithJSON,
        annotations: {
          readOnlyHint: config.readOnly,
          destructiveHint: false,
          idempotentHint: config.idempotent ?? config.readOnly,
          openWorldHint: false,
        },
      },
      handler,
    );
  }

  // 1. daymark_get_status
  registerTool({
    name: 'daymark_get_status',
    title: 'Get Daymark Status',
    description:
      'Check whether the local Daymark profile is initialized, its schema version, configured IANA timezone, and any active focus session.',
    readOnly: true,
    inputSchema: GetStatusInputSchema,
    outputSchema: SystemStatusSchema,
    execute: (input, svc) => svc.getStatus(input),
    summarize: (s) =>
      s.initialized
        ? `Daymark initialized (schema ${s.schemaVersion}, timezone ${s.timezone}, active focus: ${s.activeFocusSession ? s.activeFocusSession.id : 'none'}).`
        : 'Daymark profile is not initialized yet. Run `daymark init` in the terminal first.',
  });

  // 2. daymark_list_projects
  registerTool({
    name: 'daymark_list_projects',
    title: 'List Projects',
    description: 'List Daymark projects with status filter and cursor pagination.',
    readOnly: true,
    inputSchema: ListProjectsInputSchema,
    outputSchema: ListProjectsOutputSchema,
    execute: (input, svc) => svc.listProjects(input),
    summarize: (out) =>
      `Returned ${out.projects.length} project(s).${out.nextCursor ? ` nextCursor=${out.nextCursor}` : ''}`,
  });

  // 3. daymark_list_tasks
  registerTool({
    name: 'daymark_list_tasks',
    title: 'List Tasks',
    description:
      'Search and list Daymark task summaries by status, priority, project, due date bounds, or query text.',
    readOnly: true,
    inputSchema: ListTasksInputSchema,
    outputSchema: ListTasksOutputSchema,
    execute: (input, svc) => svc.listTasks(input),
    summarize: (out) =>
      `Returned ${out.tasks.length} task summary/summaries.${out.nextCursor ? ` nextCursor=${out.nextCursor}` : ''}`,
  });

  // 4. daymark_get_task
  registerTool({
    name: 'daymark_get_task',
    title: 'Get Task',
    description: 'Inspect full details of a single Daymark task by ID.',
    readOnly: true,
    inputSchema: GetTaskInputSchema,
    outputSchema: GetTaskOutputSchema,
    execute: (input, svc) => svc.getTask(input),
    summarize: (out) =>
      `Task "${out.task.title}" [${out.task.status}, priority=${out.task.priority}${out.projectName ? `, project=${out.projectName}` : ''}].`,
  });

  // 5. daymark_get_today_plan
  registerTool({
    name: 'daymark_get_today_plan',
    title: 'Get Today Plan',
    description:
      'Generate a deterministic ranked daily plan from pending tasks and an explicit available-minute budget. Do not invent free time; ask the user for availableMinutes if not configured.',
    readOnly: true,
    inputSchema: GetTodayPlanInputSchema,
    outputSchema: GetTodayPlanOutputSchema,
    execute: (input, svc) => svc.getTodayPlan(input),
    summarize: (plan) =>
      `Suggested plan for ${plan.date} (${plan.timezone}): ${plan.plannedTasks.length} scheduled (${plan.totalEstimatedMinutes}/${plan.availableMinutes} min), ${plan.unscheduledMissingEstimate.length} missing estimate, ${plan.excludedTasks.length} over budget.`,
  });

  // 6. daymark_list_worklog
  registerTool({
    name: 'daymark_list_worklog',
    title: 'List Worklog Entries',
    description:
      'Query recorded worklog entries and aggregate time totals across a date or timestamp range.',
    readOnly: true,
    inputSchema: ListWorklogInputSchema,
    outputSchema: ListWorklogOutputSchema,
    execute: (input, svc) => svc.listWorklog(input),
    summarize: (out) =>
      `Worklogs: ${out.totalEntries} total entry/entries (${out.totalDurationMinutes} min logged; ${out.entriesWithoutDuration} without duration). Page returned ${out.entries.length}.`,
  });

  // 7. daymark_create_project
  registerTool({
    name: 'daymark_create_project',
    title: 'Create Project',
    description: 'Create a new Daymark project to group related tasks and worklogs.',
    readOnly: false,
    inputSchema: CreateProjectInputSchema,
    outputSchema: CreateProjectOutputSchema,
    execute: (input, svc) => svc.createProject(input),
    summarize: (out) => `Created project "${out.project.name}" (${out.project.id}).`,
  });

  // 8. daymark_update_project
  registerTool({
    name: 'daymark_update_project',
    title: 'Update Project',
    description: 'Update a project name, description (null to clear), or active/archived status.',
    readOnly: false,
    idempotent: true,
    inputSchema: UpdateProjectInputSchema,
    outputSchema: UpdateProjectOutputSchema,
    execute: (input, svc) => svc.updateProject(input),
    summarize: (out) =>
      `Updated project "${out.project.name}" (${out.project.id}) [${out.project.status}].`,
  });

  // 9. daymark_capture_task
  registerTool({
    name: 'daymark_capture_task',
    title: 'Capture Task',
    description:
      'Capture a new task when the user explicitly asks to remember, track, or add a task. Leave unknown estimates, priorities, and due dates unset.',
    readOnly: false,
    idempotent: true,
    inputSchema: CaptureTaskInputSchema,
    outputSchema: CaptureTaskOutputSchema,
    execute: (input, svc) =>
      svc.captureTask({
        ...input,
        sourceAgent: input.sourceAgent ?? getClientAgentHint(),
      }),
    summarize: (out) =>
      `${out.deduplicated ? 'Existing (idempotent)' : 'Captured'} task "${out.task.title}" (${out.task.id}). Unspecified: ${out.unspecifiedFields.join(', ') || 'none'}.`,
  });

  // 10. daymark_update_task
  registerTool({
    name: 'daymark_update_task',
    title: 'Update Task',
    description:
      'Update explicit fields on an existing task. Pass null to explicitly clear nullable fields. Never change due dates or estimates unless requested.',
    readOnly: false,
    idempotent: true,
    inputSchema: UpdateTaskInputSchema,
    outputSchema: UpdateTaskOutputSchema,
    execute: (input, svc) => svc.updateTask(input),
    summarize: (out) => `Updated task "${out.task.title}" (${out.task.id}) [${out.task.status}].`,
  });

  // 11. daymark_start_focus
  registerTool({
    name: 'daymark_start_focus',
    title: 'Start Focus Session',
    description:
      'Start a focus session only when the user explicitly asks to begin focus or time tracking. Fails if another session is already active.',
    readOnly: false,
    inputSchema: StartFocusInputSchema,
    outputSchema: StartFocusOutputSchema,
    execute: (input, svc) =>
      svc.startFocus({
        ...input,
        sourceAgent: input.sourceAgent ?? getClientAgentHint(),
      }),
    summarize: (out) => `Started focus session ${out.session.id} at ${out.session.startedAt}.`,
  });

  // 12. daymark_finish_focus
  registerTool({
    name: 'daymark_finish_focus',
    title: 'Finish Focus Session',
    description:
      'Finish or interrupt the active focus session, calculate elapsed duration, and optionally create a deterministic worklog entry.',
    readOnly: false,
    inputSchema: FinishFocusInputSchema,
    outputSchema: FinishFocusOutputSchema,
    execute: (input, svc) => svc.finishFocus(input),
    summarize: (out) =>
      `Finished focus session ${out.session.id} [${out.session.status}] (${out.session.durationSeconds ?? 0}s).${out.worklogEntry ? ` Created worklog ${out.worklogEntry.id}.` : ''}`,
  });

  // 13. daymark_log_work
  registerTool({
    name: 'daymark_log_work',
    title: 'Log Work',
    description:
      'Record an explicit worklog entry from user-provided or clearly confirmed completed-work evidence.',
    readOnly: false,
    idempotent: true,
    inputSchema: LogWorkInputSchema,
    outputSchema: LogWorkOutputSchema,
    execute: (input, svc) =>
      svc.logWork({
        ...input,
        sourceAgent: input.sourceAgent ?? getClientAgentHint(),
      }),
    summarize: (out) =>
      `${out.deduplicated ? 'Existing (idempotent)' : 'Logged'} worklog ${out.entry.id}.`,
  });

  // 14. daymark_complete_task
  registerTool({
    name: 'daymark_complete_task',
    title: 'Complete Task',
    description:
      'Mark a task completed upon clear user direction, and optionally record a linked worklog entry in the same transaction.',
    readOnly: false,
    inputSchema: CompleteTaskInputSchema,
    outputSchema: CompleteTaskOutputSchema,
    execute: (input, svc) =>
      svc.completeTask({
        ...input,
        sourceAgent: input.sourceAgent ?? getClientAgentHint(),
      }),
    summarize: (out) =>
      `Completed task "${out.task.title}" (${out.task.id}).${out.worklogEntry ? ` Linked worklog ${out.worklogEntry.id}.` : ''}`,
  });

  // 15. daymark_generate_daily_review
  registerTool({
    name: 'daymark_generate_daily_review',
    title: 'Generate Daily Review',
    description:
      'Summarize completed tasks, active work, overdue items, focus time, worklogs, and explicit data gaps for a day using stored Daymark records only.',
    readOnly: true,
    inputSchema: GenerateDailyReviewInputSchema,
    outputSchema: DailyReviewOutputSchema,
    execute: (input, svc) => svc.generateDailyReview(input),
    summarize: (r) =>
      `Daily review for ${r.date} (${r.timezone}): ${r.completedTasks.length} completed, ${r.inProgressTasks.length} in progress, ${r.overdueTasks.length} overdue, ${r.totalFocusSeconds}s focus, ${r.totalWorklogMinutes}m logged. Gaps: ${r.dataGaps.length}.`,
  });

  // 16. daymark_generate_weekly_review
  registerTool({
    name: 'daymark_generate_weekly_review',
    title: 'Generate Weekly Review',
    description:
      'Summarize completed tasks, active work, overdue items, focus time, worklogs, day-by-day totals, and explicit data gaps for a week using stored Daymark records only.',
    readOnly: true,
    inputSchema: GenerateWeeklyReviewInputSchema,
    outputSchema: WeeklyReviewOutputSchema,
    execute: (input, svc) => svc.generateWeeklyReview(input),
    summarize: (r) =>
      `Weekly review for ${r.weekStartDate}..${r.weekEndDate} (${r.timezone}): ${r.completedTasks.length} completed, ${r.totalFocusSeconds}s focus, ${r.totalWorklogMinutes}m logged.`,
  });

  return server;
}

export function startDaymarkStdioServer(options: DaymarkMcpServerOptions = {}): StdioServerHandle {
  return serveStdio(() => createDaymarkMcpServer(options));
}
