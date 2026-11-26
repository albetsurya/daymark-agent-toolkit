import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runDaymarkCli } from './index.js';

const tempDirs: string[] = [];
const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, '../dist/bin.mjs');

function makeHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daymark-cli-e2e-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function execCli(args: string[], homeDir: string) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDaymarkCli(['node', 'daymark', ...args], {
    env: { ...process.env, DAYMARK_HOME: homeDir },
    stdout: (s) => out.push(s),
    stderr: (s) => err.push(s),
  });
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('@daymark/cli end-to-end workflow', () => {
  it('completes init, project, task, plan, focus, worklog, review, and backup restore into a second profile', async () => {
    const home1 = makeHome();
    const home2 = makeHome();

    // 1. Uninitialized status fails cleanly without creating DB, init creates profile
    const preStatus = await execCli(['status', '--json'], home1);
    expect(preStatus.code).toBe(0);
    expect(JSON.parse(preStatus.stdout).data.initialized).toBe(false);

    const init = await execCli(['init', '--timezone', 'Asia/Jakarta', '--json'], home1);
    expect(init.code).toBe(0);
    expect(JSON.parse(init.stdout).data.settings.timezone).toBe('Asia/Jakarta');

    // Human-readable output smoke check
    const humanStatus = await execCli(['status'], home1);
    expect(humanStatus.code).toBe(0);
    expect(humanStatus.stdout).toContain('Initialized:   yes');

    const doctor = await execCli(['doctor', '--json'], home1);
    expect(doctor.code).toBe(0);
    expect(JSON.parse(doctor.stdout).data.initialized).toBe(true);

    // 2. Add project & tasks
    const proj = await execCli(['project', 'add', 'Daymark MVP', '--json'], home1);
    expect(proj.code).toBe(0);
    const projectId = JSON.parse(proj.stdout).data.project.id as string;

    const t1 = await execCli(
      [
        'task',
        'add',
        'Build CLI end-to-end suite',
        '--project',
        projectId,
        '--priority',
        'high',
        '--estimate',
        '45',
        '--due',
        '2026-11-26',
        '--tag',
        'cli',
        'mvp',
        '--json',
      ],
      home1,
    );
    expect(t1.code).toBe(0);
    const taskId = JSON.parse(t1.stdout).data.task.id as string;

    const t2 = await execCli(['task', 'add', 'Unestimated backlog task', '--json'], home1);
    expect(t2.code).toBe(0);

    // 3. Daily plan
    const plan = await execCli(
      ['plan', 'today', '--date', '2026-11-26', '--available-minutes', '90', '--json'],
      home1,
    );
    expect(plan.code).toBe(0);
    const planData = JSON.parse(plan.stdout).data;
    expect(planData.plannedTasks).toHaveLength(1);
    expect(planData.unscheduledMissingEstimate).toHaveLength(1);

    // 4. Focus start/stop + worklog + task done
    const startFocus = await execCli(['focus', 'start', '--task', taskId, '--json'], home1);
    expect(startFocus.code).toBe(0);

    const dupFocus = await execCli(['focus', 'start', '--json'], home1);
    expect(dupFocus.code).toBe(1);
    expect(JSON.parse(dupFocus.stderr).error.code).toBe('FOCUS_SESSION_ALREADY_ACTIVE');

    const stopFocus = await execCli(
      ['focus', 'stop', '--worklog', '--note', 'Implemented CLI commands', '--json'],
      home1,
    );
    expect(stopFocus.code).toBe(0);
    expect(JSON.parse(stopFocus.stdout).data.worklogEntry.summary).toBe('Implemented CLI commands');

    const workAdd = await execCli(
      [
        'worklog',
        'add',
        'Reviewed error codes',
        '--duration',
        '15',
        '--project',
        projectId,
        '--json',
      ],
      home1,
    );
    expect(workAdd.code).toBe(0);

    const done = await execCli(
      ['task', 'done', taskId, '--note', 'All CLI checks green', '--json'],
      home1,
    );
    expect(done.code).toBe(0);
    expect(JSON.parse(done.stdout).data.task.status).toBe('completed');

    // 5. Daily & weekly reviews
    const dayReview = await execCli(['review', 'day', '--json'], home1);
    expect(dayReview.code).toBe(0);
    expect(JSON.parse(dayReview.stdout).data.worklogEntries.length).toBeGreaterThanOrEqual(2);

    const weekReview = await execCli(['review', 'week', '--json'], home1);
    expect(weekReview.code).toBe(0);
    expect(JSON.parse(weekReview.stdout).data.dailyTotals).toHaveLength(7);

    // 6. Export and dry-run/replace import into second temporary profile
    const backupFile = join(home1, 'backup.json');
    const exp = await execCli(['export', backupFile, '--json'], home1);
    expect(exp.code).toBe(0);
    expect(existsSync(backupFile)).toBe(true);

    await execCli(['init', '--timezone', 'UTC', '--json'], home2);
    const dryRun = await execCli(
      ['import', backupFile, '--dry-run', '--mode', 'replace', '--json'],
      home2,
    );
    expect(dryRun.code).toBe(0);
    expect(JSON.parse(dryRun.stdout).data.valid).toBe(true);

    // Refuses replace without --confirm
    const unconfirmed = await execCli(['import', backupFile, '--mode', 'replace', '--json'], home2);
    expect(unconfirmed.code).toBe(1);
    expect(JSON.parse(unconfirmed.stderr).error.code).toBe('CONFIRMATION_REQUIRED');

    const confirmed = await execCli(
      ['import', backupFile, '--mode', 'replace', '--confirm', '--json'],
      home2,
    );
    expect(confirmed.code).toBe(0);

    const restoredTask = await execCli(['task', 'show', taskId, '--json'], home2);
    expect(restoredTask.code).toBe(0);
    expect(JSON.parse(restoredTask.stdout).data.task.title).toBe('Build CLI end-to-end suite');

    // 7. Built binary smoke check & cold-start timing
    const tStart = Date.now();
    const rawOut = execFileSync(process.execPath, [binPath, 'status', '--json'], {
      env: { ...process.env, DAYMARK_HOME: home2 },
      encoding: 'utf8',
    });
    const elapsedMs = Date.now() - tStart;
    expect(JSON.parse(rawOut).data.initialized).toBe(true);
    expect(elapsedMs).toBeLessThan(2000);
  });
});
