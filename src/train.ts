// src/train.ts — continuous training loop (no weight fine-tuning theater):
// round = run bench -> model proposes prompt improvements from real failures ->
// apply -> re-run -> keep if better, rollback if worse. All rounds persisted.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { runBench, saveReport, compareReports, type BenchReport } from './bench.js';
import {
  loadPromptState, savePromptState, applyPromptState, snapshotPromptState,
  currentPromptVersion, BASE_AGENT_RULES, BASE_PROMPT_VERSION,
} from './prompts.js';
import { extractJson } from './core.js';
import type { ChatOptions, ChatResult } from './providers.js';

export interface TrainDeps {
  modelConfigId: string;
  chatFn: (modelConfigId: string, opts: ChatOptions) => Promise<ChatResult>;
  dataDir: string;
  maxRounds?: number;
  targetPass?: number; // stop early when reached (default: all tasks)
  onProgress?: (line: string) => void;
}

export interface TrainRound {
  round: number;
  report: BenchReport;
  action: 'baseline' | 'kept' | 'rolled-back' | 'done';
  note?: string;
}

export interface TrainSummary {
  rounds: TrainRound[];
  finalPass: number;
  total: number;
  finalVersion: string;
}

function failSummary(report: BenchReport): string {
  return report.results
    .filter((r) => !r.pass)
    .map((r) => `- ${r.taskId} (${r.title}): ${(r.error ?? r.detail ?? 'verification failed').split('\n')[0].slice(0, 180)}`)
    .join('\n');
}

async function proposeImprovement(deps: TrainDeps, report: BenchReport): Promise<{ rules: string; coder?: string } | null> {
  const current = snapshotPromptState();
  const res = await deps.chatFn(deps.modelConfigId, {
    messages: [
      { role: 'system', content: 'You improve the system prompt of a coding agent based on benchmark failures. Reply ONLY compact JSON: {"rules": "<3 concise sentences max, the agent operating rules>"} — optionally {"coder": "<coder role prompt, 2 sentences max>"}. Rules must be general enough to help OTHER tasks too, never task-specific answers. No markdown.' },
      { role: 'user', content: `Current AGENT RULES:\n${current.rules}\n\nBenchmark ${report.summary.pass}/${report.summary.total} passed. Failures:\n${failSummary(report)}\n\nPropose improved rules that address the failure patterns.` },
    ],
    maxTokens: 300,
    temperature: 0.3,
    timeoutMs: 60_000,
  });
  const obj = extractJson(res.text) as { rules?: string; coder?: string } | null;
  if (!obj?.rules || typeof obj.rules !== 'string' || obj.rules.trim().length < 20) return null;
  return { rules: obj.rules.trim(), ...(obj.coder && typeof obj.coder === 'string' ? { coder: obj.coder.trim() } : {}) };
}

export async function runTraining(deps: TrainDeps): Promise<TrainSummary> {
  const maxRounds = Math.max(1, Math.min(deps.maxRounds ?? 3, 8));
  const totalTasks = (await runBenchProbeCount(deps));
  const target = deps.targetPass ?? totalTasks;
  loadPromptState(deps.dataDir);

  const rounds: TrainRound[] = [];
  let best: { pass: number; state: ReturnType<typeof snapshotPromptState> } | null = null;

  for (let round = 1; round <= maxRounds; round++) {
    deps.onProgress?.(`── Round ${round}/${maxRounds} · prompt ${currentPromptVersion()} ──`);
    const report = await runBench({ modelConfigId: deps.modelConfigId, chatFn: deps.chatFn, maxSteps: 16, onProgress: deps.onProgress });
    await saveReport(deps.dataDir, report);
    deps.onProgress?.(`   → ${report.summary.pass}/${report.summary.total} PASS (${report.summary.totalTokens} tok)`);

    const prev = rounds[rounds.length - 2];
    let action: TrainRound['action'] = round === 1 ? 'baseline' : 'kept';
    let note: string | undefined;
    if (prev) {
      const cmp = compareReports(prev.report, report);
      note = cmp.summary;
      if (report.summary.pass < prev.report.summary.pass) {
        // rollback to the state that produced the previous (better) report
        if (best) {
          applyPromptState(best.state);
          savePromptState(deps.dataDir);
        } else {
          applyPromptState({ version: BASE_PROMPT_VERSION, rules: BASE_AGENT_RULES });
          savePromptState(deps.dataDir);
        }
        action = 'rolled-back';
        rounds.push({ round, report, action, note });
        deps.onProgress?.(`   ↺ regression (${note}) — rolled back to ${currentPromptVersion()}`);
        break; // stop after a regression; keep the good state
      }
    }
    if (!best || report.summary.pass > best.pass) best = { pass: report.summary.pass, state: snapshotPromptState() };

    if (report.summary.pass >= target) {
      rounds.push({ round, report, action: 'done', note: `target ${target}/${totalTasks} reached` });
      deps.onProgress?.(`   ✓ target reached — stop`);
      break;
    }
    if (round < maxRounds) {
      const proposal = await proposeImprovement(deps, report).catch(() => null);
      if (proposal) {
        const version = `auto-r${round + 1}`;
        applyPromptState({ version, rules: proposal.rules, ...(proposal.coder ? { coder: proposal.coder } : {}) });
        savePromptState(deps.dataDir);
        deps.onProgress?.(`   ✎ prompt ${version} applied — rerunning`);
      } else {
        deps.onProgress?.(`   (model proposed no valid improvement — keeping ${currentPromptVersion()})`);
      }
    }
    rounds.push({ round, report, action: prev ? action : 'baseline', note });
  }

  const last = rounds[rounds.length - 1]?.report;
  return {
    rounds,
    finalPass: last?.summary.pass ?? 0,
    total: last?.summary.total ?? totalTasks,
    finalVersion: currentPromptVersion(),
  };
}

async function runBenchProbeCount(deps: TrainDeps): Promise<number> {
  // cheap: reuse default bench task count without running them
  const { defaultBenchTasks } = await import('./bench.js');
  void deps;
  return defaultBenchTasks().length;
}

/** Persist a full training journal next to the reports. */
export async function saveTrainingJournal(dataDir: string, summary: TrainSummary): Promise<string> {
  const dir = path.join(dataDir, 'training');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `train-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify(summary, null, 2), 'utf8');
  return file;
}
