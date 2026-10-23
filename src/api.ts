// src/api.ts — HTTP API: REST + SSE. No framework, node:http only.
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { nowIso, newId, redactDeep } from './core.js';
import { EventBus } from './core.js';
import type { Store, WorkspaceEvent, Session, Run, Project, AgentProfile, ModelConfig, Credential } from './store.js';
import { ROLES } from './store.js';
import type { ProviderRegistry } from './providers.js';
import { publicCredential, ProviderError, verifyModelInference } from './providers.js';
import type { EngineRegistry } from './engines.js';
import type { Orchestrator } from './orchestrator.js';
import { listThemeFiles, getThemeFile, generateThemeCss } from './theme.js';
import { searchSkills, recordUsage } from './skillstore.js';

interface ApiDeps {
  store: Store;
  bus: EventBus<WorkspaceEvent>;
  providers: ProviderRegistry;
  engines: EngineRegistry;
  orchestrator: Orchestrator;
  publicDir: string;
  port: number;
}

const MAX_BODY = 10 * 1024 * 1024;

export function startApi(deps: ApiDeps): Promise<{ close: () => void; port: number }> {
  const sseClients = new Set<{ runId: string | null; res: ServerResponse }>();

  const unsub = deps.bus.subscribe((evt) => {
    for (const client of sseClients) {
      if (client.runId && evt.runId !== client.runId) continue;
      try {
        client.res.write(`data: ${JSON.stringify(redactDeep(evt))}\n\n`);
      } catch {
        sseClients.delete(client);
      }
    }
  });

  const server = createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (e) {
      json(res, 500, { error: (e as Error).message });
    }
  });

  function json(res: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(redactDeep(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(payload);
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) throw new Error('body too large');
      chunks.push(chunk as Buffer);
    }
    if (chunks.length === 0) return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://localhost:${deps.port}`);
    const p = url.pathname;
    const method = req.method ?? 'GET';
    const body = method === 'POST' || method === 'PUT' ? await readBody(req) : {};
    const seg = p.split('/').filter(Boolean);

    // ---------- static UI ----------
    if (method === 'GET' && !p.startsWith('/api/')) {
      return serveStatic(p, res);
    }

    // ---------- health ----------
    if (method === 'GET' && p === '/api/health') return json(res, 200, { ok: true, ts: nowIso() });

    // ---------- providers ----------
    if (method === 'GET' && p === '/api/providers') {
      return json(res, 200, { presets: deps.providers.listPresets(), adapters: deps.providers.listAdapters() });
    }

    // ---------- credentials ----------
    if (method === 'GET' && p === '/api/credentials') {
      return json(res, 200, { credentials: deps.store.listCredentials().map(publicCredential) });
    }
    if (method === 'POST' && p === '/api/credentials') {
      const { provider, label, baseUrl, key } = body as { provider?: string; label?: string; baseUrl?: string; key?: string };
      if (!provider || !key) return json(res, 400, { error: 'provider and key are required' });
      const preset = deps.providers.listPresets().find((x) => x.id === provider);
      const adapterExists = deps.providers.listAdapters().some((a) => a.id === provider);
      if (!preset && !adapterExists) return json(res, 400, { error: `unknown provider '${provider}'` });
      const cred: Credential = {
        id: newId('cred'),
        label: label || preset?.label || provider,
        provider,
        baseUrl: (baseUrl || preset?.defaultBaseUrl || 'http://localhost:8000/v1').replace(/\/+$/, ''),
        key: key,
        createdAt: nowIso(),
      };
      const adapter = deps.providers.adapterForCredential(cred);
      const verify = await adapter.verifyCredential(cred, 15_000);
      deps.store.saveCredential(cred);
      return json(res, verify.ok ? 201 : 201, { credential: publicCredential(cred), verification: verify });
    }
    if (method === 'DELETE' && seg[0] === 'api' && seg[1] === 'credentials' && seg[2]) {
      deps.store.deleteCredential(seg[2]);
      // cascade: remove model configs bound to this credential
      for (const m of deps.store.listModelConfigs().filter((x) => x.credentialId === seg[2])) {
        deps.store.deleteModelConfig(m.id);
      }
      return json(res, 200, { ok: true });
    }

    // ---------- model configs ----------
    if (method === 'GET' && p === '/api/models') {
      return json(res, 200, { models: deps.store.listModelConfigs() });
    }
    if (method === 'POST' && p === '/api/models') {
      const { credentialId, modelId } = body as { credentialId?: string; modelId?: string };
      if (!credentialId || !modelId) return json(res, 400, { error: 'credentialId and modelId required' });
      const cred = deps.store.listCredentials().find((c) => c.id === credentialId);
      if (!cred) return json(res, 404, { error: 'credential not found' });
      const adapter = deps.providers.adapterForCredential(cred);
      const inf = await verifyModelInference(adapter, cred, modelId, 30_000);
      const mc: ModelConfig = {
        id: newId('mcfg'),
        credentialId,
        modelId,
        displayName: modelId,
        verification: {
          modelId,
          verifiedAt: nowIso(),
          authOk: true,
          inferenceOk: inf.ok,
          caps: { inference: { status: inf.ok ? 'supported' : 'unsupported', detail: inf.error } },
        },
        createdAt: nowIso(),
      };
      deps.store.saveModelConfig(mc);
      return json(res, 201, { model: mc, verification: inf });
    }
    if (method === 'POST' && seg[0] === 'api' && seg[1] === 'models' && seg[3] === 'verify' && seg[2]) {
      const mc = deps.store.listModelConfigs().find((m) => m.id === seg[2]);
      if (!mc) return json(res, 404, { error: 'model config not found' });
      const cred = deps.store.listCredentials().find((c) => c.id === mc.credentialId);
      if (!cred) return json(res, 404, { error: 'credential not found' });
      const adapter = deps.providers.adapterForCredential(cred);
      const inf = await verifyModelInference(adapter, cred, mc.modelId, 30_000);
      mc.verification = { ...mc.verification, modelId: mc.modelId, verifiedAt: nowIso(), authOk: true, inferenceOk: inf.ok, caps: mc.verification?.caps ?? {} };
      deps.store.saveModelConfig(mc);
      return json(res, 200, { model: mc, verification: inf });
    }
    if (method === 'DELETE' && seg[0] === 'api' && seg[1] === 'models' && seg[2]) {
      deps.store.deleteModelConfig(seg[2]);
      return json(res, 200, { ok: true });
    }

    // ---------- agent profiles ----------
    if (method === 'GET' && p === '/api/agents') {
      return json(res, 200, { agents: deps.store.listAgentProfiles() });
    }
    if (method === 'POST' && p === '/api/agents') {
      const { name, roles, modelConfigId, engineId } = body as { name?: string; roles?: string[]; modelConfigId?: string; engineId?: string };
      if (!name || !modelConfigId || !engineId) return json(res, 400, { error: 'name, modelConfigId, engineId required' });
      const validRoles = (roles ?? []).filter((r): r is AgentProfile['roles'][number] => (ROLES as string[]).includes(r));
      if (validRoles.length === 0) return json(res, 400, { error: `at least one valid role required (${ROLES.join(', ')})` });
      const agent: AgentProfile = { id: newId('agent'), name, roles: validRoles, modelConfigId, engineId, createdAt: nowIso() };
      deps.store.saveAgentProfile(agent);
      return json(res, 201, { agent });
    }
    if (method === 'DELETE' && seg[0] === 'api' && seg[1] === 'agents' && seg[2]) {
      deps.store.deleteAgentProfile(seg[2]);
      return json(res, 200, { ok: true });
    }

    // ---------- engines ----------
    if (method === 'GET' && p === '/api/engines') {
      const statuses = await deps.engines.statusAll(deps.store.listEngineStates());
      return json(res, 200, { engines: statuses });
    }
    if (method === 'POST' && seg[0] === 'api' && seg[1] === 'engines' && seg[3] === 'toggle' && seg[2]) {
      const { enabled } = body as { enabled?: boolean };
      deps.store.setEngineState(seg[2], Boolean(enabled));
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && seg[0] === 'api' && seg[1] === 'engines' && seg[3] === 'validate' && seg[2]) {
      const engine = deps.engines.get(seg[2]);
      if (!engine) return json(res, 404, { error: 'engine not found' });
      return json(res, 200, await engine.validate());
    }

    // ---------- projects ----------
    if (method === 'GET' && p === '/api/projects') {
      return json(res, 200, { projects: deps.store.listProjects() });
    }
    if (method === 'POST' && p === '/api/projects') {
      const { path: projectPath, name } = body as { path?: string; name?: string };
      if (!projectPath) return json(res, 400, { error: 'path required' });
      try {
        const st = await fs.stat(projectPath);
        if (!st.isDirectory()) return json(res, 400, { error: 'path is not a directory' });
      } catch {
        return json(res, 400, { error: 'path does not exist' });
      }
      const project: Project = { id: newId('proj'), name: name || path.basename(projectPath), path: path.resolve(projectPath), createdAt: nowIso() };
      deps.store.saveProject(project);
      return json(res, 201, { project });
    }
    if (method === 'DELETE' && seg[0] === 'api' && seg[1] === 'projects' && seg[2]) {
      deps.store.deleteProject(seg[2]);
      return json(res, 200, { ok: true });
    }
    if (method === 'GET' && seg[0] === 'api' && seg[1] === 'projects' && seg[3] === 'git' && seg[4] === 'status' && seg[2]) {
      const project = deps.store.listProjects().find((x) => x.id === seg[2]);
      if (!project) return json(res, 404, { error: 'project not found' });
      const { gitStatus } = await import('./tools.js');
      return json(res, 200, await gitStatus(project.path));
    }
    if (method === 'GET' && seg[0] === 'api' && seg[1] === 'projects' && seg[3] === 'git' && seg[4] === 'diff' && seg[2]) {
      const project = deps.store.listProjects().find((x) => x.id === seg[2]);
      if (!project) return json(res, 404, { error: 'project not found' });
      const { gitDiff } = await import('./tools.js');
      return json(res, 200, { diff: await gitDiff(project.path) });
    }

    // ---------- sessions ----------
    if (method === 'GET' && p === '/api/sessions') {
      return json(res, 200, { sessions: deps.store.listSessions() });
    }
    if (method === 'POST' && p === '/api/sessions') {
      const { projectId, title, mode } = body as { projectId?: string; title?: string; mode?: Session['mode'] };
      if (!projectId) return json(res, 400, { error: 'projectId required' });
      const session: Session = {
        id: newId('ses'),
        projectId,
        title: title || 'New session',
        mode: mode === 'turbo' ? 'turbo' : 'normal',
        messages: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      deps.store.saveSession(session);
      return json(res, 201, { session });
    }
    if (method === 'GET' && seg[0] === 'api' && seg[1] === 'sessions' && seg[2] && !seg[3]) {
      const session = deps.store.getSession(seg[2]);
      return session ? json(res, 200, { session }) : json(res, 404, { error: 'session not found' });
    }
    if (method === 'DELETE' && seg[0] === 'api' && seg[1] === 'sessions' && seg[2]) {
      deps.store.deleteSession(seg[2]);
      return json(res, 200, { ok: true });
    }

    // ---------- runs ----------
    if (method === 'POST' && seg[0] === 'api' && seg[1] === 'sessions' && seg[3] === 'runs' && seg[2]) {
      const session = deps.store.getSession(seg[2]);
      if (!session) return json(res, 404, { error: 'session not found' });
      const { prompt, mode, modelConfigIds, agentProfileIds, budget } = body as {
        prompt?: string; mode?: 'normal' | 'turbo'; modelConfigIds?: string[]; agentProfileIds?: string[];
        budget?: Partial<Run['budget']>;
      };
      if (!prompt) return json(res, 400, { error: 'prompt required' });
      const runMode = mode ?? session.mode;
      const models = modelConfigIds ?? [];
      if (runMode === 'normal' && models.length !== 1) return json(res, 400, { error: 'normal mode requires exactly 1 modelConfigId' });
      if (runMode === 'turbo' && models.length < 2) return json(res, 400, { error: 'turbo mode requires >= 2 modelConfigIds' });
      const run = deps.orchestrator.startRun({ session, prompt, mode: runMode, modelConfigIds: models, agentProfileIds: agentProfileIds ?? [], budget });
      return json(res, 201, { run });
    }
    if (method === 'GET' && p === '/api/runs') {
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      return json(res, 200, { runs: deps.store.listRuns(sessionId) });
    }
    if (method === 'GET' && seg[0] === 'api' && seg[1] === 'runs' && seg[2] && !seg[3]) {
      const run = deps.store.getRun(seg[2]);
      return run ? json(res, 200, { run }) : json(res, 404, { error: 'run not found' });
    }
    if (method === 'GET' && seg[0] === 'api' && seg[1] === 'runs' && seg[3] === 'tasks' && seg[2]) {
      return json(res, 200, { tasks: deps.store.listTasksByRun(seg[2]) });
    }
    if (method === 'POST' && seg[0] === 'api' && seg[1] === 'runs' && seg[3] === 'cancel' && seg[2]) {
      const ok = deps.orchestrator.cancelRun(seg[2]);
      return json(res, ok ? 200 : 409, { ok, note: ok ? 'cancellation signal sent' : 'run is not active in this process' });
    }
    if (method === 'POST' && seg[0] === 'api' && seg[1] === 'runs' && seg[3] === 'resume' && seg[2]) {
      const run = await deps.orchestrator.resumeRun(seg[2]);
      return run ? json(res, 200, { run }) : json(res, 404, { error: 'run not found or not resumable' });
    }
    if (method === 'POST' && seg[0] === 'api' && seg[1] === 'runs' && seg[3] === 'approve' && seg[2]) {
      const run = await deps.orchestrator.resumeRun(seg[2]);
      return run ? json(res, 200, { run }) : json(res, 404, { error: 'run not found or not awaiting approval' });
    }
    if (method === 'GET' && seg[0] === 'api' && seg[1] === 'runs' && seg[3] === 'events' && seg[2]) {
      // SSE
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(`data: ${JSON.stringify({ type: 'connected', runId: seg[2], ts: nowIso() })}\n\n`);
      const client = { runId: seg[2], res };
      sseClients.add(client);
      req.on('close', () => sseClients.delete(client));
      return;
    }

    // ---------- events ----------
    if (method === 'GET' && p === '/api/events') {
      const runId = url.searchParams.get('runId') ?? undefined;
      const sessionId = url.searchParams.get('sessionId') ?? undefined;
      const limit = Number(url.searchParams.get('limit') ?? 200);
      return json(res, 200, { events: deps.store.listEvents({ runId, sessionId, limit }) });
    }

    // ---------- theme ----------
    if (method === 'GET' && p === '/api/themes') {
      const themes = await listThemeFiles();
      return json(res, 200, {
        themes: themes.map((t) => ({ id: t.id, label: t.name, dark: Boolean(t.dark) })),
        current: deps.store.getSettings().theme,
      });
    }
    if (method === 'GET' && p === '/api/theme.css') {
      const file = await getThemeFile(deps.store.getSettings().theme);
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(file ? generateThemeCss(file) : '/* no theme */');
      return;
    }

    // ---------- skill store ----------
    if (method === 'GET' && p === '/api/skills') {
      const q = url.searchParams.get('q') ?? '';
      const limit = Number(url.searchParams.get('limit') ?? 5);
      const results = await searchSkills(q, limit);
      return json(res, 200, { skills: results });
    }
    if (method === 'POST' && seg[0] === 'api' && seg[1] === 'skills' && seg[3] === 'usage' && seg[2]) {
      const outcome = (body as { outcome?: string }).outcome === 'good' ? 'good' : 'bad';
      return json(res, 200, recordUsage(seg[2], outcome));
    }

    // ---------- settings ----------
    if (method === 'GET' && p === '/api/settings') {
      return json(res, 200, { settings: deps.store.getSettings() });
    }
    if (method === 'PUT' && p === '/api/settings') {
      const current = deps.store.getSettings();
      const next = { ...current, ...(body as Partial<typeof current>) };
      deps.store.saveSettings(next);
      return json(res, 200, { settings: next });
    }

    // ---------- session rename ----------
    if (method === 'PUT' && seg[0] === 'api' && seg[1] === 'sessions' && seg[2] && !seg[3]) {
      const session = deps.store.getSession(seg[2]);
      if (!session) return json(res, 404, { error: 'session not found' });
      const { title } = body as { title?: string };
      if (title?.trim()) {
        session.title = title.trim();
        session.updatedAt = nowIso();
        deps.store.saveSession(session);
      }
      return json(res, 200, { session });
    }

    return json(res, 404, { error: `no route: ${method} ${p}` });
  }

  const MIME: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
  };

  async function serveStatic(p: string, res: ServerResponse): Promise<void> {
    let rel = p === '/' ? '/index.html' : p;
    const file = path.join(deps.publicDir, rel);
    try {
      const data = await fs.readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      // SPA fallback
      try {
        const data = await fs.readFile(path.join(deps.publicDir, 'index.html'));
        res.writeHead(200, { 'content-type': MIME['.html'] });
        res.end(data);
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
      }
    }
  }

  return new Promise((resolve) => {
    server.listen(deps.port, () => {
      const addr = server.address() as { port: number };
      resolve({
        close: () => {
          unsub();
          server.close();
        },
        port: addr.port ?? deps.port,
      });
    });
  });
}

export function apiErrorCode(e: unknown): number {
  if (e instanceof ProviderError) {
    if (e.kind === 'auth') return 401;
    if (e.kind === 'not_found') return 404;
    if (e.kind === 'rate_limit') return 429;
    return 502;
  }
  return 500;
}
