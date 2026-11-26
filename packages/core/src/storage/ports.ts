import {
  type AgentSource,
  type BackupArchive,
  DaymarkError,
  type ImportMode,
  type Priority,
  type SettingsDto,
  type TaskStatus,
} from '@daymark/contracts';
import type {
  FocusSessionRecord,
  ProjectRecord,
  TagRecord,
  TaskRecord,
  TaskTagRecord,
  WorklogEntryRecord,
} from '../domain/records.js';

export type {
  FocusSessionRecord,
  ProjectRecord,
  TagRecord,
  TaskRecord,
  TaskTagRecord,
  WorklogEntryRecord,
} from '../domain/records.js';

export type StorageBackendKind =
  | 'sqlite-local'
  | 'sqlite-d1'
  | 'libsql-turso'
  | 'postgres'
  | 'memory';

export interface TenantContext {
  tenantId: string;
  userId?: string;
}

export interface StorageCapabilities {
  backendKind: StorageBackendKind;
  transactional: boolean;
  multiTenant: boolean;
  supportsLocalPaths: boolean;
  persistenceModel: 'sync' | 'async';
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
  getCapabilities?(): StorageCapabilities;
  transaction<T>(fn: (repos: DaymarkRepositories) => T): T;
}

// --- Cloud-ready async & tenant-aware storage abstraction (Phase A / Phase E) ---

type AsyncMethod<F> = F extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never;

type AsyncRepo<T> = {
  [K in keyof T]: AsyncMethod<T[K]>;
};

export interface AsyncDaymarkRepositories {
  projects: AsyncRepo<ProjectRepository>;
  tasks: AsyncRepo<TaskRepository>;
  focusSessions: AsyncRepo<FocusSessionRepository>;
  worklogs: AsyncRepo<WorklogRepository>;
  settings: AsyncRepo<SettingsRepository>;
  idempotency: AsyncRepo<IdempotencyRepository>;
  backup: AsyncRepo<BackupRepository>;
}

/**
 * Storage abstraction designed for cloud backends (D1, Turso, Postgres).
 * Intentionally excludes local filesystem paths (such as `getDataDir`).
 */
export interface AsyncDaymarkStore {
  getCapabilities(): StorageCapabilities;
  isInitialized(tenant?: TenantContext): Promise<boolean>;
  getSchemaVersion(): Promise<string | null>;
  transaction<T>(
    fn: (repos: AsyncDaymarkRepositories) => Promise<T>,
    options?: { tenant?: TenantContext },
  ): Promise<T>;
}

function wrapRepoAsync<T extends object>(repo: T): AsyncRepo<T> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(repo) as (keyof T & string)[]) {
    const fn = repo[key];
    if (typeof fn === 'function') {
      out[key] = async (...args: unknown[]) =>
        (fn as (...a: unknown[]) => unknown).apply(repo, args);
    }
  }
  return out as AsyncRepo<T>;
}

/**
 * Adapts a synchronous local DaymarkStore into the async cloud-ready storage interface.
 */
export function toAsyncDaymarkStore(
  syncStore: DaymarkStore,
  capabilitiesOverride?: Partial<StorageCapabilities>,
): AsyncDaymarkStore {
  const baseCaps = syncStore.getCapabilities?.() ?? {
    backendKind: 'sqlite-local' as const,
    transactional: true,
    multiTenant: false,
    supportsLocalPaths: true,
    persistenceModel: 'sync' as const,
  };
  const capabilities: StorageCapabilities = {
    ...baseCaps,
    ...capabilitiesOverride,
    persistenceModel: 'async',
  };

  return {
    getCapabilities() {
      return capabilities;
    },
    async isInitialized() {
      return syncStore.isInitialized();
    },
    async getSchemaVersion() {
      return syncStore.getSchemaVersion();
    },
    async transaction<T>(fn: (repos: AsyncDaymarkRepositories) => Promise<T>): Promise<T> {
      // Note: local synchronous stores cannot await inside a SQLite BEGIN/COMMIT callback;
      // cloud async drivers implement AsyncDaymarkStore directly using driver transactions/batches.
      const syncRepos = syncStore.transaction((r) => r);
      const asyncRepos: AsyncDaymarkRepositories = {
        projects: wrapRepoAsync(syncRepos.projects),
        tasks: wrapRepoAsync(syncRepos.tasks),
        focusSessions: wrapRepoAsync(syncRepos.focusSessions),
        worklogs: wrapRepoAsync(syncRepos.worklogs),
        settings: wrapRepoAsync(syncRepos.settings),
        idempotency: wrapRepoAsync(syncRepos.idempotency),
        backup: wrapRepoAsync(syncRepos.backup),
      };
      return await fn(asyncRepos);
    },
  };
}

// Web-standard UTF-8 <-> base64url helpers (zero Node Buffer dependency)
function encodeUtf8Base64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = '';
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function decodeUtf8Base64Url(encoded: string): string {
  const padded = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (padded.length % 4)) % 4;
  const binary = atob(`${padded}${'='.repeat(padLen)}`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function encodeOffsetCursor(offset: number): string {
  return encodeUtf8Base64Url(JSON.stringify({ offset }));
}

export function decodeOffsetCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const raw = decodeUtf8Base64Url(cursor);
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
