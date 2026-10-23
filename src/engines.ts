// src/engines.ts — Agent engine registry + adapters (builtin model-loop, OpenCode CLI).
// Model = inference. Engine = action loop, tools, workspace, permissions, sessions.
import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { nowIso, newId } from './core.js';
import type { ToolSpec, ChatOptions, WireMessage, ChatResult } from './providers.js';
import type { Role } from './store.js';
import type { Permissions } from './tools.js';
import { DEFAULT_PERMISSIONS, PermissionManager, TOOL_SPECS, executeTool, runCommand } from './tools.js';
import { getRolePrompt, getAgentRules, currentPromptVersion } from './prompts.js';

export const PROMPT_VERSION = currentPromptVersion;

// ---------- Types ----------

export type EngineEvent =
  | { type: 'log'; message: string; ts: string }
  | { type: 'stdout'; line: string; ts: string }
  | { type: 'stderr'; line: string; ts: string }
  | { type: 'tool'; tool: string; args: Record<string, unknown>; result: string; ok: boolean; ts: string }
  | { type: 'message'; role: 'assistant'; content: string; ts: string }
  | { type: 'result'; summary: string; files: string[]; output?: string; ts: string }
  | { type: 'error'; message: string; ts: string };

export interface EngineCapabilities {
  start_task: boolean;
  stream_events: boolean;
  cancel_task: boolean;
  resume_task: boolean;
  workspace_isolation: boolean;
  uses_own_model: boolean; // true if engine brings its own model config (e.g. OpenCode)
}

export interface EngineTaskInput {
  prompt: string;
  cwd: string;
  role: Role;
  permissions: Permissions;
  modelConfigId?: string;   // for builtin engine: which model to think with
  toolSpecs?: ToolSpec[];
  maxSteps?: number;        // budget.maxStepsPerTask — hard cap on model round-trips
  signal?: AbortSignal;
  onEvent: (e: EngineEvent) => void;
}

export interface EngineTaskResult {
  summary: string;
  files: string[];
  output?: string;
  failed?: boolean;
}

export interface EngineDiscovery {
  available: boolean;
  version?: string;
  detail?: string;
}

export interface EngineAdapter {
  id: string;
  label: string;
  kind: 'builtin' | 'cli' | 'sdk';
  capabilities: EngineCapabilities;
  discover(): Promise<EngineDiscovery>;
  validate(): Promise<{ ok: boolean; error?: string }>;
  startTask(input: EngineTaskInput): Promise<EngineTaskResult>;
  cancel(handleId: string): Promise<void>;
}

// ---------- Builtin engine: model tool-loop ----------

export interface BuiltinDeps {
  chatFn: (modelConfigId: string, opts: ChatOptions) => Promise<ChatResult>;
  chatStreamFn?: (modelConfigId: string, opts: ChatOptions) => AsyncIterable<{ delta?: string; done?: boolean }>;
  defaultModelConfigId?: string;
}

export class BuiltinEngine implements EngineAdapter {
  id = 'builtin';
  label = 'Builtin agent (model tool-loop)';
  kind = 'builtin' as const;
  capabilities: EngineCapabilities = {
    start_task: true,
    stream_events: true,
    cancel_task: true,
    resume_task: false,
    workspace_isolation: false,
    uses_own_model: false,
  };

  private jobs = new Map<string, { abort: AbortController }>();
  private ee = new EventEmitter();

  constructor(private deps: BuiltinDeps) {
    this.ee.setMaxListeners(100);
  }

  async discover(): Promise<EngineDiscovery> {
    return { available: true, version: '1.0.0', detail: 'in-process model tool-loop' };
  }

  async validate(): Promise<{ ok: boolean; error?: string }> {
    return this.deps.defaultModelConfigId ? { ok: true } : { ok: false, error: 'no default model configured' };
  }

  async cancel(handleId: string): Promise<void> {
    this.jobs.get(handleId)?.abort.abort();
  }

  async startTask(input: EngineTaskInput): Promise<EngineTaskResult> {
    const modelConfigId = input.modelConfigId ?? this.deps.defaultModelConfigId;
    if (!modelConfigId) return { summary: '', files: [], failed: true, output: 'no model configured for builtin engine' };

    const handleId = newId('job');
    const abort = new AbortController();
    this.jobs.set(handleId, { abort });
    input.signal?.addEventListener('abort', () => abort.abort(), { once: true });

    const perms = new PermissionManager(input.permissions, input.cwd);
    const ctx = {
      projectPath: input.cwd,
      perms,
      onAction: (a: { tool: string; args: Record<string, unknown>; result: string; ok: boolean; ts: string }) => {
        input.onEvent({ type: 'tool', tool: a.tool, args: a.args, result: a.result, ok: a.ok, ts: a.ts });
      },
    };

    const tools: ToolSpec[] = input.toolSpecs ?? [...TOOL_SPECS];
    const messages: WireMessage[] = [
      { role: 'system', content: `${getRolePrompt(input.role)}\n${getAgentRules()}\n\nWorkspace: ${input.cwd}\nYou MUST stop and call 'finish' when the task is done or cannot proceed. Use tools to actually do the work — never claim you edited a file without calling write_file.` },
      { role: 'user', content: input.prompt },
    ];

    let summary = '';
    let files: string[] = [];
    let steps = 0;
    let errorOut: string | undefined;
    const stepCap = input.maxSteps ?? 64;
    let nudged = false;

    try {
      while (steps < stepCap) {
        if (abort.signal.aborted) throw new Error('cancelled');
        // near the step budget: push the agent to wrap up instead of looping forever
        if (!nudged && steps >= stepCap - 4) {
          nudged = true;
          messages.push({ role: 'user', content: `[system] Step budget nearly exhausted (${stepCap - steps} steps left). Stop exploring. Take the single most direct remaining action, then call finish with a summary — even if the task could not be completed, finish now and explain what is missing.` });
        }
        steps++;
        const res = await this.deps.chatFn(modelConfigId, {
          messages,
          tools,
          temperature: 0.2,
          signal: abort.signal,
        });
        if (res.text) input.onEvent({ type: 'message', role: 'assistant', content: res.text, ts: nowIso() });
        if (res.toolCalls.length === 0) {
          summary = res.text;
          break;
        }
        messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
        let finished = false;
        for (const tc of res.toolCalls) {
          if (tc.name === 'finish') {
            let parsed: { summary?: string; files?: string[] } = {};
            try { parsed = JSON.parse(tc.args || '{}') as { summary?: string; files?: string[] }; } catch { /* keep raw */ }
            summary = parsed.summary ?? res.text;
            files = Array.isArray(parsed.files) ? parsed.files.map(String) : [];
            finished = true;
            break;
          }
          const { output } = await executeTool(ctx, tc.name, tc.args);
          messages.push({ role: 'tool', content: output.slice(0, 40_000), toolCallId: tc.id, name: tc.name });
        }
        if (finished) break;
      }
      if (!summary && steps >= stepCap) {
        errorOut = `step budget exhausted (${stepCap}) without finish`;
      }
    } catch (e) {
      errorOut = (e as Error).message;
    } finally {
      this.jobs.delete(handleId);
    }

    if (errorOut) {
      input.onEvent({ type: 'error', message: errorOut, ts: nowIso() });
      return { summary: summary || '', files, failed: true, output: errorOut };
    }
    input.onEvent({ type: 'result', summary, files, ts: nowIso() });
    return { summary, files };
  }
}

// ---------- OpenCode CLI engine ----------

export class OpenCodeEngine implements EngineAdapter {
  id = 'opencode';
  label = 'OpenCode CLI agent';
  kind = 'cli' as const;
  capabilities: EngineCapabilities = {
    start_task: true,
    stream_events: true,
    cancel_task: true,
    resume_task: false,
    workspace_isolation: false,
    uses_own_model: true,
  };

  private procs = new Map<string, ChildProcess>();

  async discover(): Promise<EngineDiscovery> {
    const res = await runCommand('opencode --version', process.cwd(), 10_000);
    if (res.ok) return { available: true, version: res.stdout.trim() || 'unknown', detail: 'opencode CLI on PATH' };
    return { available: false, detail: `opencode not found on PATH: ${res.stderr.slice(0, 200)}` };
  }

  async validate(): Promise<{ ok: boolean; error?: string }> {
    const d = await this.discover();
    return d.available ? { ok: true } : { ok: false, error: d.detail };
  }

  async cancel(handleId: string): Promise<void> {
    this.procs.get(handleId)?.kill('SIGKILL');
  }

  async startTask(input: EngineTaskInput): Promise<EngineTaskResult> {
    const handleId = newId('oc');
    // Run in prompt-only mode; OpenCode uses its own configured model and permissions.
    const args = ['run', input.prompt];
    const result = await new Promise<EngineTaskResult>((resolve) => {
      const child = spawn('opencode', args, { cwd: input.cwd, windowsHide: true, shell: process.platform === 'win32' });
      this.procs.set(handleId, child);
      let stdout = '';
      let stderr = '';
      let killed = false;
      const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, 15 * 60_000);
      input.signal?.addEventListener('abort', () => { killed = true; child.kill('SIGKILL'); }, { once: true });

      child.stdout?.on('data', (d: Buffer) => {
        for (const line of d.toString().split('\n')) {
          if (line.trim()) input.onEvent({ type: 'stdout', line, ts: nowIso() });
        }
        stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        for (const line of d.toString().split('\n')) {
          if (line.trim()) input.onEvent({ type: 'stderr', line, ts: nowIso() });
        }
        stderr += d.toString();
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        this.procs.delete(handleId);
        input.onEvent({ type: 'error', message: err.message, ts: nowIso() });
        resolve({ summary: '', files: [], failed: true, output: err.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        this.procs.delete(handleId);
        if (killed) {
          resolve({ summary: '', files: [], failed: true, output: 'opencode task cancelled or timed out' });
          return;
        }
        if (code === 0) {
          resolve({ summary: stdout.slice(0, 20_000) || 'completed', files: [], output: stdout.slice(0, 50_000) });
        } else {
          resolve({ summary: '', files: [], failed: true, output: `exit=${code}: ${(stderr || stdout).slice(0, 20_000)}` });
        }
      });
    });
    return result;
  }
}

// ---------- Registry ----------

export interface EngineStatus {
  id: string;
  label: string;
  kind: string;
  capabilities: EngineCapabilities;
  discovery: EngineDiscovery;
  enabled: boolean;
  validation?: { ok: boolean; error?: string };
}

export class EngineRegistry {
  private adapters = new Map<string, EngineAdapter>();

  constructor() {
    // builtin is registered by the app with chat deps; opencode always registrable
  }

  register(adapter: EngineAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): EngineAdapter | undefined {
    return this.adapters.get(id);
  }

  require(id: string): EngineAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`engine '${id}' not registered`);
    return a;
  }

  list(): EngineAdapter[] {
    return [...this.adapters.values()];
  }

  async statusAll(enabledStates: Record<string, { enabled: boolean }>): Promise<EngineStatus[]> {
    const out: EngineStatus[] = [];
    for (const a of this.list()) {
      const discovery = await a.discover();
      out.push({
        id: a.id,
        label: a.label,
        kind: a.kind,
        capabilities: a.capabilities,
        discovery,
        enabled: enabledStates[a.id]?.enabled ?? (a.id === 'builtin'),
      });
    }
    return out;
  }
}

export { DEFAULT_PERMISSIONS };
