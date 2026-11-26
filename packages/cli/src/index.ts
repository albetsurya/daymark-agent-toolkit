import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertSafeUserFilePath,
  enforceOwnerOnlyFileMode,
  ensureSecureDir,
  readProfileConfig,
  resolveDaymarkPaths,
} from '@daymark/config';
import {
  type AgentSource,
  APP_VERSION,
  DaymarkError,
  type ImportMode,
  type Priority,
  type TaskStatus,
  type WeekStartsOn,
} from '@daymark/contracts';
import { createDaymarkService, formatUtcMsInTimezoneDate } from '@daymark/core';
import { initializeProfile, openDaymarkStore } from '@daymark/storage-sqlite';
import { Command } from 'commander';
import pino from 'pino';
import {
  formatCaptureTaskText,
  formatCompleteTaskText,
  formatDailyReviewText,
  formatFocusFinishText,
  formatFocusListText,
  formatFocusStartText,
  formatImportResultText,
  formatImportValidationText,
  formatInitText,
  formatProjectListText,
  formatProjectMutationText,
  formatStatusText,
  formatTaskDetailText,
  formatTaskListText,
  formatTodayPlanText,
  formatUpdateTaskText,
  formatWeeklyReviewText,
  formatWorklogAddText,
  formatWorklogListText,
} from './formatters.js';

export interface CliRuntimeOptions {
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  env?: Record<string, string | undefined>;
}

function parseIntStrict(raw: string, label: string): number {
  const num = Number(raw);
  if (!Number.isInteger(num)) {
    throw new DaymarkError('VALIDATION_FAILED', `${label} must be an integer, got "${raw}".`);
  }
  return num;
}

function createDiagnosticLogger(verbose: boolean) {
  return pino(
    {
      level: verbose ? 'debug' : 'silent',
      redact: {
        paths: ['title', 'description', 'note', 'summary', 'details', 'completionNote'],
        remove: true,
      },
    },
    pino.destination({ dest: 2, sync: true }),
  );
}

export function createDaymarkCli(runtime: CliRuntimeOptions = {}): Command {
  const writeOut = runtime.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const writeErr = runtime.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const env = runtime.env ?? process.env;

  const program = new Command();
  program
    .name('daymark')
    .description('Daymark - local-first, cross-agent productivity toolkit')
    .version(APP_VERSION)
    .option('--json', 'Output machine-readable JSON', false)
    .option(
      '--verbose',
      'Enable diagnostic logs on stderr (may include operation metadata)',
      false,
    );

  program.exitOverride();

  function isJson(): boolean {
    return Boolean(program.opts<{ json?: boolean }>().json);
  }

  function isVerbose(): boolean {
    return Boolean(program.opts<{ verbose?: boolean }>().verbose);
  }

  function emitSuccess<T>(data: T, textFormatter: (data: T) => string): void {
    if (isJson()) {
      writeOut(JSON.stringify({ ok: true, data }));
    } else {
      writeOut(textFormatter(data));
    }
  }

  function withService<T>(
    operationName: string,
    fn: (service: ReturnType<typeof createDaymarkService>) => T,
  ): T {
    const logger = createDiagnosticLogger(isVerbose());
    const start = Date.now();
    const paths = resolveDaymarkPaths({ env });
    const store = openDaymarkStore(paths);
    try {
      const service = createDaymarkService({ store });
      const result = fn(service);
      logger.debug({ op: operationName, durationMs: Date.now() - start }, 'operation completed');
      return result;
    } finally {
      store.close();
    }
  }

  program
    .command('init')
    .description('Initialize local Daymark directory, config, and SQLite database (idempotent)')
    .option('--timezone <iana>', 'IANA timezone name (e.g. UTC or Asia/Jakarta)')
    .option('--week-starts-on <day>', 'Week boundary start day (monday or sunday)')
    .option('--day-start <HH:MM>', 'Preferred day start time (24h HH:MM)')
    .option('--default-plan-minutes <n>', 'Optional default daily plan budget in minutes')
    .action(
      (opts: {
        timezone?: string;
        weekStartsOn?: WeekStartsOn;
        dayStart?: string;
        defaultPlanMinutes?: string;
      }) => {
        const paths = resolveDaymarkPaths({ env });
        const result = initializeProfile({
          paths,
          timezone: opts.timezone,
          weekStartsOn: opts.weekStartsOn,
          dayStartTime: opts.dayStart,
          defaultPlanMinutes:
            opts.defaultPlanMinutes !== undefined
              ? parseIntStrict(opts.defaultPlanMinutes, 'default-plan-minutes')
              : undefined,
        });
        emitSuccess(
          {
            alreadyInitialized: result.alreadyInitialized,
            dataDir: result.paths.dataDir,
            databasePath: result.paths.databasePath,
            configPath: result.paths.configPath,
            schemaVersion: result.schemaVersion,
            settings: result.settings,
            appliedMigrations: result.appliedMigrations,
          },
          () => formatInitText(result),
        );
      },
    );

  program
    .command('status')
    .description('Check Daymark initialization status, schema version, and active focus session')
    .action(() => {
      const status = withService('status', (svc) => svc.getStatus({}));
      emitSuccess(status, formatStatusText);
    });

  // --- Projects ---
  const projectCmd = program.command('project').description('Manage projects');

  projectCmd
    .command('add <name>')
    .description('Create a new project')
    .option('-d, --description <text>', 'Project description')
    .action((name: string, opts: { description?: string }) => {
      const res = withService('project.add', (svc) =>
        svc.createProject({ name, description: opts.description }),
      );
      emitSuccess(res, (d) => formatProjectMutationText(d, 'Created'));
    });

  projectCmd
    .command('list')
    .description('List projects')
    .option('--status <status>', 'Filter status: active, archived, or all', 'active')
    .option('--limit <n>', 'Page size limit')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action((opts: { status: 'active' | 'archived' | 'all'; limit?: string; cursor?: string }) => {
      const res = withService('project.list', (svc) =>
        svc.listProjects({
          status: opts.status,
          limit: opts.limit !== undefined ? parseIntStrict(opts.limit, 'limit') : undefined,
          cursor: opts.cursor,
        }),
      );
      emitSuccess(res, formatProjectListText);
    });

  projectCmd
    .command('update <projectId>')
    .description('Update project fields or status')
    .option('--name <name>', 'New project name')
    .option('-d, --description <text>', 'New description')
    .option('--clear-description', 'Clear project description')
    .option('--status <status>', 'New status (active or archived)')
    .action(
      (
        projectId: string,
        opts: {
          name?: string;
          description?: string;
          clearDescription?: boolean;
          status?: 'active' | 'archived';
        },
      ) => {
        const res = withService('project.update', (svc) =>
          svc.updateProject({
            projectId,
            name: opts.name,
            description: opts.clearDescription ? null : opts.description,
            status: opts.status,
          }),
        );
        emitSuccess(res, (d) => formatProjectMutationText(d, 'Updated'));
      },
    );

  projectCmd
    .command('archive <projectId>')
    .description('Archive a project')
    .action((projectId: string) => {
      const res = withService('project.archive', (svc) =>
        svc.updateProject({ projectId, status: 'archived' }),
      );
      emitSuccess(res, (d) => formatProjectMutationText(d, 'Archived'));
    });

  // --- Tasks ---
  const taskCmd = program.command('task').description('Manage tasks');

  taskCmd
    .command('add <title>')
    .description('Capture a new task')
    .option('-d, --description <text>', 'Task description')
    .option('-p, --project <projectId>', 'Project UUID')
    .option('--priority <priority>', 'Priority: none, low, medium, high')
    .option('--estimate <minutes>', 'Duration estimate in minutes')
    .option('--due <dateOrIso>', 'Due date (YYYY-MM-DD) or ISO-8601 datetime with offset')
    .option('--tag <tags...>', 'Tags to attach')
    .option('--agent <source>', 'Source agent identifier')
    .option('--idempotency-key <key>', 'Idempotency key to prevent duplicate creation')
    .action(
      (
        title: string,
        opts: {
          description?: string;
          project?: string;
          priority?: Priority;
          estimate?: string;
          due?: string;
          tag?: string[];
          agent?: AgentSource;
          idempotencyKey?: string;
        },
      ) => {
        const res = withService('task.add', (svc) =>
          svc.captureTask({
            title,
            description: opts.description,
            projectId: opts.project,
            priority: opts.priority,
            estimateMinutes:
              opts.estimate !== undefined ? parseIntStrict(opts.estimate, 'estimate') : undefined,
            dueAt: opts.due,
            tags: opts.tag,
            sourceAgent: opts.agent ?? 'cli',
            idempotencyKey: opts.idempotencyKey,
          }),
        );
        emitSuccess(res, formatCaptureTaskText);
      },
    );

  taskCmd
    .command('list')
    .description('List tasks with filters')
    .option('--status <statuses...>', 'Filter by status(es)')
    .option('--priority <priority>', 'Filter by priority')
    .option('-p, --project <projectId>', 'Filter by project UUID')
    .option('--due-before <dateOrIso>', 'Filter due on/before date or instant')
    .option('--due-after <dateOrIso>', 'Filter due on/after date or instant')
    .option('-q, --query <text>', 'Search title and description')
    .option('--limit <n>', 'Page size limit')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(
      (opts: {
        status?: TaskStatus[];
        priority?: Priority;
        project?: string;
        dueBefore?: string;
        dueAfter?: string;
        query?: string;
        limit?: string;
        cursor?: string;
      }) => {
        const res = withService('task.list', (svc) =>
          svc.listTasks({
            status: opts.status && opts.status.length === 1 ? opts.status[0] : opts.status,
            priority: opts.priority,
            projectId: opts.project,
            dueBefore: opts.dueBefore,
            dueAfter: opts.dueAfter,
            query: opts.query,
            limit: opts.limit !== undefined ? parseIntStrict(opts.limit, 'limit') : undefined,
            cursor: opts.cursor,
          }),
        );
        emitSuccess(res, formatTaskListText);
      },
    );

  taskCmd
    .command('show <taskId>')
    .description('Show full task details')
    .action((taskId: string) => {
      const res = withService('task.show', (svc) => svc.getTask({ taskId }));
      emitSuccess(res, formatTaskDetailText);
    });

  taskCmd
    .command('update <taskId>')
    .description('Update a task')
    .option('--title <text>', 'New title')
    .option('-d, --description <text>', 'New description')
    .option('--clear-description', 'Clear description')
    .option('-p, --project <projectId>', 'Assign project UUID')
    .option('--clear-project', 'Unassign project')
    .option('--priority <priority>', 'Priority: none, low, medium, high')
    .option('--estimate <minutes>', 'Estimate in minutes')
    .option('--clear-estimate', 'Clear estimate')
    .option('--due <dateOrIso>', 'Due date or ISO datetime')
    .option('--clear-due', 'Clear due date')
    .option('--status <status>', 'Task status')
    .option('--tag <tags...>', 'Replace tags')
    .action(
      (
        taskId: string,
        opts: {
          title?: string;
          description?: string;
          clearDescription?: boolean;
          project?: string;
          clearProject?: boolean;
          priority?: Priority;
          estimate?: string;
          clearEstimate?: boolean;
          due?: string;
          clearDue?: boolean;
          status?: TaskStatus;
          tag?: string[];
        },
      ) => {
        const res = withService('task.update', (svc) =>
          svc.updateTask({
            taskId,
            title: opts.title,
            description: opts.clearDescription ? null : opts.description,
            projectId: opts.clearProject ? null : opts.project,
            priority: opts.priority,
            estimateMinutes: opts.clearEstimate
              ? null
              : opts.estimate !== undefined
                ? parseIntStrict(opts.estimate, 'estimate')
                : undefined,
            dueAt: opts.clearDue ? null : opts.due,
            status: opts.status,
            tags: opts.tag,
          }),
        );
        emitSuccess(res, formatUpdateTaskText);
      },
    );

  taskCmd
    .command('done <taskId>')
    .description('Complete a task and optionally record a linked worklog entry')
    .option('--note <text>', 'Optional completion note stored as a linked worklog entry')
    .option('--agent <source>', 'Source agent identifier')
    .action((taskId: string, opts: { note?: string; agent?: AgentSource }) => {
      const res = withService('task.done', (svc) =>
        svc.completeTask({
          taskId,
          completionNote: opts.note,
          sourceAgent: opts.agent ?? 'cli',
        }),
      );
      emitSuccess(res, formatCompleteTaskText);
    });

  taskCmd
    .command('cancel <taskId>')
    .description('Mark a task as cancelled')
    .action((taskId: string) => {
      const res = withService('task.cancel', (svc) =>
        svc.updateTask({ taskId, status: 'cancelled' }),
      );
      emitSuccess(res, formatUpdateTaskText);
    });

  taskCmd
    .command('archive <taskId>')
    .description('Archive a task')
    .action((taskId: string) => {
      const res = withService('task.archive', (svc) =>
        svc.updateTask({ taskId, status: 'archived' }),
      );
      emitSuccess(res, formatUpdateTaskText);
    });

  // --- Plan ---
  const planCmd = program.command('plan').description('Generate deterministic daily plans');

  planCmd
    .command('today')
    .description('Generate a ranked daily plan from pending tasks and an available-time budget')
    .option('--available-minutes <n>', 'Available focus minutes')
    .option('--date <YYYY-MM-DD>', 'Plan date (defaults to today in configured timezone)')
    .action((opts: { availableMinutes?: string; date?: string }) => {
      const res = withService('plan.today', (svc) =>
        svc.getTodayPlan({
          date: opts.date,
          availableMinutes:
            opts.availableMinutes !== undefined
              ? parseIntStrict(opts.availableMinutes, 'available-minutes')
              : undefined,
        }),
      );
      emitSuccess(res, formatTodayPlanText);
    });

  // --- Focus ---
  const focusCmd = program.command('focus').description('Manage focus sessions');

  focusCmd
    .command('start')
    .description('Start a focus session (fails if another session is active)')
    .option('-t, --task <taskId>', 'Task UUID')
    .option('-p, --project <projectId>', 'Project UUID')
    .option('--note <text>', 'Focus session note')
    .option('--agent <source>', 'Source agent identifier')
    .action((opts: { task?: string; project?: string; note?: string; agent?: AgentSource }) => {
      const res = withService('focus.start', (svc) =>
        svc.startFocus({
          taskId: opts.task,
          projectId: opts.project,
          note: opts.note,
          sourceAgent: opts.agent ?? 'cli',
        }),
      );
      emitSuccess(res, formatFocusStartText);
    });

  focusCmd
    .command('stop')
    .description('Finish or interrupt the active focus session')
    .option('--session <sessionId>', 'Specific active session UUID')
    .option('--note <text>', 'Session note')
    .option('--worklog', 'Also create a linked worklog entry', false)
    .option('--interrupted', 'Mark session as interrupted instead of completed', false)
    .action(
      (opts: { session?: string; note?: string; worklog?: boolean; interrupted?: boolean }) => {
        const res = withService('focus.stop', (svc) =>
          svc.finishFocus({
            sessionId: opts.session,
            note: opts.note,
            createWorklog: Boolean(opts.worklog),
            status: opts.interrupted ? 'interrupted' : 'completed',
          }),
        );
        emitSuccess(res, formatFocusFinishText);
      },
    );

  focusCmd
    .command('list')
    .description('List focus sessions')
    .option('--status <status>', 'Filter: active, completed, interrupted, or all', 'all')
    .option('-t, --task <taskId>', 'Filter by task UUID')
    .option('-p, --project <projectId>', 'Filter by project UUID')
    .option('--limit <n>', 'Page size limit')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(
      (opts: {
        status: 'active' | 'completed' | 'interrupted' | 'all';
        task?: string;
        project?: string;
        limit?: string;
        cursor?: string;
      }) => {
        const res = withService('focus.list', (svc) =>
          svc.listFocusSessions({
            status: opts.status,
            taskId: opts.task,
            projectId: opts.project,
            limit: opts.limit !== undefined ? parseIntStrict(opts.limit, 'limit') : undefined,
            cursor: opts.cursor,
          }),
        );
        emitSuccess(res, formatFocusListText);
      },
    );

  // --- Worklog ---
  const worklogCmd = program.command('worklog').description('Record and query worklog entries');

  worklogCmd
    .command('add <summary>')
    .description('Add an explicit worklog entry')
    .option('--details <text>', 'Detailed notes')
    .option('-t, --task <taskId>', 'Task UUID')
    .option('-p, --project <projectId>', 'Project UUID')
    .option('--focus <sessionId>', 'Focus session UUID')
    .option('--duration <minutes>', 'Duration in minutes')
    .option('--occurred-at <dateOrIso>', 'When the work occurred (YYYY-MM-DD or ISO-8601)')
    .option('--agent <source>', 'Source agent identifier')
    .option('--idempotency-key <key>', 'Idempotency key to prevent duplicates')
    .action(
      (
        summary: string,
        opts: {
          details?: string;
          task?: string;
          project?: string;
          focus?: string;
          duration?: string;
          occurredAt?: string;
          agent?: AgentSource;
          idempotencyKey?: string;
        },
      ) => {
        const res = withService('worklog.add', (svc) =>
          svc.logWork({
            summary,
            details: opts.details,
            taskId: opts.task,
            projectId: opts.project,
            focusSessionId: opts.focus,
            durationMinutes:
              opts.duration !== undefined ? parseIntStrict(opts.duration, 'duration') : undefined,
            occurredAt: opts.occurredAt,
            sourceAgent: opts.agent ?? 'cli',
            idempotencyKey: opts.idempotencyKey,
          }),
        );
        emitSuccess(res, formatWorklogAddText);
      },
    );

  worklogCmd
    .command('list')
    .description('Query worklog entries within a date/time range')
    .option('--from <dateOrIso>', 'Start date/timestamp (defaults to today)')
    .option('--to <dateOrIso>', 'End date/timestamp (defaults to today)')
    .option('-p, --project <projectId>', 'Filter by project UUID')
    .option('-t, --task <taskId>', 'Filter by task UUID')
    .option('--agent <source>', 'Filter by source agent')
    .option('--limit <n>', 'Page size limit')
    .option('--cursor <cursor>', 'Pagination cursor')
    .action(
      (opts: {
        from?: string;
        to?: string;
        project?: string;
        task?: string;
        agent?: AgentSource;
        limit?: string;
        cursor?: string;
      }) => {
        const res = withService('worklog.list', (svc) => {
          const status = svc.getStatus({});
          const tz = status.timezone ?? 'UTC';
          const today = formatUtcMsInTimezoneDate(Date.now(), tz);
          return svc.listWorklog({
            from: opts.from ?? today,
            to: opts.to ?? today,
            projectId: opts.project,
            taskId: opts.task,
            sourceAgent: opts.agent,
            limit: opts.limit !== undefined ? parseIntStrict(opts.limit, 'limit') : undefined,
            cursor: opts.cursor,
          });
        });
        emitSuccess(res, formatWorklogListText);
      },
    );

  // --- Review ---
  const reviewCmd = program
    .command('review')
    .description('Generate factual daily and weekly reviews');

  reviewCmd
    .command('day')
    .description('Generate a daily review from stored records')
    .option('--date <YYYY-MM-DD>', 'Date to review (defaults to today in configured timezone)')
    .action((opts: { date?: string }) => {
      const res = withService('review.day', (svc) => svc.generateDailyReview({ date: opts.date }));
      emitSuccess(res, formatDailyReviewText);
    });

  reviewCmd
    .command('week')
    .description('Generate a weekly review from stored records')
    .option('--week-of <YYYY-MM-DD>', 'Any date within the target week')
    .action((opts: { weekOf?: string }) => {
      const res = withService('review.week', (svc) =>
        svc.generateWeeklyReview({ weekOf: opts.weekOf }),
      );
      emitSuccess(res, formatWeeklyReviewText);
    });

  // --- Export / Import ---
  program
    .command('export <file>')
    .description('Export Daymark profile data to a versioned JSON backup file')
    .action((file: string) => {
      const target = assertSafeUserFilePath(file, { mustExist: false });
      const archive = withService('export', (svc) => svc.exportBackup());
      ensureSecureDir(dirname(target));
      writeFileSync(target, `${JSON.stringify(archive, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
      enforceOwnerOnlyFileMode(target);
      emitSuccess(
        {
          file: target,
          formatVersion: archive.formatVersion,
          counts: {
            projects: archive.data.projects.length,
            tasks: archive.data.tasks.length,
            tags: archive.data.tags.length,
            focusSessions: archive.data.focusSessions.length,
            worklogEntries: archive.data.worklogEntries.length,
          },
        },
        (d) =>
          `Exported backup v${d.formatVersion} to ${d.file} (${d.counts.projects} projects, ${d.counts.tasks} tasks, ${d.counts.worklogEntries} worklogs).`,
      );
    });

  program
    .command('import <file>')
    .description('Validate or import a versioned Daymark JSON backup file')
    .option('--dry-run', 'Validate archive and check conflicts without writing', false)
    .option('--mode <mode>', 'Import mode: merge or replace', 'merge')
    .option('--confirm', 'Confirm destructive replace import', false)
    .action((file: string, opts: { dryRun?: boolean; mode: ImportMode; confirm?: boolean }) => {
      const source = assertSafeUserFilePath(file, { mustExist: true });
      const rawText = readFileSync(source, 'utf8');
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(rawText);
      } catch (cause) {
        throw new DaymarkError('VALIDATION_FAILED', 'Backup file is not valid JSON.', { cause });
      }

      if (opts.dryRun) {
        const validation = withService('import.dryRun', (svc) =>
          svc.validateImport(parsedJson, opts.mode),
        );
        emitSuccess(validation, formatImportValidationText);
        return;
      }

      const imported = withService('import', (svc) =>
        svc.importBackup(parsedJson, { mode: opts.mode, confirm: Boolean(opts.confirm) }),
      );
      emitSuccess(imported, formatImportResultText);
    });

  program
    .command('doctor')
    .description('Check local Daymark environment, database, config, and MCP server readiness')
    .action(() => {
      const paths = resolveDaymarkPaths({ env });
      const config = readProfileConfig(paths.configPath);
      const dbExists = existsSync(paths.databasePath);
      const status = withService('doctor', (svc) => svc.getStatus({}));
      const hereDir = dirname(fileURLToPath(import.meta.url));
      const mcpBinCandidate = resolve(hereDir, '../../mcp-server/dist/bin.mjs');
      const report = {
        nodeVersion: process.version,
        appVersion: APP_VERSION,
        initialized: status.initialized,
        schemaVersion: status.schemaVersion,
        timezone: status.timezone,
        configExists: config !== null,
        databaseExists: dbExists,
        dataDir: paths.dataDir,
        mcpServerBinaryFound: existsSync(mcpBinCandidate),
        mcpServerBinaryPath: existsSync(mcpBinCandidate) ? mcpBinCandidate : null,
      };
      emitSuccess(report, (r) =>
        [
          `Daymark Doctor (v${r.appVersion}, Node ${r.nodeVersion})`,
          `Initialized:       ${r.initialized ? 'yes' : 'no (run: daymark init)'}`,
          `Config file:       ${r.configExists ? 'present' : 'missing'}`,
          `Database file:     ${r.databaseExists ? 'present' : 'missing'}`,
          `Schema version:    ${r.schemaVersion ?? 'none'}`,
          `Timezone:          ${r.timezone ?? 'unconfigured'}`,
          `MCP server bundle: ${r.mcpServerBinaryFound ? r.mcpServerBinaryPath : 'not found in monorepo sibling'}`,
        ].join('\n'),
      );
    });

  program.configureOutput({
    writeOut: () => {},
    writeErr: (str) => writeErr(str.trimEnd()),
  });

  return program;
}

export async function runDaymarkCli(
  argv: string[] = process.argv,
  runtime: CliRuntimeOptions = {},
): Promise<number> {
  const writeOut = runtime.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const writeErr = runtime.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));
  const cli = createDaymarkCli({ stdout: writeOut, stderr: writeErr, env: runtime.env });
  const jsonRequested = argv.includes('--json');

  try {
    await cli.parseAsync(argv);
    return 0;
  } catch (err) {
    // Commander throws structured CommanderError on --help / --version / parse error
    if (err && typeof err === 'object' && 'code' in err && 'exitCode' in err) {
      const cmdErr = err as { code: string; exitCode: number; message: string };
      if (cmdErr.code === 'commander.helpDisplayed' || cmdErr.code === 'commander.version') {
        if (cmdErr.code === 'commander.helpDisplayed') {
          writeOut(cli.helpInformation());
        } else {
          writeOut(APP_VERSION);
        }
        return 0;
      }
      if (jsonRequested) {
        writeErr(
          JSON.stringify({
            ok: false,
            error: {
              code: 'VALIDATION_FAILED',
              message: cmdErr.message,
            },
          }),
        );
      } else {
        writeErr(`Error [VALIDATION_FAILED]: ${cmdErr.message}`);
      }
      return cmdErr.exitCode || 1;
    }

    if (err instanceof DaymarkError) {
      if (jsonRequested) {
        writeErr(
          JSON.stringify({
            ok: false,
            error: {
              code: err.code,
              message: err.message,
              nextStep: err.nextStep ?? null,
            },
          }),
        );
      } else {
        const hint = err.nextStep ? `\nNext step: ${err.nextStep}` : '';
        writeErr(`Error [${err.code}]: ${err.message}${hint}`);
      }
      return 1;
    }

    const message = err instanceof Error ? err.message : 'Unexpected internal error.';
    if (jsonRequested) {
      writeErr(
        JSON.stringify({
          ok: false,
          error: {
            code: 'INTERNAL_ERROR',
            message,
          },
        }),
      );
    } else {
      writeErr(`Error [INTERNAL_ERROR]: ${message}`);
    }
    return 1;
  }
}
