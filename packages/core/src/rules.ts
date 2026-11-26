import {
  DaymarkError,
  type FocusSessionDto,
  type Priority,
  type ProjectDto,
  type TaskDto,
  type TaskStatus,
  type TaskSummaryDto,
  type WorklogEntryDto,
} from '@daymark/contracts';
import type { FocusSessionRecord, ProjectRecord, TaskRecord, WorklogEntryRecord } from './ports.js';
import { resolveEffectiveDueAtMs, toIsoUtc } from './time.js';

const ALLOWED_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  inbox: ['inbox', 'todo', 'in_progress', 'completed', 'cancelled', 'archived'],
  todo: ['inbox', 'todo', 'in_progress', 'completed', 'cancelled', 'archived'],
  in_progress: ['inbox', 'todo', 'in_progress', 'completed', 'cancelled', 'archived'],
  completed: ['inbox', 'todo', 'in_progress', 'completed', 'archived'],
  cancelled: ['inbox', 'todo', 'cancelled', 'archived'],
  archived: ['inbox', 'todo', 'archived'],
};

export function validateTaskStatusTransition(from: TaskStatus, to: TaskStatus): void {
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw new DaymarkError(
      'INVALID_STATUS_TRANSITION',
      `Cannot transition task from "${from}" to "${to}".`,
      {
        nextStep:
          from === 'archived' || from === 'cancelled'
            ? 'Reopen the task to "todo" or "inbox" before changing its state.'
            : 'Choose a valid target status for this task.',
        details: { from, to },
      },
    );
  }
}

const PRIORITY_WEIGHT: Record<Priority, number> = {
  high: 0,
  medium: 1,
  low: 2,
  none: 3,
};

export function getPriorityWeight(priority: Priority): number {
  return PRIORITY_WEIGHT[priority];
}

export function normalizeTags(tags?: string[]): string[] {
  if (!tags || tags.length === 0) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }
  return normalized;
}

export function toProjectDto(record: ProjectRecord): ProjectDto {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    status: record.status,
    createdAt: toIsoUtc(record.createdAtMs),
    updatedAt: toIsoUtc(record.updatedAtMs),
    archivedAt: record.archivedAtMs !== null ? toIsoUtc(record.archivedAtMs) : null,
  };
}

export function toTaskSummaryDto(record: TaskRecord, timeZone: string): TaskSummaryDto {
  const effectiveDueAtMs = resolveEffectiveDueAtMs(record, timeZone);
  return {
    id: record.id,
    title: record.title,
    projectId: record.projectId,
    projectName: record.projectName,
    status: record.status,
    priority: record.priority,
    estimateMinutes: record.estimateMinutes,
    dueAt: record.dueAtMs !== null ? toIsoUtc(record.dueAtMs) : null,
    dueDate: record.dueDate,
    effectiveDueAt: effectiveDueAtMs !== null ? toIsoUtc(effectiveDueAtMs) : null,
    completedAt: record.completedAtMs !== null ? toIsoUtc(record.completedAtMs) : null,
    createdAt: toIsoUtc(record.createdAtMs),
    updatedAt: toIsoUtc(record.updatedAtMs),
    sourceAgent: record.sourceAgent,
    tags: record.tags,
  };
}

export function toTaskDto(record: TaskRecord, timeZone: string): TaskDto {
  return {
    ...toTaskSummaryDto(record, timeZone),
    description: record.description,
    externalRef: record.externalRef,
  };
}

export function toFocusSessionDto(record: FocusSessionRecord): FocusSessionDto {
  return {
    id: record.id,
    taskId: record.taskId,
    projectId: record.projectId,
    status: record.status,
    startedAt: toIsoUtc(record.startedAtMs),
    endedAt: record.endedAtMs !== null ? toIsoUtc(record.endedAtMs) : null,
    durationSeconds: record.durationSeconds,
    note: record.note,
    sourceAgent: record.sourceAgent,
    createdAt: toIsoUtc(record.createdAtMs),
    updatedAt: toIsoUtc(record.updatedAtMs),
  };
}

export function toWorklogEntryDto(record: WorklogEntryRecord): WorklogEntryDto {
  return {
    id: record.id,
    taskId: record.taskId,
    projectId: record.projectId,
    focusSessionId: record.focusSessionId,
    summary: record.summary,
    details: record.details,
    durationMinutes: record.durationMinutes,
    occurredAt: toIsoUtc(record.occurredAtMs),
    sourceAgent: record.sourceAgent,
    createdAt: toIsoUtc(record.createdAtMs),
  };
}
