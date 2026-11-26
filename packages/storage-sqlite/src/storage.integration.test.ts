import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDaymarkPaths } from '@daymark/config';
import { DaymarkError } from '@daymark/contracts';
import { createDaymarkService } from '@daymark/core';
import { FIXED_IDS } from '@daymark/test-fixtures';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkSqliteIntegrity,
  initializeProfile,
  openDaymarkStore,
  resolveMigrationsDir,
} from './index.js';

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

  it('detects simulated SQLite corruption cleanly and recovers full state from exported backup', () => {
    const paths = makeTempPaths();
    initializeProfile({ paths, timezone: 'Asia/Jakarta' });
    const store = openDaymarkStore(paths);
    let taskId = '';
    let archive: ReturnType<ReturnType<typeof createDaymarkService>['exportBackup']>;

    try {
      const svc = createDaymarkService({ store });
      const proj = svc.createProject({ name: 'Disaster Recovery' });
      const cap = svc.captureTask({
        title: 'Critical pre-corruption task',
        projectId: proj.project.id,
        priority: 'high',
        estimateMinutes: 30,
        tags: ['recovery', 'sqlite'],
        sourceAgent: 'cli',
      });
      taskId = cap.task.id;
      svc.logWork({
        summary: 'Saved critical work before incident',
        taskId,
        durationMinutes: 25,
        sourceAgent: 'cli',
      });
      archive = svc.exportBackup();
      expect(checkSqliteIntegrity(paths.databasePath).ok).toBe(true);
    } finally {
      store.close();
    }

    // Corrupt database header/payload bytes and remove sidecar WAL/SHM if present
    for (const sidecar of [`${paths.databasePath}-wal`, `${paths.databasePath}-shm`]) {
      if (existsSync(sidecar)) {
        rmSync(sidecar, { force: true });
      }
    }
    writeFileSync(paths.databasePath, Buffer.from('CORRUPTED_NON_SQLITE_BYTES_'.repeat(64)));

    const integrity = checkSqliteIntegrity(paths.databasePath);
    expect(integrity.exists).toBe(true);
    expect(integrity.ok).toBe(false);
    expect(integrity.errorCode).toBe('DATABASE_CORRUPT');

    const corruptStore = openDaymarkStore(paths);
    try {
      const corruptSvc = createDaymarkService({ store: corruptStore });
      expect(() => corruptSvc.getStatus({})).toThrowError(DaymarkError);
      try {
        corruptSvc.getStatus({});
      } catch (err) {
        expect(err).toBeInstanceOf(DaymarkError);
        expect((err as DaymarkError).code).toBe('DATABASE_CORRUPT');
        expect((err as DaymarkError).nextStep).toContain('daymark import');
      }
    } finally {
      corruptStore.close();
    }

    // Quarantine corrupt DB, re-initialize profile cleanly, and restore backup
    rmSync(paths.databasePath, { force: true });
    initializeProfile({ paths, timezone: 'Asia/Jakarta' });
    const recoveredStore = openDaymarkStore(paths);
    try {
      const recoveredSvc = createDaymarkService({ store: recoveredStore });
      const dryRun = recoveredSvc.validateImport(archive, 'replace');
      expect(dryRun.valid).toBe(true);

      const imported = recoveredSvc.importBackup(archive, { mode: 'replace', confirm: true });
      expect(imported.imported.tasks).toBe(1);
      expect(imported.imported.worklogEntries).toBe(1);

      const restoredTask = recoveredSvc.getTask({ taskId });
      expect(restoredTask.task.title).toBe('Critical pre-corruption task');
      expect(restoredTask.task.tags).toEqual(['recovery', 'sqlite']);
      expect(checkSqliteIntegrity(paths.databasePath).ok).toBe(true);
    } finally {
      recoveredStore.close();
    }
  });

  it('recovers cleanly from process SIGTERM and abrupt SIGKILL mid-write without WAL corruption', async () => {
    const paths = makeTempPaths();
    initializeProfile({ paths, timezone: 'UTC' });
    const dbPath = paths.databasePath;

    // Seed one committed task before starting interrupted transactions
    const seedStore = openDaymarkStore(paths);
    let committedTaskId = '';
    try {
      const svc = createDaymarkService({ store: seedStore });
      const proj = svc.createProject({ name: 'WAL Resilience' });
      const created = svc.captureTask({
        title: 'Committed baseline task',
        projectId: proj.project.id,
        sourceAgent: 'cli',
      });
      committedTaskId = created.task.id;
    } finally {
      seedStore.close();
    }

    async function runInterruptedWrite(signal: 'SIGTERM' | 'SIGKILL', tempId: string) {
      const sqliteModuleUrl = new URL('../dist/index.mjs', import.meta.url).href;
      const childScript = `
        import { openSqliteConnection } from ${JSON.stringify(sqliteModuleUrl)};
        const conn = openSqliteConnection(${JSON.stringify(dbPath)});
        conn.raw.exec('BEGIN IMMEDIATE');
        conn.raw.prepare(\`
          INSERT INTO tasks (id, title, status, priority, created_at, updated_at, source_agent)
          VALUES (?, 'UNCOMMITTED_MID_FLIGHT', 'todo', 'high', 1700000000000, 1700000000000, 'cli')
        \`).run(${JSON.stringify(tempId)});
        process.on('SIGTERM', () => {
          try { conn.raw.exec('ROLLBACK'); } catch {}
          try { conn.close(); } catch {}
          process.exit(0);
        });
        process.stdout.write('TX_ACTIVE\\n');
        setTimeout(() => {}, 10000);
      `;

      const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      await new Promise<void>((resolveReady, rejectReady) => {
        let stdoutBuf = '';
        let stderrBuf = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          rejectReady(new Error(`Timed out waiting for child TX_ACTIVE. stderr=${stderrBuf}`));
        }, 5000);

        child.stdout?.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString('utf8');
          if (stdoutBuf.includes('TX_ACTIVE')) {
            clearTimeout(timer);
            resolveReady();
          }
        });
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrBuf += chunk.toString('utf8');
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          if (!stdoutBuf.includes('TX_ACTIVE')) {
            rejectReady(new Error(`Child exited early (${code}). stderr=${stderrBuf}`));
          }
        });
      });

      child.kill(signal);
      await new Promise<void>((resolveExit) => {
        child.once('exit', () => resolveExit());
      });
    }

    // 1. Graceful SIGTERM mid-write
    await runInterruptedWrite('SIGTERM', 'midflight-sigterm');
    // 2. Ungraceful SIGKILL crash mid-write (no JS cleanup runs; relies on SQLite WAL recovery)
    await runInterruptedWrite('SIGKILL', 'midflight-sigkill');

    expect(checkSqliteIntegrity(paths.databasePath).ok).toBe(true);
    const verifyStore = openDaymarkStore(paths);
    try {
      const svc = createDaymarkService({ store: verifyStore });
      expect(svc.getTask({ taskId: committedTaskId }).task.title).toBe('Committed baseline task');
      const all = svc.listTasks({});
      expect(all.tasks.some((t) => t.title === 'UNCOMMITTED_MID_FLIGHT')).toBe(false);

      const postRecovery = svc.captureTask({
        title: 'Post-shutdown write succeeds cleanly',
        sourceAgent: 'cli',
      });
      expect(postRecovery.task.status).toBe('todo');
      expect(postRecovery.task.title).toBe('Post-shutdown write succeeds cleanly');
    } finally {
      verifyStore.close();
    }
  });
});
