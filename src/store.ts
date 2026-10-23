// src/store.ts — persistence on node:sqlite. Config blobs, sessions, runs, tasks, events.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { nowIso, newId, redactDeep } from './core.js';

// ---------- Domain types ----------

export type Role = 'planner' | 'architect' | 'backend' | 'frontend' | 'designer' | 'tester' | 'reviewer' | 'researcher' | 'coder';
export const ROLES: Role[] = ['planner', 'architect', 'backend', 'frontend', 'designer', 'tester', 'reviewer', 'researcher', 'coder'];

export interface Credential {
  id: string;
  label: string;
  provider: string; // catalog id, e.g. 'openai-compat', 'anthropic', 'nvidia', 'ollama', 'custom'
  baseUrl: string;
  key: string;      // stored locally, never returned by the API (only masked)
  createdAt: string;
}

export interface CapabilityValue { status: 'supported' | 'unsupported' | 'partial' | 'unknown'; detail?: string }

export interface ModelVerification {
  modelId: string;
  verifiedAt: string;
  authOk: boolean;
  inferenceOk: boolean;
  caps: Record<string, CapabilityValue>;
}

export interface ModelConfig {
  id: string;
  credentialId: string;
  modelId: string;
  displayName?: string;
  verification?: ModelVerification;
  params?: Record<string, unknown>; // temperature, max_tokens, ...
  createdAt: string;
}

export interface AgentProfile {
  id: string;
  name: string;
  roles: Role[];
  modelConfigId: string;
  engineId: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool' | 'event';
  content: string;
  agentId?: string;
  modelConfigId?: string;
  meta?: Record<string, unknown>;
  ts: string;
}

export interface Session {
  id: string;
  projectId: string;
  title: string;
  mode: 'normal' | 'turbo';
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

export const TASK_STATUSES = [
  'queued', 'planning', 'awaiting_approval', 'running', 'waiting_dependency',
  'reviewing', 'integrating', 'testing', 'retrying', 'paused',
  'completed', 'failed', 'cancelled',
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface TaskResult {
  summary?: string;
  files?: string[];
  output?: string;
  gitDiff?: string;
  verdict?: 'pass' | 'fail';
  findings?: string[];
}

export interface Task {
  id: string;
  runId: string;
  title: string;
  description: string;
  role: Role;
  agentId?: string;
  modelConfigId?: string;
  status: TaskStatus;
  deps: string[];
  files: string[];       // declared files this task may touch (isolation locks)
  attempts: number;
  result?: TaskResult;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DebateEntry {
  round: number;
  kind: 'proposal' | 'critique' | 'analysis' | 'synthesis';
  modelConfigId: string;
  content: string; // raw JSON or text
  ts: string;
}

export interface PlanTaskSpec {
  id: string;
  title: string;
  description: string;
  role: Role;
  deps: string[];
  files?: string[];
}

export interface ExecutionPlan {
  goal: string;
  constraints: string[];
  acceptance: string[];
  consensus: string[];
  unresolved: string[];
  tasks: PlanTaskSpec[];
}

export interface ReviewRound {
  round: number;
  reviewerModelConfigId: string;
  verdict: 'pass' | 'fail';
  findings: string[];
  ts: string;
}

export interface Budget {
  maxDebateRounds: number;   // default 2
  maxRepairRounds: number;   // default 2
  maxConcurrency: number;    // default 3
  maxStepsPerTask: number;   // default 16
  requestTimeoutMs: number;  // default 120_000
  maxRetriesPerTask: number; // default 1
}

export const DEFAULT_BUDGET: Budget = {
  maxDebateRounds: 2,
  maxRepairRounds: 2,
  maxConcurrency: 3,
  maxStepsPerTask: 16,
  requestTimeoutMs: 120_000,
  maxRetriesPerTask: 1,
};

export const RUN_STATUSES = [
  'queued', 'analyzing', 'debating', 'awaiting_approval', 'executing',
  'reviewing', 'integrating', 'completed', 'failed', 'cancelled', 'interrupted',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export interface TestReport {
  commands: { cmd: string; ok: boolean; output: string; durationMs: number }[];
  at: string;
}

export interface Run {
  id: string;
  sessionId: string;
  projectId: string;
  mode: 'normal' | 'turbo';
  prompt: string;
  status: RunStatus;
  modelConfigIds: string[];  // models participating
  agentProfileIds: string[];
  plan?: ExecutionPlan;
  debate: DebateEntry[];
  reviews: ReviewRound[];
  testReport?: TestReport;
  taskIds: string[];
  budget: Budget;
  usage: { requests: number; inputTokens: number; outputTokens: number };
  toolFilter?: string[];
  permissions?: {
    allowRead: boolean;
    allowWrite: boolean;
    allowDelete: boolean;
    allowShell: 'none' | 'safe' | 'all';
    allowNetworkTools: boolean;
    workspaceOnly: boolean;
  };
  checkpoint?: { head: string; stashRef?: string; untracked?: string[] };
  error?: string;
  needsApproval?: { reason: string; createdAt: string };
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceEvent {
  id: string;
  runId?: string;
  sessionId?: string;
  taskId?: string;
  agentId?: string;
  modelConfigId?: string;
  type: string;
  status?: string;
  message: string;
  data?: unknown;
  ts: string;
}

export interface Settings {
  theme: string;
  defaultEngineId: string;
  verifyCommands: string[];      // e.g. ['npm test'] run during integration
  requireApprovalForTurboPlan: boolean;
  dataDir: string;
}

// ---------- Store ----------

export class Store {
  private db: DatabaseSync;

  constructor(dbFile: string) {
    mkdirSync(dirname(dbFile), { recursive: true });
    this.db = new DatabaseSync(dbFile);
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        messages TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        session_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        ts TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_run ON tasks(run_id);
    `);
  }

  // ---- kv (config + secrets blob) ----
  getKV<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT v FROM kv WHERE k = ?').get(key) as { v: string } | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.v) as T;
    } catch {
      return fallback;
    }
  }

  setKV(key: string, value: unknown): void {
    this.db.prepare(
      'INSERT INTO kv (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at',
    ).run(key, JSON.stringify(value), nowIso());
  }

  // ---- credentials / model configs / agents / projects / settings (kv-backed, single-writer) ----
  listCredentials(): Credential[] { return this.getKV<Credential[]>('credentials', []); }
  saveCredential(c: Credential): void {
    const all = this.listCredentials().filter((x) => x.id !== c.id);
    all.push(c);
    this.setKV('credentials', all);
  }
  deleteCredential(id: string): void { this.setKV('credentials', this.listCredentials().filter((x) => x.id !== id)); }

  listModelConfigs(): ModelConfig[] { return this.getKV<ModelConfig[]>('modelConfigs', []); }
  saveModelConfig(m: ModelConfig): void {
    const all = this.listModelConfigs().filter((x) => x.id !== m.id);
    all.push(m);
    this.setKV('modelConfigs', all);
  }
  deleteModelConfig(id: string): void { this.setKV('modelConfigs', this.listModelConfigs().filter((x) => x.id !== id)); }

  listAgentProfiles(): AgentProfile[] { return this.getKV<AgentProfile[]>('agentProfiles', []); }
  saveAgentProfile(a: AgentProfile): void {
    const all = this.listAgentProfiles().filter((x) => x.id !== a.id);
    all.push(a);
    this.setKV('agentProfiles', all);
  }
  deleteAgentProfile(id: string): void { this.setKV('agentProfiles', this.listAgentProfiles().filter((x) => x.id !== id)); }

  listProjects(): Project[] { return this.getKV<Project[]>('projects', []); }
  saveProject(p: Project): void {
    const all = this.listProjects().filter((x) => x.id !== p.id);
    all.push(p);
    this.setKV('projects', all);
  }
  deleteProject(id: string): void { this.setKV('projects', this.listProjects().filter((x) => x.id !== id)); }

  getSettings(): Settings {
    return this.getKV<Settings>('settings', {
      theme: 'oc-2',
      defaultEngineId: 'builtin',
      verifyCommands: [],
      requireApprovalForTurboPlan: false,
      dataDir: './data',
    });
  }
  saveSettings(s: Settings): void { this.setKV('settings', s); }

  // ---- engines enable flags ----
  listEngineStates(): Record<string, { enabled: boolean }> {
    return this.getKV<Record<string, { enabled: boolean }>>('engineStates', {});
  }
  setEngineState(id: string, enabled: boolean): void {
    const all = this.listEngineStates();
    all[id] = { enabled };
    this.setKV('engineStates', all);
  }

  // ---- sessions ----
  saveSession(s: Session): void {
    this.db.prepare(
      'INSERT INTO sessions (id, project_id, title, mode, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, mode = excluded.mode, messages = excluded.messages, updated_at = excluded.updated_at',
    ).run(s.id, s.projectId, s.title, s.mode, JSON.stringify(s.messages), s.createdAt, s.updatedAt);
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      mode: row.mode as Session['mode'],
      messages: JSON.parse(row.messages) as ChatMessage[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listSessions(): Session[] {
    const rows = this.db.prepare('SELECT * FROM sessions ORDER BY updated_at DESC').all() as Record<string, string>[];
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      mode: row.mode as Session['mode'],
      messages: JSON.parse(row.messages) as ChatMessage[],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  deleteSession(id: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  appendMessage(sessionId: string, msg: ChatMessage): Session | undefined {
    const s = this.getSession(sessionId);
    if (!s) return undefined;
    s.messages.push(msg);
    s.updatedAt = nowIso();
    this.saveSession(s);
    return s;
  }

  // ---- runs ----
  saveRun(run: Run): void {
    const payload = { ...run };
    this.db.prepare(
      'INSERT INTO runs (id, session_id, project_id, mode, prompt, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at',
    ).run(run.id, run.sessionId, run.projectId, run.mode, run.prompt, run.status, JSON.stringify(payload), run.createdAt, run.updatedAt);
  }

  getRun(id: string): Run | undefined {
    const row = this.db.prepare('SELECT payload FROM runs WHERE id = ?').get(id) as { payload: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.payload) as Run;
  }

  listRuns(sessionId?: string): Run[] {
    const rows = sessionId
      ? this.db.prepare('SELECT payload FROM runs WHERE session_id = ? ORDER BY updated_at DESC').all(sessionId) as { payload: string }[]
      : this.db.prepare('SELECT payload FROM runs ORDER BY updated_at DESC').all() as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as Run);
  }

  // ---- tasks ----
  saveTask(t: Task): void {
    this.db.prepare(
      'INSERT INTO tasks (id, run_id, title, status, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, status = excluded.status, payload = excluded.payload, updated_at = excluded.updated_at',
    ).run(t.id, t.runId, t.title, t.status, JSON.stringify(t), t.createdAt, t.updatedAt);
  }

  getTask(id: string): Task | undefined {
    const row = this.db.prepare('SELECT payload FROM tasks WHERE id = ?').get(id) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as Task) : undefined;
  }

  listTasksByRun(runId: string): Task[] {
    const rows = this.db.prepare('SELECT payload FROM tasks WHERE run_id = ? ORDER BY created_at').all(runId) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as Task);
  }

  // ---- events ----
  appendEvent(evt: WorkspaceEvent): void {
    this.db.prepare(
      'INSERT INTO events (id, run_id, session_id, type, payload, ts) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(evt.id, evt.runId ?? null, evt.sessionId ?? null, evt.type, JSON.stringify(redactDeep(evt)), evt.ts);
  }

  listEvents(filter: { runId?: string; sessionId?: string; limit?: number }): WorkspaceEvent[] {
    const limit = filter.limit ?? 500;
    if (filter.runId) {
      const rows = this.db.prepare('SELECT payload FROM events WHERE run_id = ? ORDER BY ts DESC LIMIT ?').all(filter.runId, limit) as { payload: string }[];
      return rows.map((r) => JSON.parse(r.payload) as WorkspaceEvent).reverse();
    }
    if (filter.sessionId) {
      const rows = this.db.prepare('SELECT payload FROM events WHERE session_id = ? ORDER BY ts DESC LIMIT ?').all(filter.sessionId, limit) as { payload: string }[];
      return rows.map((r) => JSON.parse(r.payload) as WorkspaceEvent).reverse();
    }
    const rows = this.db.prepare('SELECT payload FROM events ORDER BY ts DESC LIMIT ?').all(limit) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as WorkspaceEvent).reverse();
  }

  /** On startup: runs that claim to be active are really interrupted. */
  markActiveRunsInterrupted(): Run[] {
    const active = ['queued', 'analyzing', 'debating', 'executing', 'reviewing', 'integrating'];
    const out: Run[] = [];
    for (const status of active) {
      const rows = this.db.prepare('SELECT payload FROM runs WHERE status = ?').all(status) as { payload: string }[];
      for (const row of rows) {
        const run = JSON.parse(row.payload) as Run;
        run.status = 'interrupted';
        run.updatedAt = nowIso();
        this.saveRun(run);
        out.push(run);
      }
    }
    return out;
  }

  close(): void {
    this.db.close();
  }
}

export function makeEvent(type: string, message: string, extra?: Partial<WorkspaceEvent>): WorkspaceEvent {
  return {
    id: newId('evt'),
    type,
    message,
    ts: nowIso(),
    ...extra,
  };
}
