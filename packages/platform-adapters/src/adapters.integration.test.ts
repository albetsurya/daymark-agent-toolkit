import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDaymarkPaths } from '@daymark/config';
import {
  CaptureTaskOutputSchema,
  DailyReviewOutputSchema,
  FinishFocusOutputSchema,
  GetTaskOutputSchema,
  ListTasksOutputSchema,
  LogWorkOutputSchema,
  StartFocusOutputSchema,
  SystemStatusSchema,
  UpdateTaskOutputSchema,
} from '@daymark/contracts';
import { initializeProfile } from '@daymark/storage-sqlite';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';
import {
  generateAllPlatformPackages,
  resolveBuiltMcpBinPath,
  verifyGeneratedPlatformPackages,
} from './index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function withMcpFromSpec(
  spec: { command: string; args: string[]; env?: Record<string, string> },
  clientName: string,
  fn: (client: Client) => Promise<void>,
) {
  const baseEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) baseEnv[k] = v;
  }
  const transport = new StdioClientTransport({
    command: spec.command,
    args: spec.args,
    env: { ...baseEnv, ...(spec.env ?? {}) },
    stderr: 'pipe',
  });
  const client = new Client({ name: clientName, version: '0.1.0' });
  await client.connect(transport);
  try {
    await fn(client);
  } finally {
    await client.close();
  }
}

describe('@daymark/platform-adapters Tier 1 & Tier 2 matrix', () => {
  it('verifies portable packages contain no secrets/DB files and pass manifest/skill validation', () => {
    const outDir = makeTempDir('daymark-pack-portable-');
    const generated = generateAllPlatformPackages({ outputRoot: outDir, mode: 'portable' });
    expect(generated).toHaveLength(6);

    const results = verifyGeneratedPlatformPackages(outDir);
    for (const r of results) {
      expect(r.valid, `${r.target}: ${r.errors.join('; ')}`).toBe(true);
      expect(r.skillsCount).toBe(3);
    }

    const codexToml = readFileSync(join(outDir, 'codex/config.toml.snippet'), 'utf8');
    expect(codexToml).toContain('[mcp_servers.daymark]');
    expect(codexToml).toContain('command = "daymark-mcp"');
  });

  it('exercises all 5 platforms MCP configs against one shared SQLite DB (cross-agent handoff)', async () => {
    const dbHome = makeTempDir('daymark-shared-home-');
    const outDir = makeTempDir('daymark-pack-local-');
    const paths = resolveDaymarkPaths({ env: { DAYMARK_HOME: dbHome } });
    initializeProfile({ paths, timezone: 'Asia/Jakarta' });

    const mcpBin = resolveBuiltMcpBinPath();
    generateAllPlatformPackages({
      outputRoot: outDir,
      mode: 'local',
      mcpBinPath: mcpBin,
      daymarkHome: dbHome,
      nodeExecutable: process.execPath,
    });

    const verification = verifyGeneratedPlatformPackages(outDir);
    expect(verification.every((v) => v.valid)).toBe(true);

    // Real validator check when Antigravity CLI (`agy`) is installed on host
    let agyAvailable = false;
    try {
      execFileSync('which', ['agy'], { stdio: 'ignore' });
      agyAvailable = true;
    } catch {
      agyAvailable = false;
    }
    if (agyAvailable) {
      const agyOut = execFileSync(
        'agy',
        ['plugin', 'validate', '--strict', '--json', join(outDir, 'antigravity')],
        { encoding: 'utf8' },
      );
      const parsed = JSON.parse(agyOut) as {
        components: { mcpServers: number; skills: number };
        findings: { severity: string }[];
      };
      expect(parsed.components.mcpServers).toBe(1);
      expect(parsed.components.skills).toBe(3);
      expect(
        parsed.findings.filter((f) => f.severity === 'error' || f.severity === 'warning'),
      ).toHaveLength(0);
    }

    // Parse each platform's generated MCP config verbatim
    const claudeCfg = JSON.parse(readFileSync(join(outDir, 'claude-code/.mcp.json'), 'utf8')) as {
      mcpServers: { daymark: { command: string; args: string[]; env?: Record<string, string> } };
    };
    const codexCfg = JSON.parse(readFileSync(join(outDir, 'codex/.mcp.json'), 'utf8')) as {
      mcpServers: { daymark: { command: string; args: string[]; env?: Record<string, string> } };
    };
    const cursorCfg = JSON.parse(
      readFileSync(join(outDir, 'cursor-agent-plugin/mcp.json'), 'utf8'),
    ) as {
      mcpServers: { daymark: { command: string; args: string[]; env?: Record<string, string> } };
    };
    const agyCfg = JSON.parse(
      readFileSync(join(outDir, 'antigravity/mcp_config.json'), 'utf8'),
    ) as {
      mcpServers: { daymark: { command: string; args: string[]; env?: Record<string, string> } };
    };
    const opencodeCfg = JSON.parse(
      readFileSync(join(outDir, 'opencode/opencode.json'), 'utf8'),
    ) as {
      mcp: {
        servers: {
          daymark: {
            type: 'local';
            command: string[];
            environment?: Record<string, string>;
          };
        };
      };
    };

    let sharedTaskId = '';

    // 1. Claude Code captures a task
    await withMcpFromSpec(claudeCfg.mcpServers.daymark, 'claude-code', async (client) => {
      const status = SystemStatusSchema.parse(
        (await client.callTool({ name: 'daymark_get_status', arguments: {} })).structuredContent,
      );
      expect(status.initialized).toBe(true);
      const cap = CaptureTaskOutputSchema.parse(
        (
          await client.callTool({
            name: 'daymark_capture_task',
            arguments: { title: 'Cross-agent handoff task', priority: 'high', estimateMinutes: 45 },
          })
        ).structuredContent,
      );
      sharedTaskId = cap.task.id;
      expect(cap.task.sourceAgent).toBe('claude-code');
    });

    // 2. Cursor reads the task and moves it to in_progress
    await withMcpFromSpec(cursorCfg.mcpServers.daymark, 'cursor', async (client) => {
      const list = ListTasksOutputSchema.parse(
        (await client.callTool({ name: 'daymark_list_tasks', arguments: {} })).structuredContent,
      );
      expect(list.tasks.some((t) => t.id === sharedTaskId)).toBe(true);
      const upd = UpdateTaskOutputSchema.parse(
        (
          await client.callTool({
            name: 'daymark_update_task',
            arguments: { taskId: sharedTaskId, status: 'in_progress' },
          })
        ).structuredContent,
      );
      expect(upd.task.status).toBe('in_progress');
    });

    // 3. Codex reads updated state and logs work
    await withMcpFromSpec(codexCfg.mcpServers.daymark, 'codex', async (client) => {
      const got = GetTaskOutputSchema.parse(
        (
          await client.callTool({
            name: 'daymark_get_task',
            arguments: { taskId: sharedTaskId },
          })
        ).structuredContent,
      );
      expect(got.task.status).toBe('in_progress');
      const logged = LogWorkOutputSchema.parse(
        (
          await client.callTool({
            name: 'daymark_log_work',
            arguments: {
              summary: 'Reviewed architecture in Codex',
              taskId: sharedTaskId,
              durationMinutes: 20,
            },
          })
        ).structuredContent,
      );
      expect(logged.entry.sourceAgent).toBe('codex');
    });

    // 4. Antigravity starts and finishes a focus session on the same task
    await withMcpFromSpec(agyCfg.mcpServers.daymark, 'antigravity', async (client) => {
      const started = StartFocusOutputSchema.parse(
        (
          await client.callTool({
            name: 'daymark_start_focus',
            arguments: { taskId: sharedTaskId, note: 'Antigravity focus block' },
          })
        ).structuredContent,
      );
      expect(started.session.sourceAgent).toBe('antigravity');
      const finished = FinishFocusOutputSchema.parse(
        (
          await client.callTool({
            name: 'daymark_finish_focus',
            arguments: { createWorklog: true },
          })
        ).structuredContent,
      );
      expect(finished.session.status).toBe('completed');
    });

    // 5. OpenCode generates a daily review seeing all cross-agent activity
    const [ocCmd, ...ocArgs] = opencodeCfg.mcp.servers.daymark.command;
    expect(ocCmd).toBeDefined();
    await withMcpFromSpec(
      {
        command: ocCmd ?? 'node',
        args: ocArgs,
        env: opencodeCfg.mcp.servers.daymark.environment,
      },
      'opencode',
      async (client) => {
        const review = DailyReviewOutputSchema.parse(
          (await client.callTool({ name: 'daymark_generate_daily_review', arguments: {} }))
            .structuredContent,
        );
        expect(review.inProgressTasks.some((t) => t.id === sharedTaskId)).toBe(true);
        expect(review.worklogEntries.length).toBeGreaterThanOrEqual(2);
        expect(review.focusSessions.length).toBe(1);
      },
    );

    // 6. Uninitialized profile returns actionable error rather than corrupting or deleting DB
    const uninitHome = makeTempDir('daymark-uninit-');
    await withMcpFromSpec(
      { command: process.execPath, args: [mcpBin], env: { DAYMARK_HOME: uninitHome } },
      'uninit-client',
      async (client) => {
        const res = await client.callTool({ name: 'daymark_list_tasks', arguments: {} });
        expect(res.isError).toBe(true);
        const payload = JSON.parse((res.content[0] as { text: string }).text) as {
          error: { code: string; nextStep: string | null };
        };
        expect(payload.error.code).toBe('PROFILE_NOT_INITIALIZED');
        expect(payload.error.nextStep).toContain('daymark init');
        expect(existsSync(join(uninitHome, 'daymark.sqlite'))).toBe(false);
      },
    );
  });
});
