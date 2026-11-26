import type {
  AgentSource,
  FocusSessionStatus,
  Priority,
  ProjectStatus,
  TaskStatus,
} from '@daymark/contracts';

export interface ProjectRecord {
  id: string;
  name: string;
  description: string | null;
  status: ProjectStatus;
  createdAtMs: number;
  updatedAtMs: number;
  archivedAtMs: number | null;
}

export interface TaskRecord {
  id: string;
  title: string;
  description: string | null;
  projectId: string | null;
  projectName: string | null;
  status: TaskStatus;
  priority: Priority;
  estimateMinutes: number | null;
  dueAtMs: number | null;
  dueDate: string | null;
  completedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  sourceAgent: AgentSource;
  externalRef: string | null;
  tags: string[];
}

export interface FocusSessionRecord {
  id: string;
  taskId: string | null;
  projectId: string | null;
  status: FocusSessionStatus;
  startedAtMs: number;
  endedAtMs: number | null;
  durationSeconds: number | null;
  note: string | null;
  sourceAgent: AgentSource;
  createdAtMs: number;
  updatedAtMs: number;
}

export interface WorklogEntryRecord {
  id: string;
  taskId: string | null;
  projectId: string | null;
  focusSessionId: string | null;
  summary: string;
  details: string | null;
  durationMinutes: number | null;
  occurredAtMs: number;
  sourceAgent: AgentSource;
  createdAtMs: number;
}

export interface TagRecord {
  id: string;
  name: string;
  createdAtMs: number;
}

export interface TaskTagRecord {
  taskId: string;
  tagId: string;
}
