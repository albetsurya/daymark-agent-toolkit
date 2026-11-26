import type {
  CaptureTaskOutput,
  CompleteTaskOutput,
  CreateProjectOutput,
  DailyReviewOutput,
  FinishFocusOutput,
  GetTaskOutput,
  GetTodayPlanOutput,
  ImportResult,
  ImportValidationResult,
  ListFocusSessionsOutput,
  ListProjectsOutput,
  ListTasksOutput,
  ListWorklogOutput,
  LogWorkOutput,
  StartFocusOutput,
  SystemStatus,
  UpdateProjectOutput,
  UpdateTaskOutput,
  WeeklyReviewOutput,
} from '@daymark/contracts';
import type { InitializeProfileResult } from '@daymark/storage-sqlite';

export function formatInitText(res: InitializeProfileResult): string {
  const lines = [
    res.alreadyInitialized
      ? 'Daymark profile already initialized (data preserved).'
      : 'Initialized Daymark profile.',
    `Data dir:      ${res.paths.dataDir}`,
    `Database:      ${res.paths.databasePath}`,
    `Schema:        ${res.schemaVersion}`,
    `Timezone:      ${res.settings.timezone}`,
    `Week starts:   ${res.settings.weekStartsOn}`,
  ];
  return lines.join('\n');
}

export function formatStatusText(status: SystemStatus): string {
  const lines = [
    `Initialized:   ${status.initialized ? 'yes' : 'no'}`,
    `App version:   ${status.appVersion}`,
    `Schema:        ${status.schemaVersion ?? 'none'}`,
    `Timezone:      ${status.timezone ?? 'unconfigured'}`,
    `Data dir:      ${status.dataDir ?? 'unconfigured'}`,
    `Active focus:  ${
      status.activeFocusSession
        ? `${status.activeFocusSession.id} (started ${status.activeFocusSession.startedAt})`
        : 'none'
    }`,
  ];
  return lines.join('\n');
}

export function formatProjectListText(res: ListProjectsOutput): string {
  if (res.projects.length === 0) return 'No projects found.';
  const lines = res.projects.map(
    (p) => `- [${p.status}] ${p.name} (${p.id})${p.description ? ` — ${p.description}` : ''}`,
  );
  if (res.nextCursor) lines.push(`Next cursor: ${res.nextCursor}`);
  return lines.join('\n');
}

export function formatProjectMutationText(
  res: CreateProjectOutput | UpdateProjectOutput,
  verb: string,
): string {
  return `${verb} project "${res.project.name}" (${res.project.id}) [${res.project.status}].`;
}

export function formatTaskListText(res: ListTasksOutput): string {
  if (res.tasks.length === 0) return 'No tasks found.';
  const lines = res.tasks.map((t) => {
    const due = t.dueDate ?? t.dueAt ?? 'no-due';
    const est = t.estimateMinutes !== null ? `${t.estimateMinutes}m` : 'unestimated';
    const proj = t.projectName ? ` @${t.projectName}` : '';
    return `- [${t.status}] (${t.priority}, ${est}, ${due}) ${t.title}${proj} (${t.id})`;
  });
  if (res.nextCursor) lines.push(`Next cursor: ${res.nextCursor}`);
  return lines.join('\n');
}

export function formatTaskDetailText(res: GetTaskOutput): string {
  const t = res.task;
  return [
    `Title:       ${t.title}`,
    `ID:          ${t.id}`,
    `Status:      ${t.status}`,
    `Priority:    ${t.priority}`,
    `Project:     ${res.projectName ?? 'none'}`,
    `Estimate:    ${t.estimateMinutes !== null ? `${t.estimateMinutes} min` : 'unspecified'}`,
    `Due:         ${t.dueDate ?? t.dueAt ?? 'unspecified'}`,
    `Tags:        ${t.tags.length > 0 ? t.tags.join(', ') : 'none'}`,
    `Source:      ${t.sourceAgent}`,
    `Description: ${t.description ?? '(none)'}`,
  ].join('\n');
}

export function formatCaptureTaskText(res: CaptureTaskOutput): string {
  const prefix = res.deduplicated ? 'Returned existing task (idempotent)' : 'Captured task';
  const missing =
    res.unspecifiedFields.length > 0 ? ` Unspecified: ${res.unspecifiedFields.join(', ')}.` : '';
  return `${prefix} "${res.task.title}" (${res.task.id}).${missing}`;
}

export function formatUpdateTaskText(res: UpdateTaskOutput): string {
  return `Updated task "${res.task.title}" (${res.task.id}) [${res.task.status}].`;
}

export function formatCompleteTaskText(res: CompleteTaskOutput): string {
  const base = `Completed task "${res.task.title}" (${res.task.id}).`;
  return res.worklogEntry ? `${base} Logged completion worklog (${res.worklogEntry.id}).` : base;
}

export function formatTodayPlanText(plan: GetTodayPlanOutput): string {
  const lines: string[] = [
    `Daily Plan for ${plan.date} (${plan.timezone})`,
    `Notice: ${plan.disclaimer}`,
    `Budget: ${plan.availableMinutes} min | Planned: ${plan.totalEstimatedMinutes} min | Remaining: ${plan.remainingMinutes} min | Overdue: ${plan.overdueCount}`,
    '',
    'Recommended order:',
  ];
  if (plan.plannedTasks.length === 0) {
    lines.push('  (no estimated tasks fit in the available budget)');
  } else {
    for (const item of plan.plannedTasks) {
      lines.push(
        `  ${item.rank}. [${item.task.status}] ${item.task.title} (${item.task.estimateMinutes} min) — ${item.explanation}`,
      );
    }
  }
  lines.push('', 'Tasks needing estimates (not scheduled into budget):');
  if (plan.unscheduledMissingEstimate.length === 0) {
    lines.push('  (none)');
  } else {
    for (const item of plan.unscheduledMissingEstimate) {
      lines.push(`  - ${item.task.title} — ${item.explanation}`);
    }
  }
  if (plan.excludedTasks.length > 0) {
    lines.push('', 'Excluded (exceeds remaining budget):');
    for (const item of plan.excludedTasks) {
      lines.push(`  - ${item.task.title} — ${item.explanation}`);
    }
  }
  return lines.join('\n');
}

export function formatFocusStartText(res: StartFocusOutput): string {
  return `Started focus session ${res.session.id} at ${res.session.startedAt}.`;
}

export function formatFocusFinishText(res: FinishFocusOutput): string {
  const base = `Finished focus session ${res.session.id} [${res.session.status}] (${res.session.durationSeconds ?? 0}s).`;
  return res.worklogEntry ? `${base} Created worklog ${res.worklogEntry.id}.` : base;
}

export function formatFocusListText(res: ListFocusSessionsOutput): string {
  if (res.sessions.length === 0) return 'No focus sessions found.';
  const lines = res.sessions.map(
    (s) =>
      `- [${s.status}] ${s.id} started ${s.startedAt}${s.durationSeconds !== null ? ` (${s.durationSeconds}s)` : ''} (${s.sourceAgent})`,
  );
  if (res.nextCursor) lines.push(`Next cursor: ${res.nextCursor}`);
  return lines.join('\n');
}

export function formatWorklogAddText(res: LogWorkOutput): string {
  const prefix = res.deduplicated ? 'Returned existing worklog (idempotent)' : 'Logged work';
  return `${prefix} (${res.entry.id}): ${res.entry.summary}`;
}

export function formatWorklogListText(res: ListWorklogOutput): string {
  const lines = [
    `Worklog entries: ${res.totalEntries} | Total logged minutes: ${res.totalDurationMinutes} | Without duration: ${res.entriesWithoutDuration}`,
  ];
  for (const e of res.entries) {
    const dur = e.durationMinutes !== null ? `${e.durationMinutes}m` : 'no-duration';
    lines.push(`- ${e.occurredAt} [${dur}, ${e.sourceAgent}] ${e.summary} (${e.id})`);
  }
  if (res.nextCursor) lines.push(`Next cursor: ${res.nextCursor}`);
  return lines.join('\n');
}

export function formatDailyReviewText(r: DailyReviewOutput): string {
  const lines = [
    `Daily Review — ${r.date} (${r.timezone})`,
    `Completed tasks: ${r.completedTasks.length} | In progress: ${r.inProgressTasks.length} | Overdue: ${r.overdueTasks.length}`,
    `Focus time: ${Math.round(r.totalFocusSeconds / 60)} min (${r.totalFocusSeconds}s across ${r.focusSessions.length} session(s))`,
    `Logged work: ${r.totalWorklogMinutes} min across ${r.worklogEntries.length} entry/entries`,
  ];
  if (r.dataGaps.length > 0) {
    lines.push('', 'Data gaps:');
    for (const g of r.dataGaps) lines.push(`  - ${g}`);
  }
  if (r.suggestedNextActions.length > 0) {
    lines.push('', 'Suggested next actions:');
    for (const a of r.suggestedNextActions) lines.push(`  - ${a.message}`);
  }
  return lines.join('\n');
}

export function formatWeeklyReviewText(r: WeeklyReviewOutput): string {
  const lines = [
    `Weekly Review — ${r.weekStartDate} to ${r.weekEndDate} (${r.timezone}, week starts ${r.weekStartsOn})`,
    `Completed tasks: ${r.completedTasks.length} | In progress: ${r.inProgressTasks.length} | Overdue: ${r.overdueTasks.length}`,
    `Focus time: ${Math.round(r.totalFocusSeconds / 60)} min (${r.totalFocusSeconds}s) | Logged work: ${r.totalWorklogMinutes} min`,
    '',
    'Day-by-day totals:',
  ];
  for (const d of r.dailyTotals) {
    lines.push(
      `  ${d.date}: completed=${d.completedTasksCount}, focus=${d.focusSeconds}s, worklogs=${d.worklogCount} (${d.worklogMinutes}m)`,
    );
  }
  if (r.dataGaps.length > 0) {
    lines.push('', 'Data gaps:');
    for (const g of r.dataGaps) lines.push(`  - ${g}`);
  }
  if (r.suggestedNextActions.length > 0) {
    lines.push('', 'Suggested next actions:');
    for (const a of r.suggestedNextActions) lines.push(`  - ${a.message}`);
  }
  return lines.join('\n');
}

export function formatImportValidationText(v: ImportValidationResult): string {
  const lines = [
    `Dry-run validation (${v.mode}): ${v.valid ? 'VALID' : 'INVALID'}`,
    `Counts: projects=${v.counts.projects}, tasks=${v.counts.tasks}, tags=${v.counts.tags}, focus=${v.counts.focusSessions}, worklogs=${v.counts.worklogEntries}`,
  ];
  if (v.conflicts.length > 0) lines.push(`Conflicts: ${v.conflicts.join(', ')}`);
  if (v.errors.length > 0) lines.push(`Errors: ${v.errors.join('; ')}`);
  return lines.join('\n');
}

export function formatImportResultText(r: ImportResult): string {
  return `Imported backup (${r.mode}): ${r.imported.projects} projects, ${r.imported.tasks} tasks, ${r.imported.focusSessions} focus sessions, ${r.imported.worklogEntries} worklogs.`;
}
