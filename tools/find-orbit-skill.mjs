#!/usr/bin/env node
// tools/find-orbit-skill.mjs — bot-facing CLI for the Orbit skill repository.
//   node tools/find-orbit-skill.mjs "<query>" [--limit 5]   search & rank
//   node tools/find-orbit-skill.mjs --record <skillId> good|bad   log an outcome
//   node tools/find-orbit-skill.mjs --list                  full listing by score
import { searchSkills, recordUsage, rebuildIndex } from '../src/skillstore.ts';
import { register } from 'node:module';

const args = process.argv.slice(2);
if (args.includes('--record')) {
  const idx = args.indexOf('--record');
  const id = args[idx + 1];
  const outcome = args[idx + 2] === 'good' ? 'good' : 'bad';
  console.log(JSON.stringify(recordUsage(id, outcome)));
  process.exit(0);
}
if (args.includes('--rebuild')) {
  const skills = await rebuildIndex();
  console.log(`indexed ${skills.length} skills`);
  process.exit(0);
}
const qIdx = args.findIndex((a) => !a.startsWith('--'));
const query = qIdx >= 0 ? args[qIdx] : '';
const limitIdx = args.indexOf('--limit');
const limit = limitIdx >= 0 ? Number(args[limitIdx + 1]) || 5 : 5;
const results = await searchSkills(query, limit);
if (results.length === 0) { console.log(`Khong co skill nao khop "${query}".`); process.exit(0); }
for (const [i, s] of results.entries()) {
  console.log(`${i + 1}. [${s.id}] ${s.name} — relevance ${s.relevance.toFixed(1)} · usage ${s.usage.good}g/${s.usage.bad}b`);
  console.log(`   ${s.description.slice(0, 140)}`);
  console.log(`   ${s.dir}`);
}
