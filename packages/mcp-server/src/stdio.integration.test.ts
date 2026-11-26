import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDaymarkCli } from '@daymark/cli';
import { resolveDaymarkPaths } from '@daymark/config';
import {
  CaptureTaskOutputSchema,
  CompleteTaskOutputSchema,
  CreateProjectOutputSchema,
  DailyReviewOutputSchema,
  FinishFocusOutputSchema,
  GetTaskOutputSchema,
  GetTodayPlanOutputSchema,
  ListProjectsOutputSchema,
  ListTasksOutputSchema,
  ListWorklogOutputSchema,
  LogWorkOutputSchema,
  StartFocusOutputSchema,
  SystemStatusSchema,
  UpdateProjectOutputSchema,
  UpdateTaskOutputSchema,
  WeeklyReviewOutputSchema,
} from '@daymark/contracts';
import { initializeProfile } from '@daymark/storage-sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const serverEntry = resolve(here, '../dist/bin.mjs');
const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daymark-mcp-int-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

const EXPECTED_16_TOOLS = [
  'daymark_get_status',
  'daymark_list_projects',
  'daymark_list_tasks',
  'daymark_get_task',
  'daymark_get_today_plan',
  'daymark_list_worklog',
  'daymark_create_project',
  'daymark_update_project',
  'daymark_capture_task',
  'daymark_update_task',
  'daymark_start_focus',
  'daymark_finish_focus',
  'daymark_log_work',
  'daymark_complete_task',
  'daymark_generate_daily_review',
  'daymark_generate_weekly_review',
];

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

describe('@daymark/mcp-server Phase 3 full integration', () => {
  it('exposes all 16 tools, validates inputs, handles errors safely, and shares state seamlessly with CLI', async () => {
    const homeDir = makeTempHome();
    const paths = resolveDaymarkPaths({ env: { DAYMARK_HOME: homeDir } });
    initializeProfile({ paths, timezone: 'Asia/Jakarta' });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntry],
      env: { ...process.env, DAYMARK_HOME: homeDir },
      stderr: 'pipe',
    });

    const stderrChunks: string[] = [];
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk.toString('utf8'));
    });

    const client = new Client({ name: 'claude-code-test-client', version: '1.0.0' });
    await client.connect(transport);

    try {
      // 1. Verify all 16 contract tools exist
      const listTools = await client.listTools();
      const toolNames = listTools.tools.map((t) => t.name).sort();
      expect(toolNames).toEqual([...EXPECTED_16_TOOLS].sort());

      // 2. Status tool
      const statusRes = await client.callTool({ name: 'daymark_get_status', arguments: {} });
      const status = SystemStatusSchema.parse(statusRes.structuredContent);
      expect(status.initialized).toBe(true);
      expect(status.timezone).toBe('Asia/Jakarta');

      // 3. Create & update project
      const createProjRes = await client.callTool({
        name: 'daymark_create_project',
        arguments: { name: 'MCP Integration', description: 'Cross-agent project' },
      });
      const createdProj = CreateProjectOutputSchema.parse(createProjRes.structuredContent);

      const updateProjRes = await client.callTool({
        name: 'daymark_update_project',
        arguments: { projectId: createdProj.project.id, description: 'Updated desc' },
      });
      const updatedProj = UpdateProjectOutputSchema.parse(updateProjRes.structuredContent);
      expect(updatedProj.project.description).toBe('Updated desc');

      const listProjRes = await client.callTool({
        name: 'daymark_list_projects',
        arguments: { status: 'active' },
      });
      expect(ListProjectsOutputSchema.parse(listProjRes.structuredContent).projects).toHaveLength(
        1,
      );

      // 4. Capture task with idempotency + verify MCP -> CLI parity
      const cap1Res = await client.callTool({
        name: 'daymark_capture_task',
        arguments: {
          title: 'Test cross-agent handoff',
          projectId: createdProj.project.id,
          priority: 'high',
          estimateMinutes: 30,
          dueAt: '2026-11-26',
          idempotencyKey: 'mcp-cap-1',
        },
      });
      const cap1 = CaptureTaskOutputSchema.parse(cap1Res.structuredContent);
      expect(cap1.deduplicated).toBe(false);
      expect(cap1.task.sourceAgent).toBe('claude-code');

      const cap2Res = await client.callTool({
        name: 'daymark_capture_task',
        arguments: { title: 'Test cross-agent handoff', idempotencyKey: 'mcp-cap-1' },
      });
      const cap2 = CaptureTaskOutputSchema.parse(cap2Res.structuredContent);
      expect(cap2.deduplicated).toBe(true);
      expect(cap2.task.id).toBe(cap1.task.id);

      // Verify CLI sees the task created over MCP!
      const cliShow = await execCli(['task', 'show', cap1.task.id, '--json'], homeDir);
      expect(cliShow.code).toBe(0);
      expect(JSON.parse(cliShow.stdout).data.task.title).toBe('Test cross-agent handoff');

      // Write via CLI, then read via MCP (pagination test too!)
      const cliAdd1 = await execCli(
        ['task', 'add', 'Created in CLI 1', '--priority', 'medium', '--estimate', '20', '--json'],
        homeDir,
      );
      const cliAdd2 = await execCli(
        ['task', 'add', 'Created in CLI 2', '--priority', 'low', '--estimate', '15', '--json'],
        homeDir,
      );
      expect(cliAdd1.code).toBe(0);
      expect(cliAdd2.code).toBe(0);

      const page1Res = await client.callTool({
        name: 'daymark_list_tasks',
        arguments: { limit: 2 },
      });
      const page1 = ListTasksOutputSchema.parse(page1Res.structuredContent);
      expect(page1.tasks).toHaveLength(2);
      expect(page1.nextCursor).not.toBeNull();

      const page2Res = await client.callTool({
        name: 'daymark_list_tasks',
        arguments: { limit: 2, cursor: page1.nextCursor ?? undefined },
      });
      const page2 = ListTasksOutputSchema.parse(page2Res.structuredContent);
      expect(page2.tasks).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();

      const getTaskRes = await client.callTool({
        name: 'daymark_get_task',
        arguments: { taskId: cap1.task.id },
      });
      expect(GetTaskOutputSchema.parse(getTaskRes.structuredContent).projectName).toBe(
        'MCP Integration',
      );

      // 5. Update task + Plan today
      const updTaskRes = await client.callTool({
        name: 'daymark_update_task',
        arguments: { taskId: cap1.task.id, status: 'in_progress' },
      });
      expect(UpdateTaskOutputSchema.parse(updTaskRes.structuredContent).task.status).toBe(
        'in_progress',
      );

      const planRes = await client.callTool({
        name: 'daymark_get_today_plan',
        arguments: { date: '2026-11-26', availableMinutes: 50 },
      });
      const plan = GetTodayPlanOutputSchema.parse(planRes.structuredContent);
      expect(plan.plannedTasks.length).toBeGreaterThanOrEqual(1);

      // 6. Focus start, active conflict error, finish with worklog
      const focusStartRes = await client.callTool({
        name: 'daymark_start_focus',
        arguments: { taskId: cap1.task.id, note: 'Deep work block' },
      });
      expect(StartFocusOutputSchema.parse(focusStartRes.structuredContent).session.status).toBe(
        'active',
      );

      const conflictRes = await client.callTool({
        name: 'daymark_start_focus',
        arguments: { note: 'Second focus' },
      });
      expect(conflictRes.isError).toBe(true);
      const conflictText = (conflictRes.content[0] as { text: string }).text;
      expect(JSON.parse(conflictText).error.code).toBe('FOCUS_SESSION_ALREADY_ACTIVE');
      // Must never leak stack traces or DB paths
      expect(conflictText).not.toContain(homeDir);

      const focusFinishRes = await client.callTool({
        name: 'daymark_finish_focus',
        arguments: { createWorklog: true },
      });
      const finished = FinishFocusOutputSchema.parse(focusFinishRes.structuredContent);
      expect(finished.session.status).toBe('completed');
      expect(finished.worklogEntry).not.toBeNull();

      // 7. Log work + idempotency + list worklog + complete task
      const log1Res = await client.callTool({
        name: 'daymark_log_work',
        arguments: {
          summary: 'Verified MCP stdio protocol frames',
          durationMinutes: 20,
          taskId: cap1.task.id,
          idempotencyKey: 'wl-1',
        },
      });
      expect(LogWorkOutputSchema.parse(log1Res.structuredContent).deduplicated).toBe(false);

      const log2Res = await client.callTool({
        name: 'daymark_log_work',
        arguments: { summary: 'Verified MCP stdio protocol frames', idempotencyKey: 'wl-1' },
      });
      expect(LogWorkOutputSchema.parse(log2Res.structuredContent).deduplicated).toBe(true);

      const workListRes = await client.callTool({
        name: 'daymark_list_worklog',
        arguments: { from: '2020-01-01', to: '2035-01-01' },
      });
      expect(ListWorklogOutputSchema.parse(workListRes.structuredContent).totalEntries).toBe(2);

      const completeRes = await client.callTool({
        name: 'daymark_complete_task',
        arguments: { taskId: cap1.task.id, completionNote: 'Shipped MCP suite' },
      });
      const completed = CompleteTaskOutputSchema.parse(completeRes.structuredContent);
      expect(completed.task.status).toBe('completed');
      expect(completed.worklogEntry?.summary).toBe('Shipped MCP suite');

      // 8. Daily & Weekly Reviews
      const dailyRes = await client.callTool({
        name: 'daymark_generate_daily_review',
        arguments: {},
      });
      expect(DailyReviewOutputSchema.parse(dailyRes.structuredContent).completedTasks).toHaveLength(
        1,
      );

      const weeklyRes = await client.callTool({
        name: 'daymark_generate_weekly_review',
        arguments: {},
      });
      expect(WeeklyReviewOutputSchema.parse(weeklyRes.structuredContent).dailyTotals).toHaveLength(
        7,
      );

      // 9. Validation error returns bounded isError result without throwing unhandled exception
      const invalidRes = await client.callTool({
        name: 'daymark_capture_task',
        arguments: { title: '   ' },
      });
      expect(invalidRes.isError).toBe(true);
      expect((invalidRes.content[0] as { text: string }).text).toMatch(/validation/i);

      // Domain error (not found) returns isError=true without DB paths
      const notFoundRes = await client.callTool({
        name: 'daymark_get_task',
        arguments: { taskId: '99999999-9999-4000-8000-999999999999' },
      });
      expect(notFoundRes.isError).toBe(true);
      expect(JSON.parse((notFoundRes.content[0] as { text: string }).text).error.code).toBe(
        'TASK_NOT_FOUND',
      );
    } finally {
      await client.close();
    }

    // No stdout/stderr noise emitted by default
    expect(stderrChunks.join('')).toBe('');

    // Verify clean exit on stdin EOF with zero stdout/stderr noise
    await new Promise<void>((resolveExit, rejectExit) => {
      const child = spawn(process.execPath, [serverEntry], {
        env: { ...process.env, DAYMARK_HOME: homeDir },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdoutData = '';
      let stderrData = '';
      child.stdout.on('data', (d: Buffer) => {
        stdoutData += d.toString('utf8');
      });
      child.stderr.on('data', (d: Buffer) => {
        stderrData += d.toString('utf8');
      });
      child.on('error', rejectExit);
      child.on('exit', (code) => {
        try {
          expect(code).toBe(0);
          expect(stdoutData).toBe('');
          expect(stderrData).toBe('');
          resolveExit();
        } catch (e) {
          rejectExit(e);
        }
      });
      child.stdin.end();
    });
  });
});
