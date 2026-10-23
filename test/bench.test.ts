// test/bench.test.ts — benchmark runner mechanics with stub model (no real API)
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runBench, saveReport, latestReports, compareReports, defaultBenchTasks, type BenchTask } from '../src/bench.js';
import { PROMPT_VERSION } from '../src/prompts.js';
import { StubAdapter } from './helpers.js';
import type { ChatOptions, ChatResult } from '../src/providers.js';

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

function stubChat(): (mc: string, opts: ChatOptions) => Promise<ChatResult> {
  const stub = new StubAdapter();
  return (mc, opts) => stub.chat({ id: '', label: '', provider: 'stub', baseUrl: '', key: '', createdAt: '' }, mc, opts);
}

describe('benchmark runner', () => {
  it('has a default suite of executable tasks', () => {
    const tasks = defaultBenchTasks();
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    for (const t of tasks) {
      expect(t.verify).toBeTypeOf('function');
      expect(t.prompt.length).toBeGreaterThan(20);
    }
  });

  it('marks stub-model runs as FAIL (stub finishes without doing work — verification is real)', async () => {
    const report = await runBench({ modelConfigId: 'stub', chatFn: stubChat(), maxSteps: 4 });
    // stub calls finish immediately without creating files -> every real verify must fail
    expect(report.summary.pass).toBe(0);
    expect(report.summary.total).toBe(defaultBenchTasks().length);
    expect(report.promptVersion).toBe(PROMPT_VERSION);
  });

  it('passes when the task output is real and verification succeeds', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-bench-ok-'));
    dirs.push(dir);
    // custom one-task suite whose "work" is done in setup and verification passes trivially
    const task: BenchTask = {
      id: 'always-ok',
      title: 'verifiable task',
      prompt: 'do nothing',
      setup: async (d) => { await fs.writeFile(path.join(d, 'out.mjs'), "export const ok = true;\n"); },
      verify: async (d) => {
        const src = await fs.readFile(path.join(d, 'out.mjs'), 'utf8');
        return { ok: src.includes('ok = true'), detail: 'file present' };
      },
    };
    // stub immediately finishes; setup already wrote the artifact so verify passes
    const report = await runBench({ modelConfigId: 'stub', chatFn: stubChat(), tasks: [task], maxSteps: 4 });
    expect(report.summary.pass).toBe(1);
    expect(report.results[0].pass).toBe(true);
  });

  it('saves and reloads reports', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-bench-db-'));
    dirs.push(dataDir);
    const report = await runBench({
      modelConfigId: 'stub', chatFn: stubChat(), maxSteps: 4,
      tasks: [{ id: 't1', title: 'T', prompt: 'x', verify: async () => ({ ok: true, detail: '' }) }],
    });
    const file = await saveReport(dataDir, report);
    expect(file).toContain('benchmarks');
    const latest = await latestReports(dataDir, 1);
    expect(latest).toHaveLength(1);
    expect(latest[0].id).toBe(report.id);
  });

  it('compares two reports into improved/regressed deltas', async () => {
    const mk = (passes: Record<string, boolean>, version = 'v1') => ({
      id: `bench_${Math.random().toString(36).slice(2)}`,
      ts: new Date().toISOString(),
      modelId: 'm',
      promptVersion: version,
      results: Object.entries(passes).map(([taskId, pass]) => ({ taskId, title: taskId, pass, durationMs: 1, requests: 1, inputTokens: 1, outputTokens: 1, toolCalls: 0, detail: '' })),
      summary: { pass: Object.values(passes).filter(Boolean).length, total: Object.keys(passes).length, avgDurationMs: 1, totalTokens: 2 },
    });
    const before = mk({ t1: false, t2: true, t3: false });
    const after = mk({ t1: true, t2: true, t3: false }, 'v2');
    const { deltas, summary } = compareReports(before, after);
    expect(deltas.find((d) => d.taskId === 't1')?.delta).toBe('improved');
    expect(deltas.find((d) => d.taskId === 't2')?.delta).toBe('same-pass');
    expect(deltas.find((d) => d.taskId === 't3')?.delta).toBe('same-fail');
    expect(summary).toContain('improved 1, regressed 0');
    expect(summary).toContain('v1 → v2');
  });
});
