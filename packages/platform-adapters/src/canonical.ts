import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, DaymarkError } from '@daymark/contracts';
import * as z from 'zod';

export const PlatformTargetSchema = z.enum([
  'claude-code',
  'codex',
  'cursor-agent-plugin',
  'cursor-native',
  'antigravity',
  'opencode',
]);
export type PlatformTarget = z.infer<typeof PlatformTargetSchema>;

export const CanonicalServerConfigSchema = z.object({
  id: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()),
  env: z.record(z.string(), z.string()),
});
export type CanonicalServerConfig = z.infer<typeof CanonicalServerConfigSchema>;

export const CanonicalPlatformBundleSchema = z.object({
  pluginName: z.string().min(1),
  displayName: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  authorName: z.string().min(1),
  server: CanonicalServerConfigSchema,
  skills: z.array(z.string().min(1)),
});
export type CanonicalPlatformBundle = z.infer<typeof CanonicalPlatformBundleSchema>;

export function resolveWorkspaceRootDir(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new DaymarkError('VALIDATION_FAILED', 'Could not locate workspace root directory.');
}

export function resolveBuiltMcpBinPath(rootDir: string = resolveWorkspaceRootDir()): string {
  const candidate = resolve(rootDir, 'packages/mcp-server/dist/bin.mjs');
  if (!existsSync(candidate)) {
    throw new DaymarkError(
      'VALIDATION_FAILED',
      'Built MCP server artifact packages/mcp-server/dist/bin.mjs was not found. Run `pnpm build` first.',
    );
  }
  return candidate;
}

export interface CanonicalConfigOptions {
  mode?: 'portable' | 'local';
  mcpBinPath?: string;
  daymarkHome?: string;
  nodeExecutable?: string;
  skillNames?: string[];
}

export function buildCanonicalBundleConfig(
  options: CanonicalConfigOptions = {},
): CanonicalPlatformBundle {
  const mode = options.mode ?? 'portable';
  const env: Record<string, string> = {};
  if (options.daymarkHome) {
    env.DAYMARK_HOME = options.daymarkHome;
  }

  const server: CanonicalServerConfig =
    mode === 'local'
      ? {
          id: 'daymark',
          command: options.nodeExecutable ?? 'node',
          args: [options.mcpBinPath ?? resolveBuiltMcpBinPath()],
          env,
        }
      : {
          id: 'daymark',
          command: 'daymark-mcp',
          args: [],
          env,
        };

  return CanonicalPlatformBundleSchema.parse({
    pluginName: 'daymark',
    displayName: 'Daymark',
    version: APP_VERSION,
    description:
      'Local-first, cross-agent productivity toolkit for tasks, daily planning, focus sessions, worklogs, and factual reviews.',
    authorName: 'Daymark Contributors',
    server,
    skills: options.skillNames ?? ['daily-planning', 'daily-wrap', 'task-triage'],
  });
}
