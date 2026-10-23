// test/store.test.ts — persistence: sessions, runs, tasks, events, interrupted-run marking
import { describe, it, expect, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Store, makeEvent, DEFAULT_BUDGET } from '../src/store.js';
import { nowIso } from '../src/core.js';

let dirs: string[] = [];

async function tmpStore(): Promise<Store> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'madw-'));
  dirs.push(dir);
  return new Store(path.join(dir, 'test.db'));
}

afterEach(async () => {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  dirs = [];
});

describe('Store', () => {
  it('roundtrips sessions with messages', async () => {
    const s = await tmpStore();
    const session = {
      id: 'ses_1', projectId: 'p1', title: 'T', mode: 'normal' as const,
      messages: [], createdAt: nowIso(), updatedAt: nowIso(),
    };
    s.saveSession(session);
    s.appendMessage('ses_1', { id: 'm1', role: 'user', content: 'hello', ts: nowIso() });
    const got = s.getSession('ses_1');
    expect(got?.messages).toHaveLength(1);
    expect(got?.messages[0]?.content).toBe('hello');
    expect(s.listSessions()).toHaveLength(1);
  });

  it('roundtrips runs and tasks', async () => {
    const s = await tmpStore();
    const run = {
      id: 'run_1', sessionId: 's1', projectId: 'p1', mode: 'turbo' as const,
      prompt: 'do it', status: 'executing' as const, modelConfigIds: ['m1', 'm2'],
      agentProfileIds: [], debate: [], reviews: [], taskIds: ['t1'],
      budget: DEFAULT_BUDGET, usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    s.saveRun(run);
    const task = {
      id: 't1', runId: 'run_1', title: 'T', description: 'D', role: 'backend' as const,
      status: 'running' as const, deps: [], files: ['a.ts'], attempts: 1,
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    s.saveTask(task);
    expect(s.getRun('run_1')?.modelConfigIds).toEqual(['m1', 'm2']);
    expect(s.listTasksByRun('run_1')).toHaveLength(1);
    expect(s.listTasksByRun('run_1')[0]?.files).toEqual(['a.ts']);
  });

  it('marks active runs interrupted on boot', async () => {
    const s = await tmpStore();
    const base = {
      sessionId: 's1', projectId: 'p1', mode: 'turbo' as const, prompt: 'x',
      modelConfigIds: ['m1', 'm2'], agentProfileIds: [], debate: [] as never[], reviews: [],
      taskIds: [], budget: DEFAULT_BUDGET, usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
      createdAt: nowIso(), updatedAt: nowIso(),
    };
    s.saveRun({ ...base, id: 'r_active', status: 'executing' });
    s.saveRun({ ...base, id: 'r_done', status: 'completed' });
    const interrupted = s.markActiveRunsInterrupted();
    expect(interrupted.map((r) => r.id)).toEqual(['r_active']);
    expect(s.getRun('r_active')?.status).toBe('interrupted');
    expect(s.getRun('r_done')?.status).toBe('completed');
  });

  it('stores and filters events', async () => {
    const s = await tmpStore();
    s.appendEvent(makeEvent('run.status', 'a', { runId: 'r1' }));
    s.appendEvent(makeEvent('run.status', 'b', { runId: 'r2' }));
    expect(s.listEvents({ runId: 'r1' })).toHaveLength(1);
    expect(s.listEvents({})).toHaveLength(2);
  });

  it('kv config roundtrip + engine states', async () => {
    const s = await tmpStore();
    expect(s.listAgentProfiles()).toEqual([]);
    s.saveAgentProfile({ id: 'a1', name: 'X', roles: ['coder'], modelConfigId: 'm', engineId: 'builtin', createdAt: nowIso() });
    expect(s.listAgentProfiles()).toHaveLength(1);
    s.setEngineState('opencode', false);
    expect(s.listEngineStates()['opencode']).toEqual({ enabled: false });
  });
});
