// test/skillstore.test.ts — skill repository: index, search ranking, usage scoring
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { searchSkills, recordUsage, rebuildIndex, configureSkillDirs } from '../src/skillstore.js';

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
  configureSkillDirs([path.join(process.cwd(), '.agents', 'skills')], path.join(process.cwd(), 'data'));
});

async function seed(): Promise<string> {
  // create a fake skill tree mirroring .agents/skills structure
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-skills-'));
  dirs.push(root);
  const mk = async (id: string, name: string, description: string) => {
    const dir = path.join(root, '.agents', 'skills', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nbody`, 'utf8');
  };
  await mk('frontend-design', 'Frontend Design', 'Guidance for distinctive visual design when building new UI. Typography, palette, avoiding templated defaults.');
  await mk('designing-user-experience', 'Designing User Experience', 'User flows, navigation, forms and validation, loading/empty/error states, confirmation for destructive actions.');
  await mk('implementing-llms-litgpt', 'Implementing LLMs with LitGPT', 'Implements and trains LLMs using LitGPT. Model architectures, fine-tuning with LoRA.');
  configureSkillDirs([path.join(root, '.agents', 'skills')], root);
  return root;
}

describe('skill store', () => {
  it('indexes every SKILL.md with frontmatter parsed', async () => {
    const root = await seed();
    const skills = await rebuildIndex();
    void root;
    const ids = skills.map((s) => s.id);
    expect(ids).toContain('frontend-design');
    expect(ids).toContain('designing-user-experience');
    const fd = skills.find((s) => s.id === 'frontend-design');
    expect(fd?.name).toBe('Frontend Design');
    expect(fd?.description).toContain('visual design');
    expect(fd?.tags.length).toBeGreaterThan(0);
  });

  it('ranks keyword matches: UI query hits design skills, not litgpt', async () => {
    await seed();
    const results = await searchSkills('UI design interface', 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].id).toMatch(/frontend|designing/);
    expect(results.some((r) => r.id === 'implementing-llms-litgpt')).toBe(false);
  });

  it('usage history boosts "best" ranking', async () => {
    await seed();
    recordUsage('implementing-llms-litgpt', 'good');
    recordUsage('implementing-llms-litgpt', 'good');
    recordUsage('implementing-llms-litgpt', 'good');
    const results = await searchSkills('llm training', 3);
    const lit = results.find((r) => r.id === 'implementing-llms-litgpt');
    expect(lit?.usage.good).toBe(3);
    expect(lit?.score).toBe(6); // good*2
    // usage bonus participates in relevance: litgpt now surfaces for a generic query
    const generic = await searchSkills('llm', 3);
    expect(generic[0]?.id).toBe('implementing-llms-litgpt');
  });

  it('returns empty for no match and empty query sorts by score', async () => {
    await seed();
    expect(await searchSkills('zzz-no-such-topic', 5)).toHaveLength(0);
    const byScore = await searchSkills('', 5);
    expect(byScore.length).toBeGreaterThan(0);
  });
});
