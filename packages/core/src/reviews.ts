import type {
  DailyReviewOutput,
  DailyReviewTotal,
  SuggestedAction,
  WeeklyReviewOutput,
  WeekStartsOn,
} from '@daymark/contracts';
import type { FocusSessionRecord, TaskRecord, WorklogEntryRecord } from './ports.js';
import {
  getPriorityWeight,
  toFocusSessionDto,
  toTaskSummaryDto,
  toWorklogEntryDto,
} from './rules.js';
import {
  endOfLocalDayUtcMs,
  formatUtcMsInTimezoneDate,
  getCalendarWeekDates,
  resolveEffectiveDueAtMs,
  startOfLocalDayUtcMs,
} from './time.js';

function findOverdueTasks(
  openTasks: TaskRecord[],
  cutoffDate: string,
  cutoffMs: number,
  timezone: string,
): TaskRecord[] {
  return openTasks
    .filter((task) => {
      if (task.dueDate !== null) {
        return task.dueDate < cutoffDate;
      }
      if (task.dueAtMs !== null) {
        return task.dueAtMs < cutoffMs;
      }
      return false;
    })
    .sort((a, b) => {
      const aDue = resolveEffectiveDueAtMs(a, timezone) ?? Number.MAX_SAFE_INTEGER;
      const bDue = resolveEffectiveDueAtMs(b, timezone) ?? Number.MAX_SAFE_INTEGER;
      if (aDue !== bDue) return aDue - bDue;
      return getPriorityWeight(a.priority) - getPriorityWeight(b.priority);
    });
}

function buildSuggestions(params: {
  activeFocus: FocusSessionRecord[];
  overdueTasks: TaskRecord[];
  inProgressTasks: TaskRecord[];
  openTasks: TaskRecord[];
  worklogCount: number;
}): SuggestedAction[] {
  const suggestions: SuggestedAction[] = [];
  const push = (action: SuggestedAction) => {
    if (suggestions.length < 3) suggestions.push(action);
  };

  for (const active of params.activeFocus) {
    push({
      kind: 'finish_active_focus',
      taskId: active.taskId,
      focusSessionId: active.id,
      message: 'Finish or interrupt the active focus session so elapsed duration is recorded.',
    });
  }

  for (const task of params.overdueTasks) {
    push({
      kind: 'resolve_overdue_task',
      taskId: task.id,
      focusSessionId: null,
      message: `Review overdue task "${task.title}" and either complete it or explicitly update its due date.`,
    });
  }

  for (const task of params.inProgressTasks) {
    if (!suggestions.some((s) => s.taskId === task.id)) {
      push({
        kind: 'continue_in_progress_task',
        taskId: task.id,
        focusSessionId: null,
        message: `Continue in-progress task "${task.title}".`,
      });
    }
  }

  const nextTodo = params.openTasks
    .filter((t) => t.status === 'todo' && !suggestions.some((s) => s.taskId === t.id))
    .sort((a, b) => getPriorityWeight(a.priority) - getPriorityWeight(b.priority))[0];
  if (nextTodo) {
    push({
      kind: 'start_next_task',
      taskId: nextTodo.id,
      focusSessionId: null,
      message: `Start next prioritized task "${nextTodo.title}".`,
    });
  }

  const unestimated = params.openTasks.find(
    (t) => t.estimateMinutes === null && !suggestions.some((s) => s.taskId === t.id),
  );
  if (unestimated) {
    push({
      kind: 'add_missing_estimate',
      taskId: unestimated.id,
      focusSessionId: null,
      message: `Add a duration estimate to "${unestimated.title}" so it can fit in daily planning.`,
    });
  }

  if (params.worklogCount === 0) {
    push({
      kind: 'capture_worklog',
      taskId: null,
      focusSessionId: null,
      message: 'Log completed work explicitly if work occurred outside recorded worklogs.',
    });
  }

  return suggestions;
}

function collectDataGaps(params: {
  periodLabel: string;
  completedCount: number;
  worklogEntries: WorklogEntryRecord[];
  activeFocus: FocusSessionRecord[];
  openTasks: TaskRecord[];
}): string[] {
  const gaps: string[] = [];
  if (params.completedCount === 0) {
    gaps.push(`No tasks were marked completed during ${params.periodLabel}.`);
  }
  if (params.worklogEntries.length === 0) {
    gaps.push(`No worklog entries were recorded for ${params.periodLabel}.`);
  } else {
    const missingDuration = params.worklogEntries.filter((w) => w.durationMinutes === null).length;
    if (missingDuration > 0) {
      gaps.push(
        `${missingDuration} worklog ${missingDuration === 1 ? 'entry has' : 'entries have'} no duration recorded.`,
      );
    }
  }
  if (params.activeFocus.length > 0) {
    gaps.push(
      `${params.activeFocus.length} focus ${params.activeFocus.length === 1 ? 'session is' : 'sessions are'} still active and excluded from completed focus time.`,
    );
  }
  const missingEstimate = params.openTasks.filter((t) => t.estimateMinutes === null).length;
  if (missingEstimate > 0) {
    gaps.push(
      `${missingEstimate} open ${missingEstimate === 1 ? 'task lacks' : 'tasks lack'} a time estimate.`,
    );
  }
  return gaps;
}

export function computeDailyReview(params: {
  date: string;
  timezone: string;
  nowMs: number;
  completedTasks: TaskRecord[];
  openTasks: TaskRecord[];
  focusSessionsInRange: FocusSessionRecord[];
  activeFocusSessions: FocusSessionRecord[];
  worklogEntries: WorklogEntryRecord[];
}): DailyReviewOutput {
  const todayInTz = formatUtcMsInTimezoneDate(params.nowMs, params.timezone);
  const endOfDayMs = endOfLocalDayUtcMs(params.date, params.timezone);
  const overdueCutoffMs = params.date === todayInTz ? params.nowMs : endOfDayMs;

  const inProgressTasks = params.openTasks.filter((t) => t.status === 'in_progress');
  const overdueTasks = findOverdueTasks(
    params.openTasks,
    params.date,
    overdueCutoffMs,
    params.timezone,
  );

  const totalFocusSeconds = params.focusSessionsInRange.reduce(
    (sum, s) => sum + (s.status !== 'active' && s.durationSeconds !== null ? s.durationSeconds : 0),
    0,
  );
  const totalWorklogMinutes = params.worklogEntries.reduce(
    (sum, w) => sum + (w.durationMinutes ?? 0),
    0,
  );

  const dataGaps = collectDataGaps({
    periodLabel: params.date,
    completedCount: params.completedTasks.length,
    worklogEntries: params.worklogEntries,
    activeFocus: params.activeFocusSessions,
    openTasks: params.openTasks,
  });

  const suggestedNextActions = buildSuggestions({
    activeFocus: params.activeFocusSessions,
    overdueTasks,
    inProgressTasks,
    openTasks: params.openTasks,
    worklogCount: params.worklogEntries.length,
  });

  return {
    date: params.date,
    timezone: params.timezone,
    completedTasks: params.completedTasks.map((t) => toTaskSummaryDto(t, params.timezone)),
    inProgressTasks: inProgressTasks.map((t) => toTaskSummaryDto(t, params.timezone)),
    overdueTasks: overdueTasks.map((t) => toTaskSummaryDto(t, params.timezone)),
    focusSessions: params.focusSessionsInRange.map(toFocusSessionDto),
    activeFocusSessions: params.activeFocusSessions.map(toFocusSessionDto),
    totalFocusSeconds,
    worklogEntries: params.worklogEntries.map(toWorklogEntryDto),
    totalWorklogMinutes,
    dataGaps,
    suggestedNextActions,
  };
}

export function computeWeeklyReview(params: {
  weekOfDate: string;
  weekStartsOn: WeekStartsOn;
  timezone: string;
  nowMs: number;
  completedTasks: TaskRecord[];
  openTasks: TaskRecord[];
  focusSessionsInRange: FocusSessionRecord[];
  activeFocusSessions: FocusSessionRecord[];
  worklogEntries: WorklogEntryRecord[];
}): WeeklyReviewOutput {
  const { weekStartDate, weekEndDate, dates } = getCalendarWeekDates(
    params.weekOfDate,
    params.weekStartsOn,
  );
  const todayInTz = formatUtcMsInTimezoneDate(params.nowMs, params.timezone);
  const weekEndMs = endOfLocalDayUtcMs(weekEndDate, params.timezone);
  let overdueCutoffDate = weekEndDate;
  if (todayInTz < weekEndDate) {
    overdueCutoffDate = todayInTz;
  }
  const overdueCutoffMs = todayInTz <= weekEndDate ? params.nowMs : weekEndMs;

  const inProgressTasks = params.openTasks.filter((t) => t.status === 'in_progress');
  const overdueTasks = findOverdueTasks(
    params.openTasks,
    overdueCutoffDate,
    overdueCutoffMs,
    params.timezone,
  );

  const dailyTotals: DailyReviewTotal[] = dates.map((date) => {
    const dayStart = startOfLocalDayUtcMs(date, params.timezone);
    const dayEnd = endOfLocalDayUtcMs(date, params.timezone);
    const dayCompleted = params.completedTasks.filter(
      (t) => t.completedAtMs !== null && t.completedAtMs >= dayStart && t.completedAtMs <= dayEnd,
    );
    const dayFocus = params.focusSessionsInRange.filter(
      (s) => s.startedAtMs >= dayStart && s.startedAtMs <= dayEnd,
    );
    const dayWorklogs = params.worklogEntries.filter(
      (w) => w.occurredAtMs >= dayStart && w.occurredAtMs <= dayEnd,
    );

    return {
      date,
      completedTasksCount: dayCompleted.length,
      focusSeconds: dayFocus.reduce(
        (sum, s) =>
          sum + (s.status !== 'active' && s.durationSeconds !== null ? s.durationSeconds : 0),
        0,
      ),
      worklogCount: dayWorklogs.length,
      worklogMinutes: dayWorklogs.reduce((sum, w) => sum + (w.durationMinutes ?? 0), 0),
    };
  });

  const totalFocusSeconds = params.focusSessionsInRange.reduce(
    (sum, s) => sum + (s.status !== 'active' && s.durationSeconds !== null ? s.durationSeconds : 0),
    0,
  );
  const totalWorklogMinutes = params.worklogEntries.reduce(
    (sum, w) => sum + (w.durationMinutes ?? 0),
    0,
  );

  const periodLabel = `${weekStartDate} to ${weekEndDate}`;
  const dataGaps = collectDataGaps({
    periodLabel,
    completedCount: params.completedTasks.length,
    worklogEntries: params.worklogEntries,
    activeFocus: params.activeFocusSessions,
    openTasks: params.openTasks,
  });

  const suggestedNextActions = buildSuggestions({
    activeFocus: params.activeFocusSessions,
    overdueTasks,
    inProgressTasks,
    openTasks: params.openTasks,
    worklogCount: params.worklogEntries.length,
  });

  return {
    weekStartDate,
    weekEndDate,
    weekStartsOn: params.weekStartsOn,
    timezone: params.timezone,
    completedTasks: params.completedTasks.map((t) => toTaskSummaryDto(t, params.timezone)),
    inProgressTasks: inProgressTasks.map((t) => toTaskSummaryDto(t, params.timezone)),
    overdueTasks: overdueTasks.map((t) => toTaskSummaryDto(t, params.timezone)),
    focusSessions: params.focusSessionsInRange.map(toFocusSessionDto),
    activeFocusSessions: params.activeFocusSessions.map(toFocusSessionDto),
    totalFocusSeconds,
    worklogEntries: params.worklogEntries.map(toWorklogEntryDto),
    totalWorklogMinutes,
    dailyTotals,
    dataGaps,
    suggestedNextActions,
  };
}
