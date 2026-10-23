// src/skillstore.ts — Orbit skill repository: index every SKILL.md, keyword search,
// and a usage-scored ranking so a bot can pick the BEST skill, not just any match.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let SKILL_DIRS = [path.join(ROOT, '.agents', 'skills'), path.join(ROOT, 'data', 'custom-skills')];

/** Tests / embedders can point the store at their own tree. */
export function configureSkillDirs(dirs: string[], dataDir?: string): void {
  SKILL_DIRS = dirs;
  DATA_FILES = dataDir
    ? { index: path.join(dataDir, 'skills-index.json'), usage: path.join(dataDir, 'skill-usage.json') }
    : {};
}
const INDEX_FILE = path.join(ROOT, 'data', 'skills-index.json');
const USAGE_FILE = path.join(ROOT, 'data', 'skill-usage.json');
let DATA_FILES: { index?: string; usage?: string } = {};

export interface IndexedSkill {
  id: string;            // directory name
  name: string;
  description: string;
  tags: string[];        // auto-extracted keywords
  dir: string;
  files: number;
  bytes: number;
  hasReferences: boolean;
  usage: { good: number; bad: number };
  score: number;         // usage-derived quality (search adds relevance on top)
}

interface UsageRecord { [skillId: string]: { good: number; bad: number } }

const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'for', 'with', 'on', 'is', 'it', 'this', 'that', 'use', 'when', 'via', 'by']);

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []).filter((t) => !STOP.has(t));
}

function extractTags(text: string): string[] {
  const freq = new Map<string, number>();
  for (const t of tokenize(text)) freq.set(t, (freq.get(t) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t]) => t);
}

function parseFrontmatter(raw: string): { name?: string; description?: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: { name?: string; description?: string } = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(name|description):\s*(.+)$/);
    if (kv) out[kv[1] as 'name' | 'description'] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

let indexCache: { stamp: string; skills: IndexedSkill[] } | null = null;

function dirStamp(): string {
  const parts: string[] = [];
  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) continue;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name, 'SKILL.md');
      try { parts.push(existsSync(f) ? `${f}:${statSync(f).mtimeMs}` : `${f}:absent`); } catch { parts.push(f + ':err'); }
    }
  }
  return parts.sort().join('|');
}

/** Rebuild the index from every SKILL.md found in the skill directories.
 *  Cached: only rescans when a SKILL.md set or mtime changes (no write-on-read). */
export async function rebuildIndex(force = false): Promise<IndexedSkill[]> {
  const stamp = dirStamp();
  if (!force && indexCache && indexCache.stamp === stamp) return indexCache.skills;
  const skills: IndexedSkill[] = [];
  for (const dir of SKILL_DIRS) {
    if (!existsSync(dir)) continue;
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillDir = path.join(dir, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');
      if (!existsSync(skillFile)) continue;
      try {
        const raw = readFileSync(skillFile, 'utf8');
        const fm = parseFrontmatter(raw);
        let files = 0;
        let bytes = 0;
        let hasReferences = false;
        for (const f of await fs.readdir(skillDir, { withFileTypes: true })) {
          if (f.isFile()) { files++; bytes += (await fs.stat(path.join(skillDir, f.name))).size; }
          if (f.isDirectory() && f.name === 'references') hasReferences = true;
        }
        skills.push({
          id: entry.name,
          name: fm.name ?? entry.name,
          description: fm.description ?? raw.split('\n').find((l) => l.trim() && !l.startsWith('#')) ?? '',
          tags: extractTags(`${entry.name} ${fm.name ?? ''} ${fm.description ?? ''} ${raw.slice(0, 2000)}`),
          dir: skillDir,
          files, bytes, hasReferences,
          usage: { good: 0, bad: 0 },
          score: 0,
        });
      } catch { /* skip unreadable */ }
    }
  }
  const usage = loadUsage();
  for (const s of skills) {
    s.usage = usage[s.id] ?? { good: 0, bad: 0 };
    s.score = usageScore(s.usage);
  }
  indexCache = { stamp, skills };
  saveIndex(skills);
  return skills;
}

function usageScore(u: { good: number; bad: number }): number {
  return Math.max(0, u.good * 2 - u.bad);
}

function loadUsage(): UsageRecord {
  try { return JSON.parse(readFileSync(DATA_FILES.usage ?? USAGE_FILE, 'utf8')) as UsageRecord; } catch { return {}; }
}

function saveIndex(skills: IndexedSkill[]): void {
  const file = DATA_FILES.index ?? INDEX_FILE;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(skills, null, 2), 'utf8');
}

/** Search + rank: keyword relevance over name/description/tags, boosted by usage history. */
export async function searchSkills(query: string, limit = 5): Promise<(IndexedSkill & { relevance: number })[]> {
  let skills = await rebuildIndex();
  if (skills.length === 0) return [];
  const q = query.trim().toLowerCase();
  if (!q) {
    return skills.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => ({ ...s, relevance: s.score }));
  }
  const qTokens = tokenize(q).filter((t) => t.length >= 3);
  const scored = skills.map((s) => {
    let relevance = 0;
    const hay = `${s.id} ${s.name}`.toLowerCase();
    const desc = s.description.toLowerCase();
    for (const t of qTokens) {
      if (hay.includes(t)) relevance += 3;
      if (desc.includes(t)) relevance += 2;
      if (s.tags.some((tag) => tag === t)) relevance += 1.5;
    }
    return { ...s, relevance: relevance + s.score * 0.5 };
  });
  return scored
    .filter((s) => s.relevance > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
}

/** Record an outcome after the bot used a skill — feeds the "best" ranking. */
export function recordUsage(skillId: string, outcome: 'good' | 'bad'): { id: string; good: number; bad: number; score: number } {
  const usage = loadUsage();
  const rec = usage[skillId] ?? { good: 0, bad: 0 };
  if (outcome === 'good') rec.good++;
  else rec.bad++;
  usage[skillId] = rec;
  const file = DATA_FILES.usage ?? USAGE_FILE;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(usage, null, 2), 'utf8');
  return { id: skillId, good: rec.good, bad: rec.bad, score: usageScore(rec) };
}

export function skillStoreDirs(): string[] {
  return SKILL_DIRS.filter((d) => existsSync(d));
}
void ROOT;
