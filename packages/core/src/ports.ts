import {
  type AgentSource,
  type BackupArchive,
  DaymarkError,
  type FocusSessionStatus,
  type ImportMode,
  type Priority,
  type ProjectStatus,
  type SettingsDto,
  type TaskStatus,
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

export interface ProjectRepository {
  findById(id: string): ProjectRecord | null;
  list(filter: { status: 'active' | 'archived' | 'all'; limit: number; offset: number }): {
    items: ProjectRecord[];
    hasMore: boolean;
  };
  create(record: ProjectRecord): void;
  update(
    id: string,
    patch: Partial<
      Pick<ProjectRecord, 'name' | 'description' | 'status' | 'updatedAtMs' | 'archivedAtMs'>
    >,
  ): ProjectRecord | null;
}

export interface TaskListFilter {
  statuses?: TaskStatus[];
  priority?: Priority;
  projectId?: string;
  query?: string;
}

export interface TaskRepository {
  findById(id: string): TaskRecord | null;
  listAll(filter?: TaskListFilter): TaskRecord[];
  create(record: Omit<TaskRecord, 'projectName'>): void;
  update(
    id: string,
    patch: {
      title?: string;
      description?: string | null;
      projectId?: string | null;
      status?: TaskStatus;
      priority?: Priority;
      estimateMinutes?: number | null;
      dueAtMs?: number | null;
      dueDate?: string | null;
      completedAtMs?: number | null;
      updatedAtMs: number;
      tags?: string[];
    },
  ): TaskRecord | null;
  listCompletedInRange(fromMs: number, toMs: number): TaskRecord[];
  listOpen(): TaskRecord[];
}

export interface FocusSessionRepository {
  findById(id: string): FocusSessionRecord | null;
  findActive(): FocusSessionRecord | null;
  list(filter: {
    status: 'active' | 'completed' | 'interrupted' | 'all';
    taskId?: string;
    projectId?: string;
    limit: number;
    offset: number;
  }): { items: FocusSessionRecord[]; hasMore: boolean };
  listInRange(fromMs: number, toMs: number): FocusSessionRecord[];
  create(record: FocusSessionRecord): void;
  finish(
    id: string,
    patch: {
      status: 'completed' | 'interrupted';
      endedAtMs: number;
      durationSeconds: number;
      note: string | null;
      updatedAtMs: number;
    },
  ): FocusSessionRecord | null;
}

export interface WorklogRepository {
  findById(id: string): WorklogEntryRecord | null;
  listInRange(filter: {
    fromMs: number;
    toMs: number;
    projectId?: string;
    taskId?: string;
    sourceAgent?: AgentSource;
  }): WorklogEntryRecord[];
  create(record: WorklogEntryRecord): void;
}

export interface SettingsRepository {
  getSettings(): SettingsDto | null;
  saveSettings(settings: SettingsDto, updatedAtMs: number): void;
  getSchemaVersion(): string | null;
}

export interface IdempotencyRepository {
  findResourceId(scope: string, key: string, nowMs: number): string | null;
  save(
    scope: string,
    key: string,
    resourceId: string,
    createdAtMs: number,
    expiresAtMs: number,
  ): void;
}

export interface BackupRepository {
  exportSnapshot(): {
    settings: SettingsDto;
    projects: ProjectRecord[];
    tasks: Omit<TaskRecord, 'projectName' | 'tags'>[];
    tags: TagRecord[];
    taskTags: TaskTagRecord[];
    focusSessions: FocusSessionRecord[];
    worklogEntries: WorklogEntryRecord[];
  };
  findConflictingIds(archive: BackupArchive): string[];
  importSnapshot(archive: BackupArchive, mode: ImportMode, nowMs: number): void;
}

export interface DaymarkRepositories {
  projects: ProjectRepository;
  tasks: TaskRepository;
  focusSessions: FocusSessionRepository;
  worklogs: WorklogRepository;
  settings: SettingsRepository;
  idempotency: IdempotencyRepository;
  backup: BackupRepository;
}

export interface DaymarkStore {
  isInitialized(): boolean;
  getDataDir(): string | null;
  getSchemaVersion(): string | null;
  transaction<T>(fn: (repos: DaymarkRepositories) => T): T;
}

export function encodeOffsetCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ offset }), 'utf8').toString('base64url');
}

export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'offset' in parsed &&
      typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return parsed.offset;
    }
  } catch {
    // Fall through to typed validation error
  }
  throw new DaymarkError('VALIDATION_FAILED', 'Invalid pagination cursor.');
}
