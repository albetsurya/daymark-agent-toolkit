import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDaymarkCli } from '@daymark/cli';
import { resolveDaymarkPaths } from '@daymark/config';
import {
  CaptureTaskOutputSchema,
  CreateProjectOutputSchema,
  DailyReviewOutputSchema,
  FinishFocusOutputSchema,
  GetTodayPlanOutputSchema,
  ListFocusSessionsOutputSchema,
  ListProjectsOutputSchema,
  ListTasksOutputSchema,
  ListWorklogOutputSchema,
  SystemStatusSchema,
  WeeklyReviewOutputSchema,
} from '@daymark/contracts';
import { startDaymarkHttpServer } from '@daymark/mcp-server';
import { initializeProfile } from '@daymark/storage-sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaymarkWebServer } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const stdioMcpEntry = resolve(here, '../../../../packages/mcp-server/dist/bin.mjs');

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daymark-web-int-'));
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

describe('@daymark/web local dashboard server integration', () => {
  it('refuses non-loopback host binding', async () => {
    const homeDir = makeTempHome();
    await expect(
      startDaymarkWebServer({
        host: '0.0.0.0',
        port: 0,
        env: { ...process.env, DAYMARK_HOME: homeDir },
      }),
    ).rejects.toThrow(/loopback/i);
  });

  it('enforces origin validation, CSRF protection, path redaction, serves SPA, and shares SQLite with CLI', async () => {
    const homeDir = makeTempHome();
    const paths = resolveDaymarkPaths({ env: { DAYMARK_HOME: homeDir } });

    const web = await startDaymarkWebServer({
      host: '127.0.0.1',
      port: 0,
      env: { ...process.env, DAYMARK_HOME: homeDir, DAYMARK_LOG_LEVEL: 'silent' },
    });

    try {
      expect(web.host).toBe('127.0.0.1');

      // 1. Serves built React SPA HTML with security headers
      const htmlRes = await fetch(`${web.url}/`);
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get('x-frame-options')).toBe('DENY');
      expect(htmlRes.headers.get('x-content-type-options')).toBe('nosniff');
      const html = await htmlRes.text();
      expect(html).toContain('Daymark');

      // 2. Uninitialized status does NOT create database and redacts dataDir
      const preStatusRes = await fetch(`${web.url}/api/status`);
      expect(preStatusRes.status).toBe(200);
      const preStatusJson = (await preStatusRes.json()) as { ok: true; data: unknown };
      const preStatus = SystemStatusSchema.parse(preStatusJson.data);
      expect(preStatus.initialized).toBe(false);
      expect(preStatus.dataDir).toBeNull();
      expect(existsSync(paths.databasePath)).toBe(false);

      // 3. Disallowed Origin and cross-site Sec-Fetch-Site are rejected with 403
      const evilOriginRes = await fetch(`${web.url}/api/status`, {
        headers: { origin: 'https://evil.example.com' },
      });
      expect(evilOriginRes.status).toBe(403);

      const crossSiteRes = await fetch(`${web.url}/api/status`, {
        headers: { 'sec-fetch-site': 'cross-site' },
      });
      expect(crossSiteRes.status).toBe(403);

      // 4. Obtain CSRF cookie + token from GET /api/csrf
      const csrfRes = await fetch(`${web.url}/api/csrf`);
      expect(csrfRes.status).toBe(200);
      const setCookie = csrfRes.headers.get('set-cookie');
      expect(setCookie).toContain('daymark_csrf_sid=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('SameSite=Strict');
      const cookiePair = setCookie?.split(';')[0] ?? '';
      const csrfToken = ((await csrfRes.json()) as { ok: true; data: { csrfToken: string } }).data
        .csrfToken;

      // Mutating requests fail without Origin, without CSRF token, or with wrong CSRF token
      const noOriginPost = await fetch(`${web.url}/api/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookiePair,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ name: 'Should fail' }),
      });
      expect(noOriginPost.status).toBe(403);

      const badCsrfPost = await fetch(`${web.url}/api/projects`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: web.url,
          cookie: cookiePair,
          'x-csrf-token': 'wrong-token',
        },
        body: JSON.stringify({ name: 'Should fail' }),
      });
      expect(badCsrfPost.status).toBe(403);

      const postWithCsrf = async (path: string, body: unknown, method: 'POST' | 'PATCH' = 'POST') =>
        fetch(`${web.url}${path}`, {
          method,
          headers: {
            'content-type': 'application/json',
            origin: web.url,
            cookie: cookiePair,
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify(body),
        });

      // 5. Explicit profile initialization via POST /api/init
      const initRes = await postWithCsrf('/api/init', { timezone: 'Asia/Jakarta' });
      expect(initRes.status).toBe(200);

      // 6. Full workflow: Projects -> Tasks -> Planner -> Focus -> Worklog -> Reviews
      const projRes = await postWithCsrf('/api/projects', {
        name: 'Web Dashboard Project',
        description: 'Local HTTP API test',
      });
      expect(projRes.status).toBe(201);
      const projId = ((await projRes.json()) as { data: { project: { id: string } } }).data.project
        .id;

      const listProj = ListProjectsOutputSchema.parse(
        ((await (await fetch(`${web.url}/api/projects`)).json()) as { data: unknown }).data,
      );
      expect(listProj.projects).toHaveLength(1);

      const taskRes = await postWithCsrf('/api/tasks', {
        title: 'Review local dashboard CSRF flow',
        projectId: projId,
        priority: 'high',
        estimateMinutes: 30,
        dueAt: '2026-11-26',
        tags: ['web', 'security'],
      });
      expect(taskRes.status).toBe(201);
      const taskData = (
        (await taskRes.json()) as { data: { task: { id: string; sourceAgent: string } } }
      ).data.task;
      expect(taskData.sourceAgent).toBe('web');

      // CLI reads the task created by the web dashboard in the exact same SQLite DB
      const cliShow = await execCli(['task', 'show', taskData.id, '--json'], homeDir);
      expect(cliShow.code).toBe(0);
      expect(JSON.parse(cliShow.stdout).data.task.title).toBe('Review local dashboard CSRF flow');

      // CLI creates a second task -> web dashboard sees it immediately
      const cliAdd = await execCli(
        ['task', 'add', 'CLI-added unestimated task', '--project', projId, '--json'],
        homeDir,
      );
      expect(cliAdd.code).toBe(0);

      const tasksList = ListTasksOutputSchema.parse(
        ((await (await fetch(`${web.url}/api/tasks`)).json()) as { data: unknown }).data,
      );
      expect(tasksList.tasks).toHaveLength(2);

      // Daily plan separates estimated vs unestimated
      const planRes = await fetch(`${web.url}/api/plan/today?date=2026-11-26&availableMinutes=60`);
      expect(planRes.status).toBe(200);
      const plan = GetTodayPlanOutputSchema.parse(
        ((await planRes.json()) as { data: unknown }).data,
      );
      expect(plan.plannedTasks).toHaveLength(1);
      expect(plan.unscheduledMissingEstimate).toHaveLength(1);

      // Start focus + reject duplicate focus with 409 + finish focus with worklog
      const focusStart = await postWithCsrf('/api/focus/start', {
        taskId: taskData.id,
        note: 'Web focus block',
      });
      expect(focusStart.status).toBe(201);

      const dupFocus = await postWithCsrf('/api/focus/start', { note: 'Duplicate' });
      expect(dupFocus.status).toBe(409);

      const focusFinish = await postWithCsrf('/api/focus/finish', {
        status: 'completed',
        createWorklog: true,
      });
      expect(focusFinish.status).toBe(200);

      const focusHist = ListFocusSessionsOutputSchema.parse(
        ((await (await fetch(`${web.url}/api/focus`)).json()) as { data: unknown }).data,
      );
      expect(focusHist.sessions).toHaveLength(1);

      // Log explicit worklog & complete task
      const wlAdd = await postWithCsrf('/api/worklogs', {
        summary: 'Verified web dashboard API',
        durationMinutes: 15,
        taskId: taskData.id,
      });
      expect(wlAdd.status).toBe(201);

      const wlList = ListWorklogOutputSchema.parse(
        (
          (await (await fetch(`${web.url}/api/worklogs?from=2020-01-01&to=2035-01-01`)).json()) as {
            data: unknown;
          }
        ).data,
      );
      expect(wlList.totalEntries).toBe(2);

      const completeRes = await postWithCsrf(`/api/tasks/${taskData.id}/complete`, {
        completionNote: 'Done via dashboard',
      });
      expect(completeRes.status).toBe(200);

      // Daily & Weekly reviews
      const daily = DailyReviewOutputSchema.parse(
        ((await (await fetch(`${web.url}/api/reviews/daily`)).json()) as { data: unknown }).data,
      );
      expect(daily.completedTasks).toHaveLength(1);

      const weekly = WeeklyReviewOutputSchema.parse(
        ((await (await fetch(`${web.url}/api/reviews/weekly`)).json()) as { data: unknown }).data,
      );
      expect(weekly.dailyTotals).toHaveLength(7);

      // Unknown API routes & DB paths never expose SQLite
      const missingApi = await fetch(`${web.url}/api/sqlite`);
      expect(missingApi.status).toBe(404);
      const dbStaticAttempt = await fetch(`${web.url}/daymark.sqlite`);
      expect(dbStaticAttempt.status).toBe(404);
    } finally {
      await web.close();
    }
  });

  it('shares one SQLite database and core business rules seamlessly across STDIO MCP, Local Web Dashboard, and Remote Streamable HTTP MCP', async () => {
    const homeDir = makeTempHome();
    const paths = resolveDaymarkPaths({ env: { DAYMARK_HOME: homeDir } });
    initializeProfile({ paths, timezone: 'Asia/Jakarta' });

    const remoteToken = 'tri-surface-remote-token-99999';
    const web = await startDaymarkWebServer({
      host: '127.0.0.1',
      port: 0,
      env: { ...process.env, DAYMARK_HOME: homeDir, DAYMARK_LOG_LEVEL: 'silent' },
    });
    const remoteMcp = await startDaymarkHttpServer({
      host: '127.0.0.1',
      port: 0,
      env: { ...process.env, DAYMARK_HOME: homeDir, DAYMARK_LOG_LEVEL: 'silent' },
      bearerTokens: [
        {
          token: remoteToken,
          principalId: 'claude-web-owner',
          scopes: ['read', 'write'],
          source: 'claude-web',
        },
      ],
    });

    const stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [stdioMcpEntry],
      env: { ...process.env, DAYMARK_HOME: homeDir },
      stderr: 'pipe',
    });
    const stdioClient = new Client({ name: 'claude-code-local', version: '1.0.0' });
    await stdioClient.connect(stdioTransport);

    const remoteTransport = new StreamableHTTPClientTransport(new URL(remoteMcp.mcpUrl), {
      authProvider: { token: async () => remoteToken },
    });
    const remoteClient = new Client({ name: 'claude-web', version: '1.0.0' });
    await remoteClient.connect(remoteTransport);

    try {
      // 1. Interface 1 (Local STDIO MCP) creates a project & captures a task
      const proj = CreateProjectOutputSchema.parse(
        (
          await stdioClient.callTool({
            name: 'daymark_create_project',
            arguments: { name: 'Shared Core Tri-Surface' },
          })
        ).structuredContent,
      );
      const cap = CaptureTaskOutputSchema.parse(
        (
          await stdioClient.callTool({
            name: 'daymark_capture_task',
            arguments: {
              title: 'Verify shared core across 3 surfaces',
              projectId: proj.project.id,
              priority: 'high',
              estimateMinutes: 45,
            },
          })
        ).structuredContent,
      );
      expect(cap.task.sourceAgent).toBe('claude-code');

      // 2. Interface 2 (Local Web Dashboard HTTP API) plans it and starts a focus session
      const csrfRes = await fetch(`${web.url}/api/csrf`);
      const cookiePair = csrfRes.headers.get('set-cookie')?.split(';')[0] ?? '';
      const csrfToken = ((await csrfRes.json()) as { data: { csrfToken: string } }).data.csrfToken;

      const plan = GetTodayPlanOutputSchema.parse(
        (
          (await (await fetch(`${web.url}/api/plan/today?availableMinutes=60`)).json()) as {
            data: unknown;
          }
        ).data,
      );
      expect(plan.plannedTasks[0]?.task.id).toBe(cap.task.id);

      const startFocusRes = await fetch(`${web.url}/api/focus/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: web.url,
          cookie: cookiePair,
          'x-csrf-token': csrfToken,
        },
        body: JSON.stringify({ taskId: cap.task.id, note: 'Cross-surface focus' }),
      });
      expect(startFocusRes.status).toBe(201);

      // 3. Interface 3 (Remote Streamable HTTP MCP) finishes the active focus session, logs work, and reviews it
      const finished = FinishFocusOutputSchema.parse(
        (
          await remoteClient.callTool({
            name: 'daymark_finish_focus',
            arguments: { createWorklog: true },
          })
        ).structuredContent,
      );
      expect(finished.session.status).toBe('completed');
      expect(finished.worklogEntry).not.toBeNull();

      const review = DailyReviewOutputSchema.parse(
        (
          await remoteClient.callTool({
            name: 'daymark_generate_daily_review',
            arguments: {},
          })
        ).structuredContent,
      );
      expect(review.focusSessions).toHaveLength(1);
      expect(review.worklogEntries.length).toBeGreaterThanOrEqual(1);
    } finally {
      await remoteClient.close();
      await stdioClient.close();
      await remoteMcp.close();
      await web.close();
    }
  });
});
