import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  type DaymarkPaths,
  defaultWeekStartsOn,
  detectSystemTimezone,
  enforceOwnerOnlyFileMode,
  ensureSecureDir,
  readProfileConfig,
  resolveDaymarkPaths,
  writeProfileConfig,
} from '@daymark/config';
import { DaymarkError, type SettingsDto, type WeekStartsOn } from '@daymark/contracts';
import {
  type AsyncDaymarkStore,
  assertValidTimezone,
  type DaymarkRepositories,
  type DaymarkStore,
  type StorageCapabilities,
  toAsyncDaymarkStore,
} from '@daymark/core';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { getLatestAppliedMigration, runMigrations } from './migrator.js';
import { createSqliteRepositories, type DrizzleDb } from './repositories.js';
import { daymarkSchema } from './schema.js';

export * from './migrator.js';
export * from './repositories.js';
export * from './schema.js';

export interface SqliteConnection {
  raw: Database.Database;
  db: DrizzleDb;
  close: () => void;
}

export function openSqliteConnection(filename: string): SqliteConnection {
  let raw: Database.Database | null = null;
  try {
    raw = new Database(filename);
    raw.pragma('journal_mode = WAL');
    raw.pragma('foreign_keys = ON');
    raw.pragma('busy_timeout = 5000');
    const db = drizzle(raw, { schema: daymarkSchema });
    const closedRef = { closed: false };
    const openedRaw = raw;
    return {
      raw: openedRaw,
      db,
      close: () => {
        if (!closedRef.closed) {
          closedRef.closed = true;
          openedRaw.close();
        }
      },
    };
  } catch (err) {
    if (raw) {
      try {
        raw.close();
      } catch {
        // ignore secondary close failure when mapping primary SQLite error
      }
    }
    mapSqliteError(err);
  }
}

function mapSqliteError(err: unknown): never {
  if (err instanceof DaymarkError) throw err;
  if (err && typeof err === 'object' && 'code' in err) {
    const code = String((err as { code: unknown }).code);
    if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
      throw new DaymarkError(
        'DATABASE_BUSY',
        'Daymark SQLite database is temporarily locked by another process.',
        { nextStep: 'Retry the operation shortly.', cause: err },
      );
    }
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT_VTAB') {
      throw new DaymarkError(
        'DATABASE_CORRUPT',
        'Daymark SQLite database is corrupted or not a valid SQLite database file.',
        {
          nextStep:
            'Move the damaged database file (and any -wal/-shm files) aside, run `daymark init`, and restore from backup with `daymark import <file> --mode replace --confirm`.',
          cause: err,
        },
      );
    }
    if (
      code === 'SQLITE_CONSTRAINT_UNIQUE' &&
      err instanceof Error &&
      err.message.includes('focus_sessions')
    ) {
      throw new DaymarkError(
        'FOCUS_SESSION_ALREADY_ACTIVE',
        'Another focus session is already active.',
        { nextStep: 'Finish the active focus session before starting a new one.', cause: err },
      );
    }
  }
  throw err;
}

export interface SqliteIntegrityReport {
  exists: boolean;
  ok: boolean;
  messages: string[];
  errorCode?: string;
}

export interface SqliteDriverReport {
  ready: boolean;
  driver: 'better-sqlite3';
  nodeVersion: string;
  error?: string;
  troubleshooting?: string[];
}

/**
 * Validates whether the native `better-sqlite3` driver bindings load and execute queries cleanly.
 * Catches C++ binary loading issues, ABI version mismatches, and returns platform-specific remedies.
 */
export function checkSqliteDriver(): SqliteDriverReport {
  let mem: Database.Database | null = null;
  try {
    mem = new Database(':memory:');
    mem.pragma('journal_mode = WAL');
    const row = mem.prepare('SELECT 1 as alive').get() as { alive?: number };
    const ready = row?.alive === 1;
    mem.close();
    mem = null;
    return {
      ready,
      driver: 'better-sqlite3',
      nodeVersion: process.version,
    };
  } catch (err) {
    if (mem) {
      try {
        mem.close();
      } catch {
        // ignore secondary close
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    const isWindows = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const troubleshooting: string[] = [
      'Rebuild native addon for your current Node version: `pnpm rebuild better-sqlite3` (or `npm rebuild better-sqlite3`)',
    ];
    if (isWindows) {
      troubleshooting.push(
        'Windows: Install Visual Studio Build Tools with Desktop development with C++ or run `npm install --global windows-build-tools`',
        'Windows: Ensure Python >= 3.10 is installed and available in your PATH for node-gyp',
      );
    } else if (isMac) {
      troubleshooting.push(
        'macOS: Install command line developer tools with `xcode-select --install`',
      );
    } else {
      troubleshooting.push(
        'Linux: Install C++ compiler and Python headers, e.g. `sudo apt-get install -y build-essential python3`',
      );
    }
    troubleshooting.push(
      'Node 24 Notice: If prebuilt binaries for your Node ABI are not published yet, building from source requires C++ toolchain and python3.',
    );
    return {
      ready: false,
      driver: 'better-sqlite3',
      nodeVersion: process.version,
      error: message,
      troubleshooting,
    };
  }
}

/**
 * Runs SQLite `PRAGMA integrity_check` safely without throwing on damaged files.
 */
export function checkSqliteIntegrity(filename: string): SqliteIntegrityReport {
  if (!existsSync(filename)) {
    return {
      exists: false,
      ok: false,
      messages: ['Database file does not exist.'],
    };
  }
  let conn: SqliteConnection | null = null;
  try {
    conn = openSqliteConnection(filename);
    const rows = conn.raw.pragma('integrity_check') as Array<{ integrity_check?: string }>;
    const messages = rows
      .map((r) => r.integrity_check)
      .filter((msg): msg is string => typeof msg === 'string' && msg.length > 0);
    const ok = messages.length === 1 && messages[0] === 'ok';
    return {
      exists: true,
      ok,
      messages: messages.length > 0 ? messages : ['Unknown integrity check result.'],
      errorCode: ok ? undefined : 'DATABASE_CORRUPT',
    };
  } catch (err) {
    if (err instanceof DaymarkError) {
      return {
        exists: true,
        ok: false,
        messages: [err.message],
        errorCode: err.code,
      };
    }
    return {
      exists: true,
      ok: false,
      messages: [err instanceof Error ? err.message : 'Failed integrity check.'],
      errorCode: 'DATABASE_CORRUPT',
    };
  } finally {
    if (conn) {
      try {
        conn.close();
      } catch {
        // ignore close error on damaged connection
      }
    }
  }
}

export interface InitializeProfileOptions {
  paths?: DaymarkPaths;
  timezone?: string;
  weekStartsOn?: WeekStartsOn;
  dayStartTime?: string;
  defaultPlanMinutes?: number | null;
  nowMs?: number;
}

export interface InitializeProfileResult {
  alreadyInitialized: boolean;
  paths: DaymarkPaths;
  schemaVersion: string;
  settings: SettingsDto;
  appliedMigrations: string[];
}

/**
 * Safely initializes the local Daymark directory, config.json, SQLite database,
 * migrations, and default settings. Re-running never overwrites existing user data.
 */
export function initializeProfile(options: InitializeProfileOptions = {}): InitializeProfileResult {
  const paths = options.paths ?? resolveDaymarkPaths();
  const nowMs = options.nowMs ?? Date.now();
  const existingConfig = readProfileConfig(paths.configPath);

  const timezone = assertValidTimezone(
    options.timezone ?? existingConfig?.timezone ?? detectSystemTimezone(),
  );
  const weekStartsOn =
    options.weekStartsOn ?? existingConfig?.weekStartsOn ?? defaultWeekStartsOn();
  const dayStartTime = options.dayStartTime ?? existingConfig?.dayStartTime ?? '09:00';
  const defaultPlanMinutes =
    options.defaultPlanMinutes !== undefined
      ? options.defaultPlanMinutes
      : (existingConfig?.defaultPlanMinutes ?? null);

  ensureSecureDir(paths.dataDir);
  ensureSecureDir(paths.configDir);
  ensureSecureDir(dirname(paths.databasePath));
  ensureSecureDir(paths.backupsDir);

  const conn = openSqliteConnection(paths.databasePath);
  try {
    const migration = runMigrations(conn.raw, nowMs);
    const repos = createSqliteRepositories(conn.db, conn.raw);
    const existingSettings = repos.settings.getSettings();
    const alreadyInitialized = existingSettings !== null && existingConfig !== null;

    let finalSettings: SettingsDto;
    if (existingSettings === null) {
      finalSettings = {
        timezone,
        weekStartsOn,
        dayStartTime,
        defaultPlanMinutes,
      };
      conn.raw.transaction(() => {
        repos.settings.saveSettings(finalSettings, nowMs);
      })();
    } else {
      finalSettings = existingSettings;
    }

    if (existingConfig === null) {
      writeProfileConfig(paths.configPath, {
        version: 1,
        databasePath: paths.databasePath,
        timezone: finalSettings.timezone,
        weekStartsOn: finalSettings.weekStartsOn,
        dayStartTime: finalSettings.dayStartTime,
        defaultPlanMinutes: finalSettings.defaultPlanMinutes,
      });
    }

    enforceOwnerOnlyFileMode(paths.databasePath);

    return {
      alreadyInitialized,
      paths,
      schemaVersion: migration.currentVersion ?? 'unknown',
      settings: finalSettings,
      appliedMigrations: migration.applied,
    };
  } finally {
    conn.close();
  }
}

export interface ManagedDaymarkStore extends DaymarkStore {
  close(): void;
  getRawDatabase(): Database.Database | null;
  getCapabilities(): StorageCapabilities;
}

/**
 * Opens an existing Daymark SQLite store lazily without silently creating an empty
 * database file when the profile has not yet been initialized.
 */
export function openDaymarkStore(paths: DaymarkPaths = resolveDaymarkPaths()): ManagedDaymarkStore {
  let conn: SqliteConnection | null = null;

  function ensureConnection(): SqliteConnection | null {
    if (conn) return conn;
    if (!existsSync(paths.databasePath)) {
      return null;
    }
    conn = openSqliteConnection(paths.databasePath);
    return conn;
  }

  return {
    isInitialized() {
      const c = ensureConnection();
      if (!c) return false;
      try {
        const hasSettingsTable = c.raw
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
          .get();
        if (!hasSettingsTable) return false;
        const repos = createSqliteRepositories(c.db, c.raw);
        return repos.settings.getSettings() !== null;
      } catch (err) {
        mapSqliteError(err);
      }
    },
    getDataDir() {
      return paths.dataDir;
    },
    getSchemaVersion() {
      const c = ensureConnection();
      if (!c) return null;
      try {
        return getLatestAppliedMigration(c.raw);
      } catch (err) {
        mapSqliteError(err);
      }
    },
    getCapabilities() {
      return {
        backendKind: 'sqlite-local',
        transactional: true,
        multiTenant: false,
        supportsLocalPaths: true,
        persistenceModel: 'sync',
      };
    },
    transaction<T>(fn: (repos: DaymarkRepositories) => T): T {
      const c = ensureConnection();
      if (!c) {
        throw new DaymarkError('PROFILE_NOT_INITIALIZED', 'Daymark database file does not exist.', {
          nextStep: 'Run `daymark init` to create the local Daymark database.',
        });
      }
      const repos = createSqliteRepositories(c.db, c.raw);
      try {
        return c.raw.transaction(() => fn(repos))();
      } catch (err) {
        mapSqliteError(err);
      }
    },
    close() {
      if (conn) {
        conn.close();
        conn = null;
      }
    },
    getRawDatabase() {
      return ensureConnection()?.raw ?? null;
    },
  };
}

export function openAsyncDaymarkStore(
  paths: DaymarkPaths = resolveDaymarkPaths(),
): AsyncDaymarkStore & { close(): void } {
  const syncStore = openDaymarkStore(paths);
  const asyncStore = toAsyncDaymarkStore(syncStore);
  return {
    ...asyncStore,
    close: () => syncStore.close(),
  };
}
