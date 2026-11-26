import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';

export function resolveMigrationsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const distPath = resolve(here, './migrations');
  if (existsSync(distPath)) return distPath;
  return resolve(here, '../migrations');
}

export function listMigrationFiles(migrationsDir = resolveMigrationsDir()): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

export function getAppliedMigrationVersions(raw: Database.Database): string[] {
  const hasTable = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!hasTable) return [];
  const rows = raw.prepare('SELECT version FROM schema_migrations ORDER BY version ASC').all() as {
    version: string;
  }[];
  return rows.map((r) => r.version);
}

export function getLatestAppliedMigration(raw: Database.Database): string | null {
  const versions = getAppliedMigrationVersions(raw);
  return versions.length > 0 ? (versions[versions.length - 1] ?? null) : null;
}

/**
 * Applies pending forward-only SQL migrations inside a single SQLite transaction.
 */
export function runMigrations(
  raw: Database.Database,
  nowMs: number = Date.now(),
  migrationsDir: string = resolveMigrationsDir(),
): { applied: string[]; currentVersion: string | null } {
  raw.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    );
  `);

  const files = listMigrationFiles(migrationsDir);
  const appliedSet = new Set(getAppliedMigrationVersions(raw));
  const newlyApplied: string[] = [];

  const applyTx = raw.transaction(() => {
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (appliedSet.has(version)) continue;
      const sql = readFileSync(join(migrationsDir, file), 'utf8');
      raw.exec(sql);
      raw
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(version, nowMs);
      newlyApplied.push(version);
    }
  });

  applyTx();
  return {
    applied: newlyApplied,
    currentVersion: getLatestAppliedMigration(raw),
  };
}
