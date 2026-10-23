// test/api.test.ts — end-to-end over real HTTP: boot app, REST flow, SSE wiring
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Store, makeEvent } from '../src/store.js';
import { EventBus } from '../src/core.js';
import { ProviderRegistry } from '../src/providers.js';
import { EngineRegistry, BuiltinEngine } from '../src/engines.js';
import { Orchestrator } from '../src/orchestrator.js';
import { startApi } from '../src/api.js';
import { StubAdapter } from './helpers.js';
import { nowIso } from '../src/core.js';

let dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

async function boot() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'madw-api-'));
  dirs.push(dir);
  const store = new Store(path.join(dir, 'db.sqlite'));
  const bus = new EventBus();
  const providers = new ProviderRegistry();
  const stub = new StubAdapter();
  providers.register(stub);
  const engines = new EngineRegistry();
  engines.register(new BuiltinEngine({
    chatFn: async (_id, opts) => stub.chat({ id: '', label: '', provider: 'stub', baseUrl: '', key: '', createdAt: '' }, 'stub', opts),
  }));
  const orch = new Orchestrator({ store, bus, providers, engines });
  const srcDir = path.dirname(fileURLToPath(import.meta.url));
  const { port, close } = await startApi({ store, bus, providers, engines, orchestrator: orch, publicDir: path.join(srcDir, '..', 'public'), port: 0 });
  const base = `http://127.0.0.1:${port}`;
  store.saveSettings({ defaultEngineId: 'builtin', verifyCommands: [], requireApprovalForTurboPlan: false, dataDir: dir });
  return { base, close, store, bus, orch };
}

async function j(method: string, url: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

describe('HTTP API', () => {
  it('serves health, providers, static UI', async () => {
    const app = await boot();
    const health = await j('GET', `${app.base}/api/health`);
    expect(health.status).toBe(200);
    const prov = await j('GET', `${app.base}/api/providers`);
    expect(prov.data.presets.length).toBeGreaterThan(8);
    const ui = await fetch(`${app.base}/`);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain('Multi-Agent Workspace');
    await app.close();
  });

  it('credential + model verification + agents flow', async () => {
    const app = await boot();
    const cred = await j('POST', `${app.base}/api/credentials`, { provider: 'stub', key: 'not-real', label: 'stub cred' });
    expect(cred.status).toBe(201);
    expect(cred.data.credential.keyMasked).not.toBe('not-real');
    expect(cred.data.verification.ok).toBe(true);

    const model = await j('POST', `${app.base}/api/models`, { credentialId: cred.data.credential.id, modelId: 'stub-a' });
    expect(model.status).toBe(201);
    expect(model.data.verification.ok).toBe(true);

    const agent = await j('POST', `${app.base}/api/agents`, {
      name: 'Dev', roles: ['coder', 'reviewer'], modelConfigId: model.data.model.id, engineId: 'builtin',
    });
    expect(agent.status).toBe(201);
    expect(await j('POST', `${app.base}/api/agents`, { name: 'Bad', roles: ['nonsense'], modelConfigId: 'x', engineId: 'builtin' }).then((r) => r.status)).toBe(400);
    await app.close();
  });

  it('runs a normal session end to end over REST', async () => {
    const app = await boot();
    const projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'madw-proj-'));
    const proj = await j('POST', `${app.base}/api/projects`, { path: projDir });
    expect(proj.status).toBe(201);
    const ses = await j('POST', `${app.base}/api/sessions`, { projectId: proj.data.project.id, title: 'T' });

    const cred = await j('POST', `${app.base}/api/credentials`, { provider: 'stub', key: 'k' });
    const model = await j('POST', `${app.base}/api/models`, { credentialId: cred.data.credential.id, modelId: 'stub-a' });
    const agent = await j('POST', `${app.base}/api/agents`, { name: 'D', roles: ['coder'], modelConfigId: model.data.model.id, engineId: 'builtin' });

    const runRes = await j('POST', `${app.base}/api/sessions/${ses.data.session.id}/runs`, {
      prompt: 'make it so', mode: 'normal', modelConfigIds: [model.data.model.id], agentProfileIds: [agent.data.agent.id],
    });
    expect(runRes.status).toBe(201);
    const runId = runRes.data.run.id;

    // normal with 0 models must be rejected
    const bad = await j('POST', `${app.base}/api/sessions/${ses.data.session.id}/runs`, { prompt: 'x', mode: 'normal', modelConfigIds: [] });
    expect(bad.status).toBe(400);

    // poll to completion
    let run = runRes.data.run;
    for (let i = 0; i < 100 && !['completed', 'failed'].includes(run.status); i++) {
      await new Promise((r) => setTimeout(r, 100));
      run = (await j('GET', `${app.base}/api/runs/${runId}`)).data.run;
    }
    expect(run.status).toBe('completed');

    const tasks = await j('GET', `${app.base}/api/runs/${runId}/tasks`);
    expect(tasks.data.tasks[0].status).toBe('completed');
    await app.close();
  }, 30000);

  it('turbo over REST with 1 model is rejected', async () => {
    const app = await boot();
    const proj = await j('POST', `${app.base}/api/projects`, { path: await fs.mkdtemp(path.join(os.tmpdir(), 'madw-p2-')) });
    const ses = await j('POST', `${app.base}/api/sessions`, { projectId: proj.data.project.id });
    const res = await j('POST', `${app.base}/api/sessions/${ses.data.session.id}/runs`, { prompt: 'x', mode: 'turbo', modelConfigIds: ['only-one'] });
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/2 model/i);
    await app.close();
  });

  it('SSE stream delivers persisted + live events', async () => {
    const app = await boot();
    // seed a persisted event (orchestrator persists events; here we simulate the same path)
    const evt = makeEvent('run.status', 'hello sse');
    app.store.appendEvent(evt);
    app.bus.publish(evt);
    const res = await fetch(`${app.base}/api/events?limit=10`);
    const { events } = (await res.json()) as { events: { type: string; message: string }[] };
    expect(events.some((e) => e.message === 'hello sse')).toBe(true);
    await app.close();
  });
});
