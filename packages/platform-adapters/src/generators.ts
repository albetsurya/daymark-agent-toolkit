import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { loadAndValidatePortableSkills, resolveSkillsRootDir } from '@daymark/skills';
import {
  buildCanonicalBundleConfig,
  type CanonicalPlatformBundle,
  type PlatformTarget,
  resolveWorkspaceRootDir,
} from './canonical.js';

export interface GeneratedPlatformOutput {
  target: PlatformTarget;
  outputDir: string;
  files: string[];
}

function writeTextFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
}

function writeJsonFile(filePath: string, data: unknown): void {
  writeTextFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

function buildStandardMcpServersEntry(bundle: CanonicalPlatformBundle) {
  const entry: { command: string; args: string[]; env?: Record<string, string> } = {
    command: bundle.server.command,
    args: bundle.server.args,
  };
  if (Object.keys(bundle.server.env).length > 0) {
    entry.env = bundle.server.env;
  }
  return {
    mcpServers: {
      [bundle.server.id]: entry,
    },
  };
}

function formatTomlString(value: string): string {
  return JSON.stringify(value);
}

function buildCodexConfigTomlSnippet(bundle: CanonicalPlatformBundle): string {
  const lines = [
    `[mcp_servers.${bundle.server.id}]`,
    `command = ${formatTomlString(bundle.server.command)}`,
    `args = [${bundle.server.args.map(formatTomlString).join(', ')}]`,
  ];
  const envEntries = Object.entries(bundle.server.env);
  if (envEntries.length > 0) {
    lines.push('', `[mcp_servers.${bundle.server.id}.env]`);
    for (const [k, v] of envEntries) {
      lines.push(`${k} = ${formatTomlString(v)}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function copyPortableSkills(targetSkillsDir: string): string[] {
  const skills = loadAndValidatePortableSkills(resolveSkillsRootDir());
  mkdirSync(targetSkillsDir, { recursive: true });
  const copied: string[] = [];
  for (const skill of skills) {
    const dest = join(targetSkillsDir, skill.id);
    cpSync(skill.sourceDir, dest, { recursive: true });
    for (const f of skill.files) {
      copied.push(`${skill.id}/${f}`);
    }
  }
  return copied;
}

export interface GeneratePlatformsOptions {
  outputRoot?: string;
  mode?: 'portable' | 'local';
  mcpBinPath?: string;
  daymarkHome?: string;
  nodeExecutable?: string;
}

/**
 * Generates Tier 1 configs and Tier 2 platform bundles from the canonical Daymark model.
 */
export function generateAllPlatformPackages(
  options: GeneratePlatformsOptions = {},
): GeneratedPlatformOutput[] {
  const rootDir = resolveWorkspaceRootDir();
  const outputRoot = options.outputRoot ?? resolve(rootDir, 'dist/platforms');
  const skills = loadAndValidatePortableSkills(resolveSkillsRootDir());
  const bundle = buildCanonicalBundleConfig({
    mode: options.mode ?? 'portable',
    mcpBinPath: options.mcpBinPath,
    daymarkHome: options.daymarkHome,
    nodeExecutable: options.nodeExecutable,
    skillNames: skills.map((s) => s.folderName),
  });

  if (existsSync(outputRoot)) {
    rmSync(outputRoot, { recursive: true, force: true });
  }
  mkdirSync(outputRoot, { recursive: true });

  const outputs: GeneratedPlatformOutput[] = [];
  const standardMcp = buildStandardMcpServersEntry(bundle);

  // 1. Claude Code (.claude-plugin/plugin.json, .mcp.json, skills/)
  {
    const dir = join(outputRoot, 'claude-code');
    const files: string[] = [];
    writeJsonFile(join(dir, '.claude-plugin/plugin.json'), {
      name: bundle.pluginName,
      version: bundle.version,
      description: bundle.description,
      author: { name: bundle.authorName },
      license: 'Apache-2.0',
      keywords: ['productivity', 'tasks', 'mcp', 'local-first'],
    });
    files.push('.claude-plugin/plugin.json');
    writeJsonFile(join(dir, '.mcp.json'), standardMcp);
    files.push('.mcp.json');
    for (const rel of copyPortableSkills(join(dir, 'skills'))) {
      files.push(`skills/${rel}`);
    }
    writeTextFile(
      join(dir, 'README.md'),
      [
        '# Daymark for Claude Code',
        '',
        '## Tier 1 (MCP + Skills)',
        '1. Ensure `daymark-mcp` is on your PATH (or replace `"command"`/`"args"` in `.mcp.json` with `node /path/to/packages/mcp-server/dist/bin.mjs`).',
        '2. Initialize your local database: `daymark init`.',
        '3. Copy `.mcp.json` and `skills/` into your project or test as a local plugin.',
        '',
        '## Tier 2 (Native Plugin)',
        '```bash',
        'claude --plugin-dir ./dist/platforms/claude-code',
        '```',
        '',
        '## Uninstall',
        'Remove the plugin or `.mcp.json` entry. Uninstalling never deletes your local SQLite database.',
        '',
      ].join('\n'),
    );
    files.push('README.md');
    outputs.push({ target: 'claude-code', outputDir: dir, files });
  }

  // 2. OpenAI Codex (.codex-plugin/plugin.json, .mcp.json, config.toml.snippet, skills/)
  {
    const dir = join(outputRoot, 'codex');
    const files: string[] = [];
    writeJsonFile(join(dir, '.codex-plugin/plugin.json'), {
      name: bundle.pluginName,
      version: bundle.version,
      description: bundle.description,
      skills: './skills/',
      mcpServers: './.mcp.json',
    });
    files.push('.codex-plugin/plugin.json');
    writeJsonFile(join(dir, '.mcp.json'), standardMcp);
    files.push('.mcp.json');
    writeTextFile(join(dir, 'config.toml.snippet'), buildCodexConfigTomlSnippet(bundle));
    files.push('config.toml.snippet');
    for (const rel of copyPortableSkills(join(dir, 'skills'))) {
      files.push(`skills/${rel}`);
    }
    writeTextFile(
      join(dir, 'README.md'),
      [
        '# Daymark for OpenAI Codex',
        '',
        '## Tier 1 (MCP + Skills)',
        '1. Initialize your local store: `daymark init`.',
        '2. Add the `[mcp_servers.daymark]` block from `config.toml.snippet` into `~/.codex/config.toml` or `.codex/config.toml` (trusted project).',
        '3. Copy `skills/*` into `~/.codex/skills/` or `.codex/skills/`.',
        '',
        'Note: Hosted remote Codex sandboxes cannot invoke a local stdio binary on your workstation; use local Codex CLI/IDE.',
        '',
        '## Uninstall',
        'Remove `[mcp_servers.daymark]` from `config.toml` and delete the copied skill folders. Your local Daymark SQLite database remains intact.',
        '',
      ].join('\n'),
    );
    files.push('README.md');
    outputs.push({ target: 'codex', outputDir: dir, files });
  }

  // 3. Cursor Agent Plugin (root plugin.json + mcp.json + skills/)
  {
    const dir = join(outputRoot, 'cursor-agent-plugin');
    const files: string[] = [];
    writeJsonFile(join(dir, 'plugin.json'), {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: bundle.pluginName,
      version: bundle.version,
      description: bundle.description,
      author: { name: bundle.authorName },
      skills: './skills/',
      mcpServers: './mcp.json',
    });
    files.push('plugin.json');
    writeJsonFile(join(dir, 'mcp.json'), {
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      ...standardMcp,
    });
    files.push('mcp.json');
    for (const rel of copyPortableSkills(join(dir, 'skills'))) {
      files.push(`skills/${rel}`);
    }
    writeTextFile(
      join(dir, 'README.md'),
      [
        '# Daymark for Cursor (Open Agent Plugin)',
        '',
        '## Tier 1 & Tier 2',
        '1. Run `daymark init` locally.',
        '2. Load this directory as a Cursor Agent Plugin or copy `mcp.json` into `.cursor/mcp.json` and `skills/` into `.cursor/skills/`.',
        '',
        '## Uninstall',
        'Disable or remove the plugin/config entry; your local SQLite database is untouched.',
        '',
      ].join('\n'),
    );
    files.push('README.md');
    outputs.push({ target: 'cursor-agent-plugin', outputDir: dir, files });
  }

  // 4. Cursor Native (.cursor-plugin/plugin.json + mcp.json + skills/)
  {
    const dir = join(outputRoot, 'cursor-native');
    const files: string[] = [];
    writeJsonFile(join(dir, '.cursor-plugin/plugin.json'), {
      name: bundle.pluginName,
      version: bundle.version,
      description: bundle.description,
      author: { name: bundle.authorName },
      skills: './skills/',
      mcpServers: './mcp.json',
    });
    files.push('.cursor-plugin/plugin.json');
    writeJsonFile(join(dir, 'mcp.json'), standardMcp);
    files.push('mcp.json');
    for (const rel of copyPortableSkills(join(dir, 'skills'))) {
      files.push(`skills/${rel}`);
    }
    writeTextFile(
      join(dir, 'README.md'),
      [
        '# Daymark for Cursor (Native Plugin Layout)',
        '',
        'Uses `.cursor-plugin/plugin.json` with `mcp.json` and `skills/`. High-frequency hooks are intentionally omitted in MVP.',
        '',
      ].join('\n'),
    );
    files.push('README.md');
    outputs.push({ target: 'cursor-native', outputDir: dir, files });
  }

  // 5. Google Antigravity (.antigravity-plugin/plugin.json + mcp_config.json + skills/)
  {
    const dir = join(outputRoot, 'antigravity');
    const files: string[] = [];
    writeJsonFile(join(dir, '.antigravity-plugin/plugin.json'), {
      $schema: 'https://antigravity.google/schemas/v1/plugin.json',
      name: bundle.pluginName,
      displayName: bundle.displayName,
      version: bundle.version,
      description: bundle.description,
      suggestedPrompts: [
        'Plan my Daymark workday given my available minutes',
        'Capture a new task in Daymark without inventing estimates',
        'Wrap up my day using recorded Daymark worklogs and sessions',
      ],
    });
    files.push('.antigravity-plugin/plugin.json');
    writeJsonFile(join(dir, 'mcp_config.json'), standardMcp);
    files.push('mcp_config.json');
    for (const rel of copyPortableSkills(join(dir, 'skills'))) {
      files.push(`skills/${rel}`);
    }
    writeTextFile(
      join(dir, 'README.md'),
      [
        '# Daymark for Google Antigravity',
        '',
        '## Validate & Install',
        '```bash',
        'agy plugin validate --strict ./dist/platforms/antigravity',
        'agy plugin install ./dist/platforms/antigravity',
        '```',
        '',
        '## Tier 1 Standalone MCP',
        'Or run `agy mcp add daymark daymark-mcp` (or `node /path/to/packages/mcp-server/dist/bin.mjs`).',
        '',
        '## Uninstall',
        '`agy plugin uninstall daymark` or `agy mcp remove daymark`. Your local SQLite database is never removed.',
        '',
      ].join('\n'),
    );
    files.push('README.md');
    outputs.push({ target: 'antigravity', outputDir: dir, files });
  }

  // 6. OpenCode (opencode.json + .opencode/skills/)
  {
    const dir = join(outputRoot, 'opencode');
    const files: string[] = [];
    const openCodeMcp: {
      type: 'local';
      command: string[];
      enabled: boolean;
      environment?: Record<string, string>;
    } = {
      type: 'local',
      command: [bundle.server.command, ...bundle.server.args],
      enabled: true,
    };
    if (Object.keys(bundle.server.env).length > 0) {
      openCodeMcp.environment = bundle.server.env;
    }
    writeJsonFile(join(dir, 'opencode.json'), {
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        servers: {
          [bundle.server.id]: openCodeMcp,
        },
      },
    });
    files.push('opencode.json');
    for (const rel of copyPortableSkills(join(dir, '.opencode/skills'))) {
      files.push(`.opencode/skills/${rel}`);
    }
    writeTextFile(
      join(dir, 'README.md'),
      [
        '# Daymark for OpenCode',
        '',
        '## Tier 1 (MCP + Skills)',
        '1. Initialize your profile: `daymark init`.',
        '2. Merge `opencode.json` into your project `opencode.json` or `~/.config/opencode/opencode.json` (or run `opencode mcp add daymark -- daymark-mcp`).',
        '3. Copy `.opencode/skills/*` into `.opencode/skills/` or `~/.config/opencode/skills/`.',
        '',
        '## Uninstall',
        'Remove the `mcp.servers.daymark` entry from `opencode.json` and remove the skill folders. Your local SQLite database remains intact.',
        '',
      ].join('\n'),
    );
    files.push('README.md');
    outputs.push({ target: 'opencode', outputDir: dir, files });
  }

  return outputs;
}
