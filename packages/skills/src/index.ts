import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DaymarkError } from '@daymark/contracts';
import * as z from 'zod';

export const CANONICAL_MCP_TOOLS = [
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
] as const;

export const SkillFrontmatterSchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Skill name must be lowercase kebab-case'),
  description: z.string().min(10).max(500),
  compatibility: z.string().optional(),
  metadata: z
    .object({
      author: z.string().optional(),
      version: z.string().optional(),
    })
    .optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

export interface LoadedPortableSkill {
  id: string;
  folderName: string;
  sourceDir: string;
  frontmatter: SkillFrontmatter;
  body: string;
  referencedTools: string[];
  files: string[];
}

const PROVIDER_SPECIFIC_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\$\{CLAUDE_PLUGIN_ROOT\}/, reason: 'Claude-specific variable CLAUDE_PLUGIN_ROOT' },
  { pattern: /\$\{PLUGIN_ROOT\}/, reason: 'Plugin-specific variable PLUGIN_ROOT' },
  { pattern: /\$\{PLUGIN_DATA\}/, reason: 'Plugin-specific variable PLUGIN_DATA' },
  { pattern: /\.claude-plugin\b/, reason: 'Claude Code plugin path' },
  { pattern: /\.codex-plugin\b/, reason: 'Codex plugin path' },
  { pattern: /\.cursor-plugin\b/, reason: 'Cursor plugin path' },
  { pattern: /\.antigravity-plugin\b/, reason: 'Antigravity plugin path' },
  { pattern: /\.opencode\/skills\b/, reason: 'OpenCode-specific path' },
];

export function resolveSkillsRootDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const distSkills = resolve(here, './skills');
  if (existsSync(distSkills)) return distSkills;
  const repoSkills = resolve(here, '../../../skills');
  if (existsSync(repoSkills)) return repoSkills;
  throw new DaymarkError('VALIDATION_FAILED', 'Portable skills directory could not be located.');
}

function parseFrontmatterBlock(raw: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(raw);
  if (!match) {
    throw new DaymarkError(
      'VALIDATION_FAILED',
      'SKILL.md must begin with a YAML frontmatter block.',
    );
  }
  const yamlBlock = match[1] ?? '';
  const body = match[2] ?? '';

  const parsed: Record<string, unknown> = {};
  let currentMapKey: string | null = null;

  for (const line of yamlBlock.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const nestedMatch = /^ {2}([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (nestedMatch && currentMapKey) {
      const k = nestedMatch[1] ?? '';
      const rawVal = (nestedMatch[2] ?? '').trim().replace(/^["']|["']$/g, '');
      const obj = (parsed[currentMapKey] as Record<string, string>) ?? {};
      obj[k] = rawVal;
      parsed[currentMapKey] = obj;
      continue;
    }

    const topMatch = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line);
    if (!topMatch) continue;
    const key = topMatch[1] ?? '';
    const val = (topMatch[2] ?? '').trim();
    if (val === '') {
      currentMapKey = key;
      parsed[key] = {};
    } else {
      currentMapKey = null;
      parsed[key] = val.replace(/^["']|["']$/g, '');
    }
  }

  return { frontmatter: parsed, body };
}

function collectRelativeFiles(rootDir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    const abs = join(rootDir, entry.name);
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) {
      throw new DaymarkError(
        'VALIDATION_FAILED',
        `Refusing symlink inside skill directory: ${abs}`,
      );
    }
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (stat.isDirectory()) {
      out.push(...collectRelativeFiles(abs, rel));
    } else if (stat.isFile()) {
      out.push(rel);
    }
  }
  return out.sort();
}

export function extractDaymarkToolReferences(text: string): string[] {
  const matches = text.match(/\bdaymark_[a-z0-9_]+\b/g) ?? [];
  return [...new Set(matches)].sort();
}

export function loadAndValidatePortableSkills(
  skillsRootDir: string = resolveSkillsRootDir(),
): LoadedPortableSkill[] {
  const entries = readdirSync(skillsRootDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const seenIds = new Set<string>();
  const canonicalSet = new Set<string>(CANONICAL_MCP_TOOLS);
  const skills: LoadedPortableSkill[] = [];

  for (const dir of entries) {
    const folderDir = join(skillsRootDir, dir.name);
    const skillMdPath = join(folderDir, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
      throw new DaymarkError('VALIDATION_FAILED', `Missing SKILL.md in ${dir.name}`);
    }

    const raw = readFileSync(skillMdPath, 'utf8');
    const { frontmatter: rawFm, body } = parseFrontmatterBlock(raw);
    const fmResult = SkillFrontmatterSchema.safeParse(rawFm);
    if (!fmResult.success) {
      throw new DaymarkError(
        'VALIDATION_FAILED',
        `Invalid frontmatter in ${dir.name}/SKILL.md: ${fmResult.error.issues.map((i) => i.message).join('; ')}`,
      );
    }

    const id = fmResult.data.name;
    if (seenIds.has(id)) {
      throw new DaymarkError('VALIDATION_FAILED', `Duplicate skill ID "${id}".`);
    }
    seenIds.add(id);

    const files = collectRelativeFiles(folderDir);
    const allTexts = files
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(folderDir, f), 'utf8'));

    for (const content of allTexts) {
      for (const check of PROVIDER_SPECIFIC_PATTERNS) {
        if (check.pattern.test(content)) {
          throw new DaymarkError(
            'VALIDATION_FAILED',
            `Skill "${dir.name}" contains provider-specific syntax (${check.reason}).`,
          );
        }
      }
    }

    const referencedTools = extractDaymarkToolReferences(raw);
    for (const toolName of referencedTools) {
      if (!canonicalSet.has(toolName)) {
        throw new DaymarkError(
          'VALIDATION_FAILED',
          `Skill "${dir.name}" references unknown MCP tool "${toolName}".`,
        );
      }
    }

    skills.push({
      id,
      folderName: dir.name,
      sourceDir: folderDir,
      frontmatter: fmResult.data,
      body,
      referencedTools,
      files,
    });
  }

  return skills;
}
