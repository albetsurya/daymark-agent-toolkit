import type {
  ExcludedTaskItem,
  GetTodayPlanOutput,
  PlannedTaskItem,
  PlanRuleReason,
  Priority,
} from '@daymark/contracts';
import type { TaskRecord } from './records.js';
import { getPriorityWeight, toTaskSummaryDto } from './rules.js';
import {
  formatUtcMsInTimezoneDate,
  resolveEffectiveDueAtMs,
  startOfLocalDayUtcMs,
} from './time.js';

export interface DailyPlanRequest {
  tasks: TaskRecord[];
  planDate: string;
  timezone: string;
  availableMinutes: number;
  nowMs: number;
}

const PRIORITY_REASON: Record<Priority, PlanRuleReason> = {
  high: 'PRIORITY_HIGH',
  medium: 'PRIORITY_MEDIUM',
  low: 'PRIORITY_LOW',
  none: 'PRIORITY_NONE',
};

export function isTaskOverdueForDate(
  task: TaskRecord,
  planDate: string,
  timezone: string,
  nowMs: number,
): boolean {
  if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'archived') {
    return false;
  }
  if (task.dueDate !== null) {
    return task.dueDate < planDate;
  }
  if (task.dueAtMs !== null) {
    const todayInTz = formatUtcMsInTimezoneDate(nowMs, timezone);
    const cutoff = planDate <= todayInTz ? nowMs : startOfLocalDayUtcMs(planDate, timezone);
    return task.dueAtMs < cutoff;
  }
  return false;
}

function isTaskDueOnDate(task: TaskRecord, planDate: string, timezone: string): boolean {
  if (task.dueDate !== null) {
    return task.dueDate === planDate;
  }
  if (task.dueAtMs !== null) {
    return formatUtcMsInTimezoneDate(task.dueAtMs, timezone) === planDate;
  }
  return false;
}

function buildExplanation(reasons: PlanRuleReason[], estimateMinutes: number | null): string {
  const parts: string[] = [];
  if (reasons.includes('OVERDUE')) parts.push('overdue');
  else if (reasons.includes('DUE_TODAY')) parts.push('due today');

  if (reasons.includes('PRIORITY_HIGH')) parts.push('high priority');
  else if (reasons.includes('PRIORITY_MEDIUM')) parts.push('medium priority');
  else if (reasons.includes('PRIORITY_LOW')) parts.push('low priority');
  else parts.push('no priority set');

  if (estimateMinutes !== null && reasons.includes('FITS_BUDGET')) {
    parts.push(`fits remaining budget (${estimateMinutes} min)`);
  } else if (reasons.includes('MISSING_ESTIMATE')) {
    parts.push('missing estimate — not scheduled into time budget');
  }
  return parts.join('; ');
}

/**
 * Pure deterministic daily planner aligned with PRODUCT_SPEC.md §8:
 * 1. Exclude completed, cancelled, and archived tasks.
 * 2. Put overdue tasks ahead of non-overdue tasks.
 * 3. Sort by priority (high > medium > low > none).
 * 4. Within priority, sort by due date ascending (undated later).
 * 5. Tie-break stably by creation time ascending, then ID.
 * 6. Fill availableMinutes greedily; tasks lacking estimate go to unscheduledMissingEstimate.
 */
export function computeDailyPlan(req: DailyPlanRequest): GetTodayPlanOutput {
  const eligible = req.tasks.filter(
    (t) => t.status === 'inbox' || t.status === 'todo' || t.status === 'in_progress',
  );

  const annotated = eligible.map((task) => ({
    task,
    isOverdue: isTaskOverdueForDate(task, req.planDate, req.timezone, req.nowMs),
    isDueToday: isTaskDueOnDate(task, req.planDate, req.timezone),
    effectiveDueAtMs: resolveEffectiveDueAtMs(task, req.timezone),
  }));

  annotated.sort((a, b) => {
    if (a.isOverdue !== b.isOverdue) {
      return a.isOverdue ? -1 : 1;
    }
    const pDiff = getPriorityWeight(a.task.priority) - getPriorityWeight(b.task.priority);
    if (pDiff !== 0) return pDiff;

    if (a.effectiveDueAtMs !== null && b.effectiveDueAtMs !== null) {
      if (a.effectiveDueAtMs !== b.effectiveDueAtMs) {
        return a.effectiveDueAtMs - b.effectiveDueAtMs;
      }
    } else if (a.effectiveDueAtMs !== null) {
      return -1;
    } else if (b.effectiveDueAtMs !== null) {
      return 1;
    }

    if (a.task.createdAtMs !== b.task.createdAtMs) {
      return a.task.createdAtMs - b.task.createdAtMs;
    }
    return a.task.id.localeCompare(b.task.id);
  });

  const plannedTasks: PlannedTaskItem[] = [];
  const unscheduledMissingEstimate: PlannedTaskItem[] = [];
  const excludedTasks: ExcludedTaskItem[] = [];

  let remainingMinutes = req.availableMinutes;
  let totalEstimatedMinutes = 0;
  let overdueCount = 0;
  let plannedRank = 1;
  let unestimatedRank = 1;

  for (const item of annotated) {
    if (item.isOverdue) overdueCount += 1;

    const baseReasons: PlanRuleReason[] = [];
    if (item.isOverdue) baseReasons.push('OVERDUE');
    else if (item.isDueToday) baseReasons.push('DUE_TODAY');
    baseReasons.push(PRIORITY_REASON[item.task.priority]);

    const summary = toTaskSummaryDto(item.task, req.timezone);

    if (item.task.estimateMinutes === null) {
      const reasons: PlanRuleReason[] = [...baseReasons, 'MISSING_ESTIMATE'];
      unscheduledMissingEstimate.push({
        task: summary,
        rank: unestimatedRank++,
        isOverdue: item.isOverdue,
        reasons,
        explanation: buildExplanation(reasons, null),
      });
      continue;
    }

    if (item.task.estimateMinutes <= remainingMinutes) {
      const reasons: PlanRuleReason[] = [...baseReasons, 'FITS_BUDGET'];
      remainingMinutes -= item.task.estimateMinutes;
      totalEstimatedMinutes += item.task.estimateMinutes;
      plannedTasks.push({
        task: summary,
        rank: plannedRank++,
        isOverdue: item.isOverdue,
        reasons,
        explanation: buildExplanation(reasons, item.task.estimateMinutes),
      });
    } else {
      excludedTasks.push({
        task: summary,
        reason: 'EXCEEDS_REMAINING_BUDGET',
        explanation: `Requires ${item.task.estimateMinutes} min, but only ${remainingMinutes} min remain in budget.`,
      });
    }
  }

  return {
    date: req.planDate,
    timezone: req.timezone,
    isRecommendation: true,
    disclaimer:
      'Ranked suggestion only — not a reserved calendar schedule. Due dates and task estimates were not modified.',
    availableMinutes: req.availableMinutes,
    totalEstimatedMinutes,
    remainingMinutes,
    overdueCount,
    plannedTasks,
    unscheduledMissingEstimate,
    excludedTasks,
  };
}
