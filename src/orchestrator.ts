// src/orchestrator.ts — task state machine, dependency DAG scheduler, Normal & Turbo pipelines.
import { nowIso, newId, extractJson, sleep } from './core.js';
import { EventBus } from './core.js';
import type {
  Store, Run, Task, TaskStatus, Session, WorkspaceEvent, ExecutionPlan,
  PlanTaskSpec, AgentProfile, ModelConfig, Budget, Role, ChatMessage,
} from './store.js';
import { DEFAULT_BUDGET, makeEvent } from './store.js';
import type { ProviderRegistry, ChatOptions, ChatResult } from './providers.js';
import { ProviderError } from './providers.js';
import type { EngineRegistry } from './engines.js';
import type { ToolSpec } from './providers.js';
import { gitDiff, gitStatus, repoTreeSummary, runCommand, TOOL_SPECS } from './tools.js';
import type { Permissions } from './tools.js';

// ---------- Task state machine ----------

const ALLOWED_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  queued: ['planning', 'running', 'waiting_dependency', 'cancelled', 'failed'],
  planning: ['running', 'failed', 'cancelled', 'awaiting_approval'],
  awaiting_approval: ['running', 'cancelled', 'failed'],
  running: ['reviewing', 'testing', 'completed', 'failed', 'cancelled', 'retrying'],
  waiting_dependency: ['queued', 'running', 'cancelled', 'failed'],
  reviewing: ['completed', 'failed', 'retrying', 'cancelled'],
  integrating: ['completed', 'failed', 'cancelled'],
  testing: ['completed', 'failed', 'retrying', 'cancelled'],
  retrying: ['running', 'failed', 'cancelled'],
  paused: ['running', 'cancelled', 'failed'],
  completed: [],
  failed: ['retrying', 'cancelled'],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`illegal task transition ${from} -> ${to}`);
  }
}

// ---------- DAG scheduling helpers ----------

export function topoOrder(tasks: { id: string; deps: string[] }[]): string[] {
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    indeg.set(t.id, 0);
  }
  for (const t of tasks) {
    for (const d of t.deps) {
      if (!indeg.has(d)) continue; // ignore unknown deps
      indeg.set(t.id, (indeg.get(t.id) ?? 0) + 1);
      dependents.set(d, [...(dependents.get(d) ?? []), t.id]);
    }
  }
  const queue = tasks.filter((t) => (indeg.get(t.id) ?? 0) === 0).map((t) => t.id);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift() as string;
    order.push(id);
    for (const dep of dependents.get(id) ?? []) {
      const left = (indeg.get(dep) ?? 1) - 1;
      indeg.set(dep, left);
      if (left === 0) queue.push(dep);
    }
  }
  return order;
}

export function hasCycle(tasks: { id: string; deps: string[] }[]): boolean {
  return topoOrder(tasks).length !== tasks.length;
}

// ---------- Orchestrator ----------

export interface OrchestratorDeps {
  store: Store;
  bus: EventBus<WorkspaceEvent>;
  providers: ProviderRegistry;
  engines: EngineRegistry;
}

export interface StartRunInput {
  session: Session;
  prompt: string;
  mode: 'normal' | 'turbo';
  modelConfigIds: string[];
  agentProfileIds: string[];
  budget?: Partial<Budget>;
  permissions?: Permissions; // OpenCode-style agent presets (build/plan/full)
  toolFilter?: string[]; // minimal tool subset chosen by the CLI router
}

export class Orchestrator {
  private runAborts = new Map<string, AbortController>();
  private fileLocks = new Map<string, string>(); // absPath -> taskId

  constructor(private deps: OrchestratorDeps) {}

  // ----- event + persistence helpers -----

  private emit(evt: WorkspaceEvent): void {
    this.deps.store.appendEvent(evt);
    this.deps.bus.publish(evt);
  }

  private event(run: Run, type: string, message: string, extra?: Partial<WorkspaceEvent>): void {
    this.emit(makeEvent(type, message, {
      runId: run.id,
      sessionId: run.sessionId,
      modelConfigId: extra?.modelConfigId,
      taskId: extra?.taskId,
      agentId: extra?.agentId,
      status: extra?.status,
      data: extra?.data,
    }));
  }

  private setRunStatus(run: Run, status: Run['status'], err?: string): void {
    run.status = status;
    run.updatedAt = nowIso();
    if (err !== undefined) run.error = err;
    this.deps.store.saveRun(run);
    this.event(run, 'run.status', `run ${status}`, { status, data: err ? { error: err } : undefined });
  }

  private async transitionTask(run: Run, task: Task, to: TaskStatus, err?: string): Promise<void> {
    if (task.status !== to) {
      assertTransition(task.status, to);
      task.status = to;
    }
    task.updatedAt = nowIso();
    if (err !== undefined) task.error = err;
    this.deps.store.saveTask(task);
    this.event(run, 'task.status', `task '${task.title}' -> ${to}`, { taskId: task.id, status: to, agentId: task.agentId, data: err ? { error: err } : undefined });
  }

  // ----- model call helper (usage accounting, single place) -----

  private async chat(run: Run, modelConfigId: string, opts: ChatOptions): Promise<ChatResult> {
    const mc = this.deps.store.listModelConfigs().find((m) => m.id === modelConfigId);
    if (!mc) throw new ProviderError('unknown', `model config '${modelConfigId}' not found`);
    const cred = this.deps.store.listCredentials().find((c) => c.id === mc.credentialId);
    if (!cred) throw new ProviderError('unknown', `credential for model '${modelConfigId}' not found`);
    const adapter = this.deps.providers.adapterForCredential(cred);
    const res = await adapter.chat(cred, mc.modelId, opts);
    run.usage.requests++;
    run.usage.inputTokens += res.usage?.inputTokens ?? 0;
    run.usage.outputTokens += res.usage?.outputTokens ?? 0;
    this.deps.store.saveRun(run);
    return res;
  }

  private async chatText(run: Run, modelConfigId: string, system: string, user: string, signal?: AbortSignal): Promise<string> {
    const res = await this.chat(run, modelConfigId, {
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.2,
      signal,
      timeoutMs: run.budget.requestTimeoutMs,
    });
    return res.text;
  }

  // ----- public API -----

  startRun(input: StartRunInput): Run {
    const run: Run = {
      id: newId('run'),
      sessionId: input.session.id,
      projectId: input.session.projectId,
      mode: input.mode,
      prompt: input.prompt,
      status: 'queued',
      modelConfigIds: input.modelConfigIds,
      agentProfileIds: input.agentProfileIds,
      debate: [],
      reviews: [],
      taskIds: [],
      budget: { ...DEFAULT_BUDGET, ...input.budget },
      toolFilter: input.toolFilter,
      permissions: input.permissions,
      usage: { requests: 0, inputTokens: 0, outputTokens: 0 },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.deps.store.saveRun(run);

    const msg: ChatMessage = { id: newId('msg'), role: 'user', content: input.prompt, ts: nowIso() };
    this.deps.store.appendMessage(input.session.id, msg);
    if (input.mode === 'turbo' && input.modelConfigIds.length < 2) {
      // hard requirement: turbo needs >= 2 models
      this.setRunStatus(run, 'failed', 'Turbo mode requires at least 2 model configurations');
      return run;
    }

    const ac = new AbortController();
    this.runAborts.set(run.id, ac);
    void (input.mode === 'normal' ? this.runNormal(run, ac.signal) : this.runTurbo(run, ac.signal))
      .catch((e: unknown) => {
        this.setRunStatus(run, 'failed', `orchestrator crashed: ${(e as Error).message}`);
      })
      .finally(() => this.runAborts.delete(run.id));
    return run;
  }

  cancelRun(runId: string): boolean {
    const ac = this.runAborts.get(runId);
    if (!ac) return false;
    ac.abort();
    return true;
  }

  /** Resume an interrupted or approval-blocked run. */
  async resumeRun(runId: string): Promise<Run | undefined> {
    const run = this.deps.store.getRun(runId);
    if (!run) return undefined;
    if (!['interrupted', 'awaiting_approval', 'paused'].includes(run.status)) return run;

    const ac = new AbortController();
    this.runAborts.set(run.id, ac);
    run.needsApproval = undefined;
    try {
      if (run.mode === 'normal') {
        await this.runNormal(run, ac.signal);
      } else {
        // re-queue any non-terminal tasks, skip completed ones
        const tasks = this.deps.store.listTasksByRun(run.id);
        for (const t of tasks) {
          if (['running', 'retrying', 'queued', 'waiting_dependency', 'planning'].includes(t.status)) {
            t.status = 'queued';
            t.updatedAt = nowIso();
            this.deps.store.saveTask(t);
          }
        }
        run.taskIds = tasks.map((t) => t.id);
        this.setRunStatus(run, 'executing');
        const ok = await this.executeDag(run, tasks, ac.signal);
        if (ok) await this.reviewAndIntegrate(run, ac.signal);
      }
    } catch (e) {
      const msg = (e as Error).message;
      if (msg === 'aborted') this.setRunStatus(run, 'cancelled', 'cancelled by user');
      else this.setRunStatus(run, 'failed', `resume failed: ${msg}`);
    } finally {
      this.runAborts.delete(run.id);
    }
    return this.deps.store.getRun(run.id);
  }

  // ----- NORMAL mode: exactly one model, tool loop via engine -----

  private async runNormal(run: Run, signal: AbortSignal): Promise<void> {
    await this.createCheckpoint(run);
    this.setRunStatus(run, 'executing');
    const project = this.deps.store.listProjects().find((p) => p.id === run.projectId);
    const modelId = run.modelConfigIds[0];
    const agent = this.deps.store.listAgentProfiles().find((a) => run.agentProfileIds.includes(a.id));

    const task: Task = {
      id: newId('task'),
      runId: run.id,
      title: run.prompt.slice(0, 80),
      description: run.prompt,
      role: 'coder',
      agentId: agent?.id,
      modelConfigId: modelId,
      status: 'queued',
      deps: [],
      files: [],
      attempts: 0,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    run.taskIds = [task.id];
    this.deps.store.saveTask(task);

    const tree = project ? await repoTreeSummary(project.path) : '(no project selected)';
    const prompt = `User request:\n${run.prompt}\n\nWorkspace files (top level):\n${tree}`;

    await this.transitionTask(run, task, 'running');
    const result = await this.callEngineForTask(run, task, prompt, signal);
    if (result.failed) {
      await this.transitionTask(run, task, 'failed', result.output);
      this.setRunStatus(run, 'failed', result.output);
      return;
    }
    await this.transitionTask(run, task, 'completed');
    task.result = { summary: result.summary, files: result.files, output: result.output };
    this.deps.store.saveTask(task);

    this.deps.store.appendMessage(run.sessionId, {
      id: newId('msg'), role: 'assistant', content: result.summary, agentId: task.agentId, modelConfigId: modelId,
      meta: { files: result.files }, ts: nowIso(),
    });
    this.setRunStatus(run, 'completed');
  }

  // ----- TURBO mode: stages A-G -----

  private async runTurbo(run: Run, signal: AbortSignal): Promise<void> {
    await this.createCheckpoint(run);
    const project = this.deps.store.listProjects().find((p) => p.id === run.projectId);
    const projectPath = project?.path ?? process.cwd();
    const models = run.modelConfigIds;
    const orchestratorModel = models[0];

    const signalCheck = () => {
      if (signal.aborted) throw new Error('aborted');
    };

    // ----- Stage A: analyze (first model, grounded in real repo state) -----
    this.setRunStatus(run, 'analyzing');
    const gs = await gitStatus(projectPath);
    const tree = await repoTreeSummary(projectPath);
    const repoContext = `Project path: ${projectPath}\nGit branch: ${gs.branch ?? 'n/a'}${gs.isRepo ? '' : ' (not a git repo!)'}\nTop-level files:\n${tree}\nGit status:\n${gs.porcelain || '(clean)'}`;

    const analysis = await this.chatText(run, orchestratorModel,
      'You are the analysis stage of a multi-model team. Identify goals, constraints, risks, and open questions from the user request and repo context. Reply with compact JSON: {"goal": string, "constraints": string[], "risks": string[], "open_questions": string[]}. Only JSON.',
      `User request:\n${run.prompt}\n\nRepo context:\n${repoContext}`,
      signal,
    );
    signalCheck();
    run.debate.push({ round: 0, kind: 'analysis', modelConfigId: orchestratorModel, content: analysis, ts: nowIso() });
    this.deps.store.saveRun(run);
    this.event(run, 'turbo.analysis', 'analysis complete', { modelConfigId: orchestratorModel, data: { content: analysis } });

    // ----- Stage B: proposals, then critique rounds (bounded) -----
    this.setRunStatus(run, 'debating');
    const settledProposals = await Promise.allSettled(models.map(async (m) => {
      const text = await this.chatText(run, m,
        'You are one member of a multi-model engineering team. Propose your own independent architecture and implementation plan for the request. Reply compact JSON: {"architecture": string, "plan": string[], "risks": string[]}. Only JSON.',
        `User request:\n${run.prompt}\n\nRepo context:\n${repoContext}\n\nAnalysis from team:\n${analysis}`,
        signal,
      );
      run.debate.push({ round: 1, kind: 'proposal', modelConfigId: m, content: text, ts: nowIso() });
      return { modelConfigId: m, text };
    }));
    const proposals = settledProposals
      .filter((r): r is PromiseFulfilledResult<{ modelConfigId: string; text: string }> => r.status === 'fulfilled')
      .map((r) => r.value);
    const failedProposals = models.filter((m) => !proposals.some((p) => p.modelConfigId === m));
    if (failedProposals.length) {
      this.event(run, 'turbo.proposal', 'model(s) failed at proposal stage, excluded from debate: ' + failedProposals.join(', '), {});
    }
    if (proposals.length === 0) {
      this.setRunStatus(run, 'failed', 'all models failed at the proposal stage');
      return;
    }
    this.deps.store.saveRun(run);
    for (const p of proposals) {
      this.event(run, 'turbo.proposal', 'proposal submitted', { modelConfigId: p.modelConfigId, data: { content: p.text } });
    }

    for (let round = 2; round <= Math.max(1, run.budget.maxDebateRounds); round++) {
      signalCheck();
      const others = proposals.filter((p) => p.modelConfigId !== models[0]);
      await Promise.allSettled(models.map(async (m) => {
        const peers = proposals.filter((p) => p.modelConfigId !== m);
        const text = await this.chatText(run, m,
          'You are one member of a multi-model team. Review the OTHER proposals below. Find contradictions, flaws, security and feasibility issues. State agreements explicitly too. Reply compact JSON: {"agree": string[], "disagree": string[], "evidence": string[], "revisions": string[]}. Only JSON.',
          `Original request:\n${run.prompt}\n\nYour earlier proposal:\n${proposals.find((p) => p.modelConfigId === m)?.text ?? '(none)'}\n\nPeer proposals:\n${peers.map((p) => `[${p.modelConfigId}]: ${p.text}`).join('\n\n')}`,
          signal,
        );
        run.debate.push({ round, kind: 'critique', modelConfigId: m, content: text, ts: nowIso() });
        this.event(run, 'turbo.critique', `critique round ${round}`, { modelConfigId: m, data: { content: text } });
      }));
      this.deps.store.saveRun(run);
    }

    // ----- Stage C: synthesis -> execution plan -----
    const debateDump = run.debate.map((d) => `[round ${d.round} ${d.kind} ${d.modelConfigId}]\n${d.content}`).join('\n\n');
    let plan = await this.synthesizePlan(run, orchestratorModel, run.prompt, repoContext, debateDump, signal);
    if (!plan) {
      // one strict retry
      plan = await this.synthesizePlan(run, orchestratorModel, run.prompt, repoContext, `${debateDump}\n\nNOTE: previous synthesis was not valid JSON. Return ONLY the JSON object now.`, signal);
    }
    if (!plan) {
      this.setRunStatus(run, 'failed', 'orchestrator model failed to produce a valid execution plan after retry');
      return;
    }
    if (hasCycle(plan.tasks.map((t) => ({ id: t.id, deps: t.deps })))) {
      this.setRunStatus(run, 'failed', 'execution plan contains a dependency cycle');
      return;
    }
    run.plan = plan;
    this.deps.store.saveRun(run);
    this.event(run, 'turbo.plan', `plan created with ${plan.tasks.length} tasks`, { data: { plan } });

    // approval gate when policy requires it
    if (this.deps.store.getSettings().requireApprovalForTurboPlan) {
      run.needsApproval = { reason: 'Turbo plan awaiting user approval (policy)', createdAt: nowIso() };
      this.setRunStatus(run, 'awaiting_approval');
      return;
    }

    // ----- Stage D: assign + create task rows -----
    const tasks = await this.assignAndCreateTasks(run, plan);
    if (tasks.length === 0) {
      this.setRunStatus(run, 'failed', 'plan produced zero executable tasks');
      return;
    }

    // ----- Stage E: parallel execution along the DAG -----
    this.setRunStatus(run, 'executing');
    const dagOk = await this.executeDag(run, tasks, signal);
    if (!dagOk) {
      this.setRunStatus(run, 'failed', 'one or more tasks failed irrecoverably; results not integrated');
      return;
    }

    // ----- Stages F & G -----
    await this.reviewAndIntegrate(run, signal);
  }

  private async synthesizePlan(run: Run, modelConfigId: string, prompt: string, repoContext: string, debateDump: string, signal: AbortSignal): Promise<ExecutionPlan | null> {
    const raw = await this.chatText(run, modelConfigId,
      'You are the orchestrator synthesizing a multi-model debate into ONE execution plan. Weigh evidence, prefer consensus, and record genuine disagreements (do not manufacture agreement). Create small, independently verifiable tasks with correct dependency ordering. Reply ONLY with JSON: {"goal": string, "constraints": string[], "acceptance": string[], "consensus": string[], "unresolved": string[], "tasks": [{"id": "t1", "title": string, "description": string, "role": "planner|architect|backend|frontend|designer|tester|reviewer|researcher|coder", "deps": string[], "files": string[]}]}',
      `User request:\n${prompt}\n\nRepo context:\n${repoContext}\n\nFull debate:\n${debateDump}`,
      signal,
    );
    const obj = extractJson(raw) as ExecutionPlan | null;
    if (!obj || typeof obj !== 'object' || !Array.isArray(obj.tasks)) return null;
    obj.tasks = obj.tasks.filter((t) => t && typeof t.id === 'string' && typeof t.title === 'string');
    return obj;
  }

  private async assignAndCreateTasks(run: Run, plan: ExecutionPlan): Promise<Task[]> {
    const agents = this.deps.store.listAgentProfiles().filter((a) => run.agentProfileIds.includes(a.id));
    const pickAgent = (role: Role): AgentProfile | undefined => {
      return agents.find((a) => a.roles.includes(role)) ?? agents[0];
    };
    const tasks: Task[] = [];
    const idMap = new Map<string, string>(); // plan spec id -> real task id
    const pairs: { spec: PlanTaskSpec; task: Task }[] = [];
    for (const spec of plan.tasks) {
      const agent = pickAgent(spec.role);
      const task: Task = {
        id: newId('task'),
        runId: run.id,
        title: spec.title,
        description: spec.description,
        role: spec.role,
        agentId: agent?.id,
        modelConfigId: agent && !this.deps.engines.require(agent.engineId).capabilities.uses_own_model
          ? agent.modelConfigId
          : undefined,
        status: 'queued',
        deps: [],
        files: spec.files ?? [],
        attempts: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      idMap.set(spec.id, task.id);
      this.deps.store.saveTask(task);
      tasks.push(task);
      pairs.push({ spec, task });
    }
    // remap deps from plan ids to real task ids
    for (const { spec, task } of pairs) {
      task.deps = (spec.deps ?? []).map((d) => idMap.get(d)).filter((x): x is string => Boolean(x));
      this.deps.store.saveTask(task);
    }
    run.taskIds = tasks.map((t) => t.id);
    this.deps.store.saveRun(run);
    for (const t of tasks) {
      this.event(run, 'task.created', `task '${t.title}' assigned to ${t.agentId ?? 'unassigned'} (${t.role})`, { taskId: t.id, agentId: t.agentId, status: t.status });
    }
    return tasks;
  }

  /** Execute tasks along the DAG with bounded concurrency, file locking, retry. Returns true if all tasks completed. */
  private async executeDag(run: Run, tasks: Task[], signal: AbortSignal): Promise<boolean> {
    const byId = new Map(tasks.map((t) => [t.id, t]));
    let tasksDone = 0;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      let running = 0;
      const finish = (allOk: boolean) => {
        if (!settled) {
          settled = true;
          resolve(allOk);
        }
      };
      const tick = () => {
        if (settled) return;
        if (signal.aborted) {
          for (const t of tasks) {
            if (!['completed', 'failed', 'cancelled'].includes(t.status)) void this.transitionTask(run, t, 'cancelled', 'run cancelled');
          }
          finish(false);
          return;
        }
        // launch ready tasks (deps resolved) within concurrency budget
        for (const t of tasks) {
          if (running >= run.budget.maxConcurrency) break;
          if (t.status !== 'queued' && t.status !== 'waiting_dependency') continue;
          const depStates = t.deps.map((d) => byId.get(d)?.status).filter(Boolean) as TaskStatus[];
          if (depStates.some((s) => s === 'failed' || s === 'cancelled')) {
            void this.transitionTask(run, t, 'failed', 'dependency failed');
            continue;
          }
          const depsReady = depStates.length === t.deps.length && depStates.every((s) => s === 'completed');
          if (depsReady) {
            running++;
            void this.transitionTask(run, t, 'running').then(() => launch(t));
          } else if (t.status === 'queued') {
            void this.transitionTask(run, t, 'waiting_dependency');
          }
        }
        const allTerminal = tasks.every((t) => ['completed', 'failed', 'cancelled'].includes(t.status));
        if (running === 0 && allTerminal) {
          finish(tasks.every((t) => t.status === 'completed'));
        }
      };

      const launch = async (t: Task) => {
        // running was incremented by tick() before calling launch
        const ok = await this.runSingleTask(run, t, signal);
        running--;
        if (ok) {
          tasksDone++;
        } else if (t.attempts <= run.budget.maxRetriesPerTask) {
          t.status = 'failed';
          t.updatedAt = nowIso();
          this.deps.store.saveTask(t);
          await this.transitionTask(run, t, 'retrying', t.error);
          t.status = 'queued';
          t.updatedAt = nowIso();
          this.deps.store.saveTask(t);
        } else {
          if (t.status !== 'failed') {
            t.status = 'failed';
            t.updatedAt = nowIso();
            this.deps.store.saveTask(t);
          }
          // dependents will be marked failed by tick()
        }
        // release file locks held by this task
        for (const [p, owner] of [...this.fileLocks.entries()]) {
          if (owner === t.id) this.fileLocks.delete(p);
        }
        setImmediate(tick);
      };

      setImmediate(tick);
    });
  }

  private acquireFileLocks(task: Task): boolean {
    for (const f of task.files) {
      const norm = f.replace(/\\/g, '/').toLowerCase();
      const owner = this.fileLocks.get(norm);
      if (owner && owner !== task.id) return false;
    }
    for (const f of task.files) {
      this.fileLocks.set(f.replace(/\\/g, '/').toLowerCase(), task.id);
    }
    return true;
  }

  // ----- engine invocation (shared by normal + turbo task execution) -----

  private async callEngineForTask(run: Run, task: Task, prompt: string, signal: AbortSignal): Promise<{ summary: string; files: string[]; output?: string; failed?: boolean }> {
    const agents = this.deps.store.listAgentProfiles();
    const agent = agents.find((a) => a.id === task.agentId);
    const engine = agent ? this.deps.engines.get(agent.engineId) : undefined;
    if (!agent || !engine) {
      return { summary: '', files: [], failed: true, output: `no agent/engine for task (agent=${task.agentId ?? 'none'})` };
    }
    try {
      const result = await engine.startTask({
        prompt,
        cwd: this.deps.store.listProjects().find((p) => p.id === run.projectId)?.path ?? process.cwd(),
        role: task.role,
        permissions: run.permissions ?? {
          allowRead: true, allowWrite: true, allowDelete: false,
          allowShell: 'safe', allowNetworkTools: false, workspaceOnly: true,
        },
        modelConfigId: task.modelConfigId,
        maxSteps: run.budget.maxStepsPerTask,
        toolSpecs: (() => {
          const all = [...TOOL_SPECS] as ToolSpec[];
          const base = run.toolFilter?.length ? all.filter((t) => run.toolFilter!.includes(t.name)) : all;
          // bộ não phụ trợ: skill library luôn truy cập được
          return base.some((t) => t.name === 'find_skill') ? base : [...base, ...all.filter((t) => t.name === 'find_skill' || t.name === 'read_skill')];
        })(),
        signal,
        onEvent: (e) => {
          if (e.type === 'tool') {
            this.emit(makeEvent('agent.tool', `${e.tool}`, {
              runId: run.id, sessionId: run.sessionId, taskId: task.id, agentId: agent.id,
              data: { tool: e.tool, args: e.args, ok: e.ok, result: e.result.slice(0, 1000) },
            }));
          } else if (e.type === 'message') {
            this.emit(makeEvent('agent.message', e.content.slice(0, 4000), {
              runId: run.id, sessionId: run.sessionId, taskId: task.id, agentId: agent.id, modelConfigId: task.modelConfigId,
            }));
          } else if (e.type === 'error') {
            this.emit(makeEvent('agent.error', e.message, { runId: run.id, sessionId: run.sessionId, taskId: task.id, agentId: agent.id }));
          }
        },
      });
      return result;
    } catch (e) {
      return { summary: '', files: [], failed: true, output: `engine error: ${(e as Error).message}` };
    }
  }

  private async runSingleTask(run: Run, task: Task, signal: AbortSignal): Promise<boolean> {
    // wait for file locks of same files claimed by other running tasks
    for (let i = 0; i < 120; i++) {
      if (this.acquireFileLocks(task)) break;
      await sleep(1000, signal).catch(() => { throw new Error('aborted'); });
    }
    if (!this.acquireFileLocks(task)) {
      await this.transitionTask(run, task, 'failed', 'could not acquire file locks');
      return false;
    }

    task.attempts++;
    this.deps.store.saveTask(task);

    const depsTasks = task.deps.map((d) => this.deps.store.getTask(d)).filter(Boolean) as Task[];
    const depContext = depsTasks.map((d) => `[dependency '${d.title}' (${d.status})]\n${d.result?.summary ?? d.error ?? '(no result)'}`).join('\n\n');
    const run_ = await this.deps.store.getRun(run.id);
    const acceptance = run_?.plan?.acceptance ?? [];
    const constraints = run_?.plan?.constraints ?? [];
    const goal = run_?.plan?.goal ?? run.prompt;

    const prompt = [
      `TEAM GOAL: ${goal}`,
      constraints.length ? `CONSTRAINTS:\n- ${constraints.join('\n- ')}` : '',
      acceptance.length ? `ACCEPTANCE CRITERIA:\n- ${acceptance.join('\n- ')}` : '',
      `YOUR TASK (${task.role}): ${task.title}\n${task.description}`,
      task.files.length ? `FILES you may create/modify: ${task.files.join(', ')}` : '',
      depContext ? `RESULTS FROM DEPENDENCIES:\n${depContext}` : '',
      'Do the work with tools, verify it, then call finish.',
    ].filter(Boolean).join('\n\n');

    const result = await this.callEngineForTask(run, task, prompt, signal);
    if (result.failed) {
      await this.transitionTask(run, task, 'failed', result.output ?? 'engine reported failure');
      return false;
    }
    task.result = { summary: result.summary, files: result.files, output: result.output };
    this.deps.store.saveTask(task);
    await this.transitionTask(run, task, 'completed');
    return true;
  }

  // ----- Stages F & G -----

  // ----- checkpoints (OpenCode-style /undo) -----

  /** Snapshot worktree BEFORE a run touches anything: git stash -u + apply (worktree restored, snapshot stored). */
  private async createCheckpoint(run: Run): Promise<void> {
    try {
      const project = this.deps.store.listProjects().find((p) => p.id === run.projectId);
      if (!project) return;
      const gs = await gitStatus(project.path);
      if (!gs.isRepo) return;
      const head = await runCommand('git rev-parse HEAD', project.path, 10_000);
      const cp: NonNullable<Run['checkpoint']> = { head: head.stdout.trim() || 'HEAD' };
      const stash = await runCommand(`git stash push -u -m madw-${run.id}`, project.path, 30_000);
      if (stash.ok && !/No local changes/i.test(stash.stdout)) {
        const apply = await runCommand('git stash apply --index', project.path, 30_000);
        if (!apply.ok) {
          // worktree got stripped and restore failed: abort the run, keep the stash for manual recovery
          this.setRunStatus(run, 'failed', `checkpoint apply failed — pre-run changes are SAFE in 'git stash list' (madw-${run.id}); run did NOT start`);
          return;
        }
        cp.stashRef = 'stash@{0}';
        const ls = await runCommand('git ls-tree -r --name-only "stash@{0}^3"', project.path, 15_000);
        cp.untracked = ls.ok ? ls.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [];
      }
      run.checkpoint = cp;
      this.deps.store.saveRun(run);
      this.event(run, 'run.checkpoint', `checkpoint ok (${cp.stashRef ?? `HEAD ${cp.head.slice(0, 7)}`})`, {});
    } catch (e) {
      this.event(run, 'run.checkpoint', `checkpoint skipped: ${(e as Error).message}`, {});
    }
  }

  /** Revert the workspace to the pre-run snapshot. Caller must confirm (it deletes run-created files). */
  async undoRun(runId: string): Promise<{ ok: boolean; message: string; deleted: string[] }> {
    const run = this.deps.store.getRun(runId);
    if (!run?.checkpoint) return { ok: false, message: 'run này không có checkpoint', deleted: [] };
    const project = this.deps.store.listProjects().find((p) => p.id === run.projectId);
    if (!project) return { ok: false, message: 'project không tồn tại', deleted: [] };
    const gs = await gitStatus(project.path);
    if (!gs.isRepo) return { ok: false, message: 'project không phải git repo', deleted: [] };
    const cp = run.checkpoint;
    const target = cp.stashRef ?? cp.head;
    const reset = await runCommand(`git reset --hard "${target}"`, project.path, 30_000);
    if (!reset.ok) return { ok: false, message: `reset thất bại: ${reset.stderr.slice(0, 300)}`, deleted: [] };

    // delete untracked files created DURING the run (not present in the snapshot's untracked set)
    const { promises: fs } = await import('node:fs');
    const st = await runCommand('git status --porcelain', project.path, 15_000);
    const snap = new Set(cp.untracked ?? []);
    const pathMod = await import('node:path');
    const deleted: string[] = [];
    for (const line of st.stdout.split('\n')) {
      if (!line.startsWith('??')) continue;
      const f = line.slice(3).trim().replace(/^"|"$/g, '');
      if (!f || snap.has(f)) continue;
      const abs = pathMod.isAbsolute(f) ? f : pathMod.resolve(project.path, f);
      if (!abs.startsWith(pathMod.resolve(project.path))) continue; // safety: workspace-only
      try {
        await fs.rm(abs, { recursive: true, force: true });
        deleted.push(f);
      } catch { /* leave file, report below */ }
    }
    if (cp.stashRef) await runCommand(`git stash drop "${cp.stashRef}"`, project.path, 15_000);
    return { ok: true, message: `workspace đã revert về ${target}`, deleted };
  }

  private async reviewAndIntegrate(run: Run, signal: AbortSignal): Promise<void> {
    const project = this.deps.store.listProjects().find((p) => p.id === run.projectId);
    const projectPath = project?.path ?? process.cwd();

    for (let round = 1; round <= 1 + run.budget.maxRepairRounds; round++) {
      this.setRunStatus(run, 'reviewing');
      const tasks = this.deps.store.listTasksByRun(run.id).filter((t) => t.status === 'completed');
      if (tasks.length === 0) {
        this.setRunStatus(run, 'failed', 'no completed tasks to review');
        return;
      }
      const diff = await gitDiff(projectPath);
      const reviewerModel = await this.pickReviewerModel(run);
      const raw = await this.chatText(run, reviewerModel,
        'You are a strict code reviewer. Review the ACTUAL diff and task summaries against the original request. Find real bugs, security issues, missing requirements. Reply ONLY JSON: {"verdict": "pass"|"fail", "findings": string[]}. An empty diff counts as fail.',
        `Original request:\n${run.prompt}\n\nAcceptance criteria:\n- ${(run.plan?.acceptance ?? []).join('\n- ')}\n\nTask summaries:\n${tasks.map((t) => `- [${t.role}] ${t.title}: ${t.result?.summary ?? ''}`).join('\n')}\n\nActual git diff:\n${diff.slice(0, 60_000) || '(empty diff — nothing was changed)'}`,
        signal,
      );
      const parsed = (extractJson(raw) ?? {}) as { verdict?: string; findings?: string[] };
      const verdict = parsed.verdict === 'pass' ? 'pass' : 'fail';
      run.reviews.push({
        round,
        reviewerModelConfigId: reviewerModel,
        verdict,
        findings: Array.isArray(parsed.findings) ? parsed.findings.map(String).slice(0, 20) : [],
        ts: nowIso(),
      });
      this.deps.store.saveRun(run);
      this.event(run, 'turbo.review', `review round ${round}: ${verdict}`, { modelConfigId: reviewerModel, data: { findings: run.reviews[run.reviews.length - 1]?.findings } });

      if (verdict === 'pass') break;
      if (round > run.budget.maxRepairRounds) {
        this.event(run, 'turbo.review', 'repair budget exhausted; findings remain unresolved', {});
        break;
      }

      // create repair tasks for findings, assign to implementer roles, then re-execute
      this.setRunStatus(run, 'executing');
      const repairSpecs: PlanTaskSpec[] = run.reviews[run.reviews.length - 1]?.findings.map((f, i) => ({
        id: `repair_${round}_${i}`,
        title: `Fix review finding: ${f.slice(0, 60)}`,
        description: f,
        role: 'coder' as Role,
        deps: [],
        files: [],
      })) ?? [];
      if (repairSpecs.length === 0) break;
      const repairTasks = await this.assignAndCreateTasks(run, { ...run.plan!, tasks: repairSpecs });
      await this.executeDag(run, repairTasks, signal);
    }

    // ----- Stage G: integration & verification -----
    this.setRunStatus(run, 'integrating');
    const verifyCommands = this.deps.store.getSettings().verifyCommands;
    const report = { commands: [] as { cmd: string; ok: boolean; output: string; durationMs: number }[], at: nowIso() };
    for (const cmd of verifyCommands) {
      const { runCommand } = await import('./tools.js');
      const res = await runCommand(cmd, projectPath, 300_000, signal);
      report.commands.push({ cmd, ok: res.ok, output: `${res.stdout}\n${res.stderr}`.slice(0, 40_000), durationMs: res.durationMs });
      this.event(run, 'verify.command', `${cmd} -> ${res.ok ? 'PASS' : 'FAIL'}`, { status: res.ok ? 'passed' : 'failed', data: { cmd, exit: res.code } });
    }
    run.testReport = report;
    const allPassed = report.commands.every((c) => c.ok);
    const lastVerdict = run.reviews[run.reviews.length - 1]?.verdict ?? 'pass';
    this.setRunStatus(run, allPassed && lastVerdict === 'pass' ? 'completed' : 'failed',
      allPassed ? undefined : 'verification commands failed or review found unresolved issues');

    this.deps.store.appendMessage(run.sessionId, {
      id: newId('msg'),
      role: 'assistant',
      content: `Turbo run ${run.status}. Plan goal: ${run.plan?.goal ?? run.prompt}\n${run.reviews.map((r) => `Review R${r.round}: ${r.verdict} (${r.findings.length} findings)`).join('\n')}${report.commands.length ? `\nVerification:\n${report.commands.map((c) => `- ${c.cmd}: ${c.ok ? 'PASS' : 'FAIL'}`).join('\n')}` : ''}`,
      meta: { runId: run.id, files: [] },
      ts: nowIso(),
    });
  }

  private async pickReviewerModel(run: Run): Promise<string> {
    const agents = this.deps.store.listAgentProfiles();
    const reviewerAgent = agents.find((a) => run.agentProfileIds.includes(a.id) && a.roles.includes('reviewer'));
    if (reviewerAgent) {
      const mc = this.deps.store.listModelConfigs().find((m) => m.id === reviewerAgent.modelConfigId);
      if (mc) return mc.id;
    }
    return run.modelConfigIds[0];
  }
}
