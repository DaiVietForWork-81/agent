// test/turbo.test.ts — full Turbo orchestration with stub models (deterministic, no real API)
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store, DEFAULT_BUDGET, makeEvent } from '../src/store.js';
import { EventBus } from '../src/core.js';
import { ProviderRegistry } from '../src/providers.js';
import { EngineRegistry, BuiltinEngine } from '../src/engines.js';
import { Orchestrator } from '../src/orchestrator.js';
import { StubAdapter } from './helpers.js';
import { nowIso } from '../src/core.js';
import type { Run } from '../src/store.js';

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

interface TestApp { store: Store; orch: Orchestrator; events: { type: string; message: string }[] }

async function makeApp(): Promise<TestApp> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'madw-app-'));
  dirs.push(dir);
  const store = new Store(path.join(dir, 'db.sqlite'));
  const bus = new EventBus();
  const providers = new ProviderRegistry();
  const stub = new StubAdapter();
  providers.register(stub);
  const engines = new EngineRegistry();
  engines.register(new BuiltinEngine({
    chatFn: async (_modelConfigId, opts) => stub.chat({ id: 'x', label: '', provider: 'stub', baseUrl: '', key: '', createdAt: '' }, 'stub', opts),
  }));

  const events: { type: string; message: string }[] = [];
  bus.subscribe((e) => events.push({ type: e.type, message: e.message }));

  const orch = new Orchestrator({ store, bus, providers, engines });

  // fixtures: project + credential + 2 models + 1 agent
  store.saveProject({ id: 'p1', name: 'proj', path: dir, createdAt: nowIso() });
  store.saveCredential({ id: 'cred1', label: 'stub', provider: 'stub', baseUrl: 'http://stub', key: 'not-a-real-key', createdAt: nowIso() });
  store.saveModelConfig({ id: 'mc1', credentialId: 'cred1', modelId: 'stub-a', createdAt: nowIso() });
  store.saveModelConfig({ id: 'mc2', credentialId: 'cred1', modelId: 'stub-b', createdAt: nowIso() });
  store.saveAgentProfile({ id: 'agent1', name: 'Team', roles: ['coder', 'reviewer', 'tester', 'backend'], modelConfigId: 'mc1', engineId: 'builtin', createdAt: nowIso() });
  store.saveSession({ id: 's1', projectId: 'p1', title: 'S', mode: 'turbo', messages: [], createdAt: nowIso(), updatedAt: nowIso() });
  store.saveSettings({ defaultEngineId: 'builtin', verifyCommands: [], requireApprovalForTurboPlan: false, dataDir: dir });
  return { store, orch, events };
}

function waitRun(store: Store, runId: string, statuses: string[], timeoutMs = 15000): Promise<Run> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const t = setInterval(() => {
      const run = store.getRun(runId);
      if (!run) return;
      if (statuses.includes(run.status)) {
        clearInterval(t);
        resolve(run);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(t);
        reject(new Error(`run stuck in ${run.status}: ${run.error ?? ''}`));
      }
    }, 100);
  });
}

describe('Turbo orchestration', () => {
  it('refuses to start with fewer than 2 models', async () => {
    const { store, orch } = await makeApp();
    const session = store.getSession('s1')!;
    const run = orch.startRun({ session, prompt: 'x', mode: 'turbo', modelConfigIds: ['mc1'], agentProfileIds: ['agent1'] });
    expect(run.status).toBe('failed');
    expect(run.error).toMatch(/at least 2/i);
  });

  it('runs full pipeline: analysis -> debate -> plan -> DAG -> review -> completed', async () => {
    const { store, orch, events } = await makeApp();
    const session = store.getSession('s1')!;
    const run0 = orch.startRun({ session, prompt: 'build util + tests', mode: 'turbo', modelConfigIds: ['mc1', 'mc2'], agentProfileIds: ['agent1'] });
    expect(['queued', 'analyzing', 'debating']).toContain(run0.status);

    const run = await waitRun(store, run0.id, ['completed', 'failed']);
    expect(run.status).toBe('completed');

    // debate recorded: 1 analysis + 2 proposals + 2 critiques (maxDebateRounds=2)
    expect(run.debate.filter((d) => d.kind === 'analysis')).toHaveLength(1);
    expect(run.debate.filter((d) => d.kind === 'proposal')).toHaveLength(2);
    expect(run.debate.filter((d) => d.kind === 'critique')).toHaveLength(2);

    // plan parsed and persisted
    expect(run.plan?.goal).toBe('build the thing');
    expect(run.plan?.tasks).toHaveLength(2);

    // tasks executed along DAG, both completed
    const tasks = store.listTasksByRun(run.id);
    expect(tasks).toHaveLength(2);
    expect(tasks.every((t) => t.status === 'completed')).toBe(true);
    const t2 = tasks.find((t) => t.title === 'Add tests');
    expect(t2?.deps).toEqual([tasks.find((t) => t.title === 'Implement util')?.id]);

    // review passed
    expect(run.reviews.length).toBeGreaterThanOrEqual(1);
    expect(run.reviews[run.reviews.length - 1]?.verdict).toBe('pass');

    // events emitted for stages
    const types = new Set(events.map((e) => e.type));
    expect(types.has('turbo.analysis')).toBe(true);
    expect(types.has('turbo.plan')).toBe(true);
    expect(types.has('task.status')).toBe(true);
    expect(types.has('turbo.review')).toBe(true);
  }, 30000);

  it('usage accounting counts requests', async () => {
    const { store, orch } = await makeApp();
    const session = store.getSession('s1')!;
    const run0 = orch.startRun({ session, prompt: 'count me', mode: 'turbo', modelConfigIds: ['mc1', 'mc2'], agentProfileIds: ['agent1'] });
    const run = await waitRun(store, run0.id, ['completed', 'failed']);
    expect(run.usage.requests).toBeGreaterThanOrEqual(6); // 1 analysis + 2 proposals + 2 critiques + 1 synth + 1 review (+2 task loops)
    expect(run.usage.inputTokens).toBeGreaterThan(0);
  }, 30000);
});

describe('Normal orchestration', () => {
  it('runs a single model and completes', async () => {
    const { store, orch } = await makeApp();
    const session = store.getSession('s1')!;
    const run0 = orch.startRun({ session, prompt: 'fix bug', mode: 'normal', modelConfigIds: ['mc1'], agentProfileIds: ['agent1'] });
    const run = await waitRun(store, run0.id, ['completed', 'failed']);
    expect(run.status).toBe('completed');
    const tasks = store.listTasksByRun(run.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.status).toBe('completed');
    expect(tasks[0]?.result?.summary).toContain('done by');
    // assistant message appended to session
    const sess = store.getSession('s1')!;
    expect(sess.messages.some((m) => m.role === 'assistant')).toBe(true);
  }, 30000);
});

describe('run resume', () => {
  it('marks nothing to resume for completed runs', async () => {
    const { store, orch } = await makeApp();
    const session = store.getSession('s1')!;
    const run0 = orch.startRun({ session, prompt: 'x', mode: 'normal', modelConfigIds: ['mc1'], agentProfileIds: ['agent1'] });
    await waitRun(store, run0.id, ['completed']);
    const resumed = await orch.resumeRun(run0.id);
    expect(resumed?.status).toBe('completed');
  }, 30000);
});
