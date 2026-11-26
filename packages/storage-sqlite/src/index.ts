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
import { assertValidTimezone, type DaymarkRepositories, type DaymarkStore } from '@daymark/core';
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
  const raw = new Database(filename);
  raw.pragma('journal_mode = WAL');
  raw.pragma('foreign_keys = ON');
  raw.pragma('busy_timeout = 5000');
  const db = drizzle(raw, { schema: daymarkSchema });
  return {
    raw,
    db,
    close: () => {
      raw.close();
    },
  };
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
      const hasSettingsTable = c.raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
        .get();
      if (!hasSettingsTable) return false;
      const repos = createSqliteRepositories(c.db, c.raw);
      return repos.settings.getSettings() !== null;
    },
    getDataDir() {
      return paths.dataDir;
    },
    getSchemaVersion() {
      const c = ensureConnection();
      if (!c) return null;
      return getLatestAppliedMigration(c.raw);
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
