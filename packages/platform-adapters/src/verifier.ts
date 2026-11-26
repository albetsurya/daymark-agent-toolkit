import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DaymarkError } from '@daymark/contracts';
import { loadAndValidatePortableSkills } from '@daymark/skills';
import * as z from 'zod';
import { resolveWorkspaceRootDir } from './canonical.js';

const StandardMcpFileSchema = z.object({
  mcpServers: z.record(
    z.string(),
    z.object({
      command: z.string().min(1),
      args: z.array(z.string()),
      env: z.record(z.string(), z.string()).optional(),
    }),
  ),
});

const OpenCodeConfigSchema = z.object({
  $schema: z.string(),
  mcp: z.object({
    servers: z.record(
      z.string(),
      z.object({
        type: z.literal('local'),
        command: z.array(z.string().min(1)).min(1),
        environment: z.record(z.string(), z.string()).optional(),
        enabled: z.boolean().optional(),
      }),
    ),
  }),
});

const ClaudeManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  author: z.object({ name: z.string().min(1) }),
});

const CodexManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  skills: z.string().min(1),
  mcpServers: z.string().min(1),
});

const CursorManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  skills: z.string().min(1),
  mcpServers: z.string().min(1),
});

const AntigravityManifestSchema = z.object({
  $schema: z.string().min(1),
  name: z.string().min(1),
  displayName: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
});

export interface PackageVerificationResult {
  target: string;
  valid: boolean;
  checkedFiles: number;
  skillsCount: number;
  errors: string[];
}

function walkFilesSafe(rootDir: string): string[] {
  const results: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const abs = join(current, entry.name);
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) {
        throw new DaymarkError('VALIDATION_FAILED', `Symlink forbidden inside package: ${abs}`);
      }
      const rel = relative(rootDir, abs);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new DaymarkError('VALIDATION_FAILED', `Path escaped package root: ${abs}`);
      }
      if (entry.name.endsWith('.sqlite') || entry.name.endsWith('.db') || entry.name === '.env') {
        throw new DaymarkError('VALIDATION_FAILED', `Forbidden user data/secret file: ${rel}`);
      }
      if (st.isDirectory()) {
        stack.push(abs);
      } else if (st.isFile()) {
        results.push(rel);
      }
    }
  }
  return results;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function verifyGeneratedPlatformPackages(
  outputRoot: string = resolve(resolveWorkspaceRootDir(), 'dist/platforms'),
): PackageVerificationResult[] {
  const checks: {
    target: string;
    manifestPath: string;
    manifestSchema: z.ZodType;
    mcpPath: string;
    mcpSchema: z.ZodType;
    skillsRelDir: string;
  }[] = [
    {
      target: 'claude-code',
      manifestPath: '.claude-plugin/plugin.json',
      manifestSchema: ClaudeManifestSchema,
      mcpPath: '.mcp.json',
      mcpSchema: StandardMcpFileSchema,
      skillsRelDir: 'skills',
    },
    {
      target: 'codex',
      manifestPath: '.codex-plugin/plugin.json',
      manifestSchema: CodexManifestSchema,
      mcpPath: '.mcp.json',
      mcpSchema: StandardMcpFileSchema,
      skillsRelDir: 'skills',
    },
    {
      target: 'cursor-agent-plugin',
      manifestPath: 'plugin.json',
      manifestSchema: CursorManifestSchema,
      mcpPath: 'mcp.json',
      mcpSchema: StandardMcpFileSchema,
      skillsRelDir: 'skills',
    },
    {
      target: 'cursor-native',
      manifestPath: '.cursor-plugin/plugin.json',
      manifestSchema: CursorManifestSchema,
      mcpPath: 'mcp.json',
      mcpSchema: StandardMcpFileSchema,
      skillsRelDir: 'skills',
    },
    {
      target: 'antigravity',
      manifestPath: '.antigravity-plugin/plugin.json',
      manifestSchema: AntigravityManifestSchema,
      mcpPath: 'mcp_config.json',
      mcpSchema: StandardMcpFileSchema,
      skillsRelDir: 'skills',
    },
    {
      target: 'opencode',
      manifestPath: 'opencode.json',
      manifestSchema: OpenCodeConfigSchema,
      mcpPath: 'opencode.json',
      mcpSchema: OpenCodeConfigSchema,
      skillsRelDir: '.opencode/skills',
    },
  ];

  return checks.map((spec) => {
    const dir = join(outputRoot, spec.target);
    const errors: string[] = [];
    let checkedFiles = 0;
    let skillsCount = 0;

    if (!existsSync(dir)) {
      return {
        target: spec.target,
        valid: false,
        checkedFiles: 0,
        skillsCount: 0,
        errors: [`Missing generated directory: ${dir}`],
      };
    }

    try {
      const files = walkFilesSafe(dir);
      checkedFiles = files.length;

      const manifestAbs = join(dir, spec.manifestPath);
      if (!existsSync(manifestAbs)) {
        errors.push(`Missing manifest: ${spec.manifestPath}`);
      } else {
        const res = spec.manifestSchema.safeParse(readJson(manifestAbs));
        if (!res.success) {
          errors.push(
            `Manifest schema invalid: ${res.error.issues.map((i) => i.message).join('; ')}`,
          );
        }
      }

      const mcpAbs = join(dir, spec.mcpPath);
      if (!existsSync(mcpAbs)) {
        errors.push(`Missing MCP config: ${spec.mcpPath}`);
      } else {
        const res = spec.mcpSchema.safeParse(readJson(mcpAbs));
        if (!res.success) {
          errors.push(`MCP schema invalid: ${res.error.issues.map((i) => i.message).join('; ')}`);
        }
      }

      const skillsAbs = join(dir, spec.skillsRelDir);
      if (!existsSync(skillsAbs)) {
        errors.push(`Missing skills directory: ${spec.skillsRelDir}`);
      } else {
        const loaded = loadAndValidatePortableSkills(skillsAbs);
        skillsCount = loaded.length;
      }
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }

    return {
      target: spec.target,
      valid: errors.length === 0,
      checkedFiles,
      skillsCount,
      errors,
    };
  });
}
