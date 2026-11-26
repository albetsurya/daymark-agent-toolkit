import { describe, expect, it } from 'vitest';
import { CANONICAL_MCP_TOOLS, loadAndValidatePortableSkills } from './index.js';

describe('@daymark/skills portable skill validation', () => {
  it('loads all starter skills with valid frontmatter, unique IDs, and MCP contract tool parity', () => {
    const skills = loadAndValidatePortableSkills();
    expect(skills.map((s) => s.id)).toEqual([
      'daymark-daily-planning',
      'daymark-daily-wrap',
      'daymark-task-triage',
    ]);

    const canonical = new Set<string>(CANONICAL_MCP_TOOLS);
    for (const skill of skills) {
      expect(skill.referencedTools.length).toBeGreaterThan(0);
      for (const tool of skill.referencedTools) {
        expect(canonical.has(tool)).toBe(true);
      }
    }
  });

  it('verifies skills forbid fabricating durations, deadlines, or unconfirmed worklogs', () => {
    const skills = loadAndValidatePortableSkills();
    const planning = skills.find((s) => s.id === 'daymark-daily-planning');
    const wrap = skills.find((s) => s.id === 'daymark-daily-wrap');
    const triage = skills.find((s) => s.id === 'daymark-task-triage');

    expect(planning?.body).toMatch(/Never infer free time/i);
    expect(planning?.body).toMatch(/Do not invent estimates/i);
    expect(wrap?.body).toMatch(/do not infer work from conversation history/i);
    expect(wrap?.body).toMatch(/Do not make those changes without the user/i);
    expect(triage?.body).toMatch(/Do not invent deadlines or estimates/i);
  });
});
