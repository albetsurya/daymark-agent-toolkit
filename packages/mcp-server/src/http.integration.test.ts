import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDaymarkCli } from '@daymark/cli';
import { resolveDaymarkPaths } from '@daymark/config';
import {
  CaptureTaskOutputSchema,
  CreateProjectOutputSchema,
  DailyReviewOutputSchema,
  FinishFocusOutputSchema,
  ListTasksOutputSchema,
  StartFocusOutputSchema,
  SystemStatusSchema,
  UpdateTaskOutputSchema,
} from '@daymark/contracts';
import { initializeProfile } from '@daymark/storage-sqlite';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import { startDaymarkHttpServer } from './http.js';

const tempDirs: string[] = [];

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'daymark-mcp-http-'));
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

describe('@daymark/mcp-server Remote Streamable HTTP integration', () => {
  it('serves all 16 tools on /mcp via Streamable HTTP, shares SQLite with CLI, redacts paths, and enforces auth + permission policies', async () => {
    const homeDir = makeTempHome();
    const paths = resolveDaymarkPaths({ env: { DAYMARK_HOME: homeDir } });
    initializeProfile({ paths, timezone: 'Asia/Jakarta' });

    const rwToken = 'daymark-test-rw-secret-token-12345';
    const roToken = 'daymark-test-ro-secret-token-67890';

    const server = await startDaymarkHttpServer({
      host: '127.0.0.1',
      port: 0,
      env: { ...process.env, DAYMARK_HOME: homeDir, DAYMARK_LOG_LEVEL: 'silent' },
      bearerTokens: [
        {
          token: rwToken,
          principalId: 'claude-web-owner',
          scopes: ['read', 'write'],
          source: 'claude-web',
        },
        {
          token: roToken,
          principalId: 'claude-web-reader',
          scopes: ['read'],
          source: 'claude-web',
        },
      ],
      allowedHosts: ['daymark-tunnel.example.com'],
      allowedOrigins: ['https://claude.ai'],
      rateLimit: { windowMs: 60_000, maxRequests: 50 },
    });

    try {
      // 1. Health endpoint reports safe metadata without DB paths
      const healthRes = await fetch(`${server.url}/healthz`);
      expect(healthRes.status).toBe(200);
      const healthBody = (await healthRes.json()) as Record<string, unknown>;
      expect(healthBody.ok).toBe(true);
      expect(healthBody.transport).toBe('streamable-http');
      expect(JSON.stringify(healthBody)).not.toContain(homeDir);

      // 2. Non-MCP / DB paths are never exposed
      for (const forbiddenPath of ['/db', '/sqlite', '/backup', '/export', '/']) {
        const res = await fetch(`${server.url}${forbiddenPath}`, {
          headers: { authorization: `Bearer ${rwToken}` },
        });
        expect(res.status).toBe(404);
      }

      // 3. Unauthenticated or invalid token requests fail with 401 + WWW-Authenticate
      const noAuthRes = await fetch(server.mcpUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(noAuthRes.status).toBe(401);
      expect(noAuthRes.headers.get('www-authenticate')).toContain('Bearer');

      const badAuthRes = await fetch(server.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer wrong-token',
        },
        body: '{}',
      });
      expect(badAuthRes.status).toBe(401);

      // 4. Disallowed Origin rejected with 403; disallowed Content-Type rejected with 415
      const badOriginRes = await fetch(server.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${rwToken}`,
          origin: 'https://evil.example.net',
        },
        body: '{}',
      });
      expect(badOriginRes.status).toBe(403);

      const badMimeRes = await fetch(server.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'text/plain',
          authorization: `Bearer ${rwToken}`,
          origin: 'https://claude.ai',
        },
        body: 'not-json',
      });
      expect(badMimeRes.status).toBe(415);

      // 5. Connect via official StreamableHTTPClientTransport as Claude Web
      const rwTransport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
        authProvider: { token: async () => rwToken },
      });
      const rwClient = new Client({ name: 'claude-web', version: '1.0.0' });
      await rwClient.connect(rwTransport);

      try {
        const listed = await rwClient.listTools();
        expect(listed.tools).toHaveLength(16);

        // Status must redact local filesystem dataDir
        const statusRes = await rwClient.callTool({ name: 'daymark_get_status', arguments: {} });
        const status = SystemStatusSchema.parse(statusRes.structuredContent);
        expect(status.initialized).toBe(true);
        expect(status.dataDir).toBeNull();

        // Create project + capture task over Remote MCP
        const proj = CreateProjectOutputSchema.parse(
          (
            await rwClient.callTool({
              name: 'daymark_create_project',
              arguments: { name: 'Remote Claude Project' },
            })
          ).structuredContent,
        );

        const cap = CaptureTaskOutputSchema.parse(
          (
            await rwClient.callTool({
              name: 'daymark_capture_task',
              arguments: {
                title: 'Sync remote MCP with local CLI',
                projectId: proj.project.id,
                priority: 'high',
                estimateMinutes: 25,
              },
            })
          ).structuredContent,
        );
        expect(cap.task.sourceAgent).toBe('claude-web');

        // Verify local CLI immediately sees the remote-captured task in the shared SQLite DB
        const cliShow = await execCli(['task', 'show', cap.task.id, '--json'], homeDir);
        expect(cliShow.code).toBe(0);
        expect(JSON.parse(cliShow.stdout).data.task.title).toBe('Sync remote MCP with local CLI');

        // Update via CLI, then start & finish focus over Remote MCP
        await execCli(['task', 'update', cap.task.id, '--status', 'in_progress'], homeDir);

        const started = StartFocusOutputSchema.parse(
          (
            await rwClient.callTool({
              name: 'daymark_start_focus',
              arguments: { taskId: cap.task.id, note: 'Remote focus block' },
            })
          ).structuredContent,
        );
        expect(started.session.sourceAgent).toBe('claude-web');

        const finished = FinishFocusOutputSchema.parse(
          (
            await rwClient.callTool({
              name: 'daymark_finish_focus',
              arguments: { createWorklog: true },
            })
          ).structuredContent,
        );
        expect(finished.worklogEntry).not.toBeNull();

        const updated = UpdateTaskOutputSchema.parse(
          (
            await rwClient.callTool({
              name: 'daymark_update_task',
              arguments: { taskId: cap.task.id, status: 'completed' },
            })
          ).structuredContent,
        );
        expect(updated.task.status).toBe('completed');
      } finally {
        await rwClient.close();
      }

      // 6. Read-only bearer token enforces permission policy (reads succeed, writes fail FORBIDDEN)
      const roTransport = new StreamableHTTPClientTransport(new URL(server.mcpUrl), {
        authProvider: { token: async () => roToken },
      });
      const roClient = new Client({ name: 'claude-web', version: '1.0.0' });
      await roClient.connect(roTransport);

      try {
        const listRes = await roClient.callTool({ name: 'daymark_list_tasks', arguments: {} });
        const tasks = ListTasksOutputSchema.parse(listRes.structuredContent);
        expect(tasks.tasks.length).toBeGreaterThanOrEqual(1);

        const reviewRes = await roClient.callTool({
          name: 'daymark_generate_daily_review',
          arguments: {},
        });
        expect(
          DailyReviewOutputSchema.parse(reviewRes.structuredContent).completedTasks,
        ).toHaveLength(1);

        const forbiddenWrite = await roClient.callTool({
          name: 'daymark_capture_task',
          arguments: { title: 'Unauthorized write' },
        });
        expect(forbiddenWrite.isError).toBe(true);
        const errPayload = JSON.parse((forbiddenWrite.content[0] as { text: string }).text) as {
          error: { code: string };
        };
        expect(errPayload.error.code).toBe('FORBIDDEN');
      } finally {
        await roClient.close();
      }
    } finally {
      await server.close();
    }
  });

  it('enforces rate limiting, body size limits, and serves OAuth protected resource metadata', async () => {
    const homeDir = makeTempHome();
    const paths = resolveDaymarkPaths({ env: { DAYMARK_HOME: homeDir } });
    initializeProfile({ paths, timezone: 'UTC' });

    const server = await startDaymarkHttpServer({
      host: '127.0.0.1',
      port: 0,
      env: { ...process.env, DAYMARK_HOME: homeDir, DAYMARK_LOG_LEVEL: 'silent' },
      maxRequestBodySize: 256,
      rateLimit: { windowMs: 60_000, maxRequests: 2 },
      oauth: {
        resourceServerUrl: 'https://daymark.example.com/mcp',
        authorizationServers: ['https://auth.example.com'],
        scopesSupported: ['read', 'write'],
        verifier: {
          verifyAccessToken: async (token) => {
            if (token !== 'oauth-valid-token') throw new Error('invalid');
            return {
              token,
              clientId: 'claude-web-oauth-client',
              scopes: ['read'],
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            };
          },
        },
      },
    });

    try {
      // RFC 9728 OAuth protected resource metadata (path-aware under /.well-known/oauth-protected-resource/mcp)
      const metaRes = await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`);
      expect(metaRes.status).toBe(200);
      const metaJson = (await metaRes.json()) as {
        resource: string;
        authorization_servers: string[];
      };
      expect(metaJson.authorization_servers).toContain('https://auth.example.com');

      // Oversized body returns 413
      const bigBody = JSON.stringify({ jsonrpc: '2.0', id: 1, padding: 'x'.repeat(500) });
      const tooBigRes = await fetch(server.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer oauth-valid-token',
        },
        body: bigBody,
      });
      expect(tooBigRes.status).toBe(413);

      // Rate limit triggers 429 on 3rd request within window (maxRequests=2)
      const ok1 = await fetch(server.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer oauth-valid-token',
        },
        body: '{}',
      });
      expect(ok1.status).not.toBe(429);

      const ok2 = await fetch(server.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer oauth-valid-token',
        },
        body: '{}',
      });
      expect(ok2.status).not.toBe(429);

      const limited = await fetch(server.mcpUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer oauth-valid-token',
        },
        body: '{}',
      });
      expect(limited.status).toBe(429);
      expect(limited.headers.get('retry-after')).toBeTruthy();
      expect(limited.headers.get('x-ratelimit-remaining')).toBe('0');
    } finally {
      await server.close();
    }
  });
});
