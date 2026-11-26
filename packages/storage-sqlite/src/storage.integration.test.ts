import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDaymarkPaths } from '@daymark/config';
import { DaymarkError } from '@daymark/contracts';
import { createDaymarkService } from '@daymark/core';
import { FIXED_IDS } from '@daymark/test-fixtures';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeProfile, openDaymarkStore, resolveMigrationsDir } from './index.js';

const tempDirs: string[] = [];

function makeTempPaths() {
  const dir = mkdtempSync(join(tmpdir(), 'daymark-sqlite-int-'));
  tempDirs.push(dir);
  return resolveDaymarkPaths({ env: { DAYMARK_HOME: dir } });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('@daymark/storage-sqlite integration', () => {
  it('initializes a fresh profile safely, is idempotent, and does not touch uninitialized DB on status', () => {
    const paths = makeTempPaths();
    const storeBefore = openDaymarkStore(paths);
    const serviceBefore = createDaymarkService({ store: storeBefore });
    expect(serviceBefore.getStatus().initialized).toBe(false);
    expect(existsSync(paths.databasePath)).toBe(false);
    storeBefore.close();

    const first = initializeProfile({ paths, timezone: 'Asia/Jakarta' });
    expect(first.alreadyInitialized).toBe(false);
    expect(first.schemaVersion).toBe('0001_due_date_and_indexes');
    expect(existsSync(paths.databasePath)).toBe(true);

    if (process.platform !== 'win32') {
      const mode = statSync(paths.databasePath).mode & 0o777;
      expect(mode).toBe(0o600);
    }

    const second = initializeProfile({ paths, timezone: 'America/New_York' });
    expect(second.alreadyInitialized).toBe(true);
    // Re-running init must preserve existing user timezone setting
    expect(second.settings.timezone).toBe('Asia/Jakarta');
  });

  it('migrates a prior-version (0000_initial) fixture cleanly without data loss', () => {
    const paths = makeTempPaths();
    const migrationsDir = resolveMigrationsDir();
    const v0Sql = readFileSync(join(migrationsDir, '0000_initial.sql'), 'utf8');

    const raw = new Database(paths.databasePath);
    raw.exec(v0Sql);
    raw
      .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
      .run('0000_initial', 1_700_000_000_000);
    raw
      .prepare(
        `INSERT INTO projects (id, name, description, status, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 1700000000000, 1700000000000)`,
      )
      .run(FIXED_IDS.projectAlpha, 'Legacy Project', null);
    raw
      .prepare(
        `INSERT INTO tasks (id, title, project_id, status, priority, created_at, updated_at, source_agent)
         VALUES (?, ?, ?, 'todo', 'high', 1700000000000, 1700000000000, 'cli')`,
      )
      .run(FIXED_IDS.taskTodayHigh, 'Legacy Task', FIXED_IDS.projectAlpha);
    raw.close();

    const migrated = initializeProfile({ paths, timezone: 'UTC' });
    expect(migrated.appliedMigrations).toEqual(['0001_due_date_and_indexes']);
    expect(migrated.schemaVersion).toBe('0001_due_date_and_indexes');

    const store = openDaymarkStore(paths);
    try {
      const svc = createDaymarkService({ store });
      const fetched = svc.getTask({ taskId: FIXED_IDS.taskTodayHigh });
      expect(fetched.task.title).toBe('Legacy Task');
      expect(fetched.projectName).toBe('Legacy Project');
    } finally {
      store.close();
    }
  });

  it('enforces single-active focus via SQLite partial unique index and rolls back failed transactions', () => {
    const paths = makeTempPaths();
    initializeProfile({ paths, timezone: 'UTC' });
    const store = openDaymarkStore(paths);

    try {
      const svc = createDaymarkService({ store });
      const proj = svc.createProject({ name: 'Core' });
      const cap = svc.captureTask({
        title: 'Write tests',
        projectId: proj.project.id,
        tags: ['deep-work', 'sqlite'],
        dueAt: '2026-11-26',
        estimateMinutes: 30,
      });

      const active = svc.startFocus({ taskId: cap.task.id, sourceAgent: 'cli' });
      expect(active.session.status).toBe('active');

      // Direct DB check that partial unique index blocks second active row even bypassing service check
      const raw = store.getRawDatabase();
      expect(() => {
        raw
          ?.prepare(
            `INSERT INTO focus_sessions (id, status, started_at, source_agent, created_at, updated_at)
             VALUES ('dup-active', 'active', 1700000000000, 'cli', 1700000000000, 1700000000000)`,
          )
          .run();
      }).toThrow(/UNIQUE/i);

      // Transaction rollback check: failing mid-transaction leaves task uncompleted
      expect(() => {
        store.transaction((repos) => {
          repos.tasks.update(cap.task.id, {
            status: 'completed',
            completedAtMs: Date.now(),
            updatedAtMs: Date.now(),
          });
          throw new DaymarkError('INTERNAL_ERROR', 'Simulated failure after task update');
        });
      }).toThrow(/Simulated failure/);

      const afterRollback = svc.getTask({ taskId: cap.task.id });
      expect(afterRollback.task.status).toBe('todo');
      expect(afterRollback.task.tags).toEqual(['deep-work', 'sqlite']);
    } finally {
      store.close();
    }
  });

  it('preserves IDs, tags, projects, focus sessions, and worklogs across export/import roundtrip', () => {
    const srcPaths = makeTempPaths();
    const dstPaths = makeTempPaths();
    initializeProfile({ paths: srcPaths, timezone: 'Asia/Jakarta' });
    initializeProfile({ paths: dstPaths, timezone: 'UTC' });

    const srcStore = openDaymarkStore(srcPaths);
    const dstStore = openDaymarkStore(dstPaths);

    try {
      const srcSvc = createDaymarkService({ store: srcStore });
      const proj = srcSvc.createProject({ name: 'Cross-Agent Sync' });
      const task = srcSvc.captureTask({
        title: 'Export/import test task',
        projectId: proj.project.id,
        priority: 'high',
        estimateMinutes: 45,
        dueAt: '2026-11-28',
        tags: ['mvp', 'backup'],
        sourceAgent: 'claude-code',
      });
      srcSvc.startFocus({ taskId: task.task.id, sourceAgent: 'cursor' });
      srcSvc.finishFocus({ createWorklog: true, note: 'Completed export prep' });
      srcSvc.completeTask({
        taskId: task.task.id,
        completionNote: 'All done',
        sourceAgent: 'codex',
      });

      const archive = srcSvc.exportBackup();

      const dstSvc = createDaymarkService({ store: dstStore });
      const dryRun = dstSvc.validateImport(archive, 'replace');
      expect(dryRun.valid).toBe(true);
      expect(dryRun.counts.tasks).toBe(1);
      expect(dryRun.counts.worklogEntries).toBe(2);

      const imported = dstSvc.importBackup(archive, { mode: 'replace', confirm: true });
      expect(imported.imported.tasks).toBe(1);

      const roundtripped = dstSvc.getTask({ taskId: task.task.id });
      expect(roundtripped.task.title).toBe('Export/import test task');
      expect(roundtripped.task.tags).toEqual(['backup', 'mvp']);
      expect(roundtripped.projectName).toBe('Cross-Agent Sync');

      const logs = dstSvc.listWorklog({ from: '2020-01-01', to: '2030-12-31' });
      expect(logs.totalEntries).toBe(2);
    } finally {
      srcStore.close();
      dstStore.close();
    }
  });
});
