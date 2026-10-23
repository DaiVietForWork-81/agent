// src/bench.ts — Orbit benchmark harness (the honest "training" loop):
// run a fixed task suite against a model -> verify outputs by EXECUTING them ->
// save reports with prompt version -> compare before/after when prompts change.
// No fine-tuning theater: this measures agent behavior, it does not touch model weights.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { BuiltinEngine } from './engines.js';
import { currentPromptVersion } from './prompts.js';
import type { EngineEvent } from './engines.js';
import type { Permissions } from './tools.js';
import { runCommand } from './tools.js';
import { newId, nowIso } from './core.js';
import type { ChatOptions, ChatResult } from './providers.js';

export interface BenchTask {
  id: string;
  title: string;
  prompt: string;
  setup?: (dir: string) => Promise<void>;
  verify: (dir: string) => Promise<{ ok: boolean; detail: string }>;
}

export interface BenchResult {
  taskId: string;
  title: string;
  pass: boolean;
  durationMs: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  detail: string;
  error?: string;
}

export interface BenchReport {
  id: string;
  ts: string;
  modelId: string;
  promptVersion: string;
  results: BenchResult[];
  summary: { pass: number; total: number; avgDurationMs: number; totalTokens: number };
}

export const BENCH_TIMEOUT_MS = 5 * 60_000;

const BUILD_PERMS: Permissions = {
  allowRead: true, allowWrite: true, allowDelete: true,
  allowShell: 'safe', allowNetworkTools: false, workspaceOnly: true,
};

async function runNode(code: string, cwd: string, timeoutMs = 30_000): Promise<{ ok: boolean; out: string }> {
  // cmd.exe cắt cụt code trong `node -e "..."` trên Windows — ghi file tạm rồi chạy
  const file = path.join(cwd, `.orbit-verify-${Date.now().toString(36)}.mjs`);
  await fs.writeFile(file, code, 'utf8');
  try {
    const res = await runCommand(`node ${path.basename(file)}`, cwd, timeoutMs);
    return { ok: res.ok, out: `${res.stdout}${res.stderr}`.trim() };
  } finally {
    await fs.rm(file, { force: true }).catch(() => {});
  }
}

/** The default verifiable suite. Every task is checked by executing the produced code. */
export function defaultBenchTasks(): BenchTask[] {
  return [
    {
      id: 'create-function',
      title: 'Create utils.mjs exporting add(a,b)',
      prompt: "Create a file utils.mjs in the workspace that exports a function add(a, b) returning the sum of two numbers. Then call finish.",
      verify: async (dir) => {
        const r = await runNode("import('./utils.mjs').then(m => { if (m.add(2,3) !== 5) throw new Error('bad'); console.log('PASS'); })", dir);
        return { ok: r.ok && r.out.includes('PASS'), detail: r.out.slice(0, 200) };
      },
    },
    {
      id: 'fix-bug',
      title: 'Fix off-by-one in buggy.mjs',
      prompt: "The file buggy.mjs contains a function sumTo(n) that should return 1+2+...+n but it is off by one (sumTo(5) currently returns 10 instead of 15). Read it, fix the bug, call finish.",
      setup: async (dir) => {
        await fs.writeFile(path.join(dir, 'buggy.mjs'), "export function sumTo(n) {\n  let s = 0;\n  for (let i = 0; i < n; i++) s += i;\n  return s;\n}\n", 'utf8');
      },
      verify: async (dir) => {
        const r = await runNode("import('./buggy.mjs').then(m => { if (m.sumTo(5) !== 15) throw new Error('still wrong: ' + m.sumTo(5)); console.log('PASS'); })", dir);
        return { ok: r.ok && r.out.includes('PASS'), detail: r.out.slice(0, 200) };
      },
    },
    {
      id: 'write-test',
      title: 'Write node --test for sum.mjs',
      prompt: "The workspace has sum.mjs exporting sum(a, b). Write a test file using node:test (node --test compatible) that checks sum(1,2)===3 and sum(-1,1)===0. Run the test with `node --test` to make sure it passes, then finish.",
      setup: async (dir) => {
        await fs.writeFile(path.join(dir, 'sum.mjs'), "export function sum(a, b) {\n  return a + b;\n}\n", 'utf8');
      },
      verify: async (dir) => {
        const hasTest = await fs.readdir(dir);
        if (!hasTest.some((f) => /test/i.test(f))) return { ok: false, detail: 'no test file found' };
        const r = await runCommand('node --test', dir, 30_000);
        return { ok: r.ok, detail: `${r.stdout}${r.stderr}`.slice(0, 200) };
      },
    },
    {
      id: 'refactor-rename',
      title: 'Rename calculateTotal to computeTotal',
      prompt: "In invoice.mjs there is an exported function calculateTotal(items). Rename it to computeTotal everywhere and keep behavior identical. Call finish.",
      setup: async (dir) => {
        await fs.writeFile(path.join(dir, 'invoice.mjs'), "export function calculateTotal(items) {\n  return items.reduce((acc, it) => acc + it.price, 0);\n}\n", 'utf8');
      },
      verify: async (dir) => {
        const src = await fs.readFile(path.join(dir, 'invoice.mjs'), 'utf8').catch(() => '');
        if (src.includes('calculateTotal')) return { ok: false, detail: 'old name still present' };
        const r = await runNode("import('./invoice.mjs').then(m => { if (m.computeTotal([{price:2},{price:3}]) !== 5) throw new Error('bad'); console.log('PASS'); })", dir);
        return { ok: r.ok && r.out.includes('PASS'), detail: r.out.slice(0, 200) };
      },
    },
    {
      id: 'package-script',
      title: 'Add greet script to package.json',
      prompt: "Create a package.json in the workspace with a script named \"greet\" that prints the word HELLO when run with `npm run greet`. Run it once to confirm, then finish.",
      verify: async (dir) => {
        const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8').catch(() => '{}')) as { scripts?: Record<string, string> };
        if (!pkg.scripts?.greet) return { ok: false, detail: 'scripts.greet missing' };
        const r = await runCommand('npm run greet --silent', dir, 60_000);
        return { ok: r.ok && r.stdout.includes('HELLO'), detail: r.stdout.slice(0, 200) };
      },
    },
  ];
}

export interface BenchDeps {
  modelConfigId: string;
  chatFn: (modelConfigId: string, opts: ChatOptions) => Promise<ChatResult>;
  maxSteps?: number;
  tasks?: BenchTask[];
  onProgress?: (line: string) => void;
}

export async function runBench(deps: BenchDeps, signal?: AbortSignal): Promise<BenchReport> {
  const tasks = deps.tasks ?? defaultBenchTasks();
  const engine = new BuiltinEngine({ chatFn: deps.chatFn });
  const results: BenchResult[] = [];

  for (const task of tasks) {
    deps.onProgress?.(`▶ ${task.id}: ${task.title}`);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-bench-'));
    const started = Date.now();
    let requests = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCalls = 0;
    let error: string | undefined;
    let pass = false;
    let detail = '';

    try {
      await task.setup?.(dir);
      const usage = { requests: 0, inputTokens: 0, outputTokens: 0 };
      const wrappedChat = async (mc: string, opts: ChatOptions): Promise<ChatResult> => {
        const r = await deps.chatFn(mc, opts);
        usage.requests++;
        usage.inputTokens += r.usage?.inputTokens ?? 0;
        usage.outputTokens += r.usage?.outputTokens ?? 0;
        return r;
      };
      const benchEngine = new BuiltinEngine({ chatFn: wrappedChat });
      const onEvent = (e: EngineEvent): void => {
        if (e.type === 'tool') toolCalls++;
      };
      const timeout = new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error('bench task timeout')), BENCH_TIMEOUT_MS),
      );
      const result = await Promise.race([
        benchEngine.startTask({
          prompt: task.prompt,
          cwd: dir,
          role: 'coder',
          permissions: BUILD_PERMS,
          modelConfigId: deps.modelConfigId,
          maxSteps: deps.maxSteps ?? 16,
          onEvent,
          signal,
        }),
        timeout,
      ]);
      requests = usage.requests;
      inputTokens = usage.inputTokens;
      outputTokens = usage.outputTokens;
      if (result.failed) {
        error = result.output ?? 'engine failed';
      } else {
        const v = await task.verify(dir);
        pass = v.ok;
        detail = v.detail;
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }

    results.push({
      taskId: task.id, title: task.title, pass,
      durationMs: Date.now() - started,
      requests, inputTokens, outputTokens, toolCalls,
      detail, error,
    });
    deps.onProgress?.(pass ? `  ✓ PASS (${(Date.now() - started) / 1000}s)` : `  ✗ FAIL — ${error ?? detail}`);
  }

  const passed = results.filter((r) => r.pass);
  return {
    id: newId('bench'),
    ts: nowIso(),
    modelId: deps.modelConfigId,
    promptVersion: currentPromptVersion(),
    results,
    summary: {
      pass: passed.length,
      total: results.length,
      avgDurationMs: Math.round(results.reduce((a, r) => a + r.durationMs, 0) / Math.max(1, results.length)),
      totalTokens: results.reduce((a, r) => a + r.inputTokens + r.outputTokens, 0),
    },
  };
}

export async function saveReport(dataDir: string, report: BenchReport): Promise<string> {
  const dir = path.join(dataDir, 'benchmarks');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${report.ts.replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify(report, null, 2), 'utf8');
  return file;
}

export async function latestReports(dataDir: string, n = 2): Promise<BenchReport[]> {
  const dir = path.join(dataDir, 'benchmarks');
  let files: string[] = [];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return [];
  }
  const out: BenchReport[] = [];
  for (const f of files.slice(0, n)) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(dir, f), 'utf8')) as BenchReport);
    } catch { /* skip */ }
  }
  return out;
}

export interface BenchDelta {
  taskId: string;
  before: boolean;
  after: boolean;
  delta: 'improved' | 'regressed' | 'same-pass' | 'same-fail';
}

export function compareReports(before: BenchReport, after: BenchReport): { deltas: BenchDelta[]; summary: string } {
  const deltas: BenchDelta[] = [];
  for (const r of after.results) {
    const prev = before.results.find((x) => x.taskId === r.taskId);
    const b = prev?.pass ?? false;
    const delta: BenchDelta['delta'] = !b && r.pass ? 'improved' : b && !r.pass ? 'regressed' : r.pass ? 'same-pass' : 'same-fail';
    deltas.push({ taskId: r.taskId, before: b, after: r.pass, delta });
  }
  const improved = deltas.filter((d) => d.delta === 'improved').length;
  const regressed = deltas.filter((d) => d.delta === 'regressed').length;
  const summary = `${before.summary.pass}/${before.summary.total} → ${after.summary.pass}/${after.summary.total} (improved ${improved}, regressed ${regressed}, prompt ${before.promptVersion} → ${after.promptVersion})`;
  return { deltas, summary };
}
