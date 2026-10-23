// src/prompts.ts — versioned agent prompts with a LIVE runtime overlay.
// The training loop (src/train.ts) mutates this state between benchmark rounds;
// state is persisted to data/prompt-state.json so runs survive restarts and can roll back.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export const BASE_PROMPT_VERSION = 'v1';

const BASE_ROLE_PROMPTS: Record<string, string> = {
  planner: 'You are a planning agent. Break the goal into verifiable tasks. Do not write code files.',
  architect: 'You are an architecture agent. Design clean, testable structure. Prefer small, verifiable changes.',
  backend: 'You are a backend engineer. Write production-quality code with error handling. Run tests when available.',
  frontend: 'You are a frontend engineer. Build clean, working UI code. Verify by running builds/tests when possible.',
  designer: 'You are a UI/UX design agent. Produce concrete design artifacts (CSS/HTML tokens, component specs).',
  tester: 'You are a test engineer. Write and run tests. Report exact commands and outputs.',
  reviewer: 'You are a code reviewer. Inspect diffs and files for real defects, security issues, and missing requirements. Be evidence-based.',
  researcher: 'You are a research agent. Read the codebase and report findings with file references. Do not modify files.',
  coder: 'You are a general coding agent. Implement the requested change end to end, verify it (tests/build), and finish.',
  chat: 'You are Orbit, a helpful AI assistant inside a developer workspace. Answer concisely in the language the user writes in.',
};

export const BASE_AGENT_RULES = [
  'Work only inside the workspace directory.',
  'Verify your work by running tests/builds when possible before finishing.',
  'If the task is impossible or ambiguous, finish with a summary explaining exactly what is missing instead of guessing.',
  'You have a local expert skill library: use find_skill with short English keywords when entering unfamiliar territory, then read_skill to load relevant guidance before working.',
].join(' ');

interface PromptState {
  version: string;
  rules: string;
  coder?: string;
}

let state: PromptState = { version: BASE_PROMPT_VERSION, rules: BASE_AGENT_RULES };

export function getRolePrompt(role: string): string {
  if (role === 'coder' && state.coder) return state.coder;
  return BASE_ROLE_PROMPTS[role] ?? BASE_ROLE_PROMPTS.coder;
}

export function getAgentRules(): string {
  return state.rules;
}

export function currentPromptVersion(): string {
  return state.version;
}

export function snapshotPromptState(): PromptState {
  return { ...state };
}

export function applyPromptState(next: PromptState): void {
  state = { version: next.version, rules: next.rules, ...(next.coder ? { coder: next.coder } : {}) };
}

export function stateFilePath(dataDir: string): string {
  return `${dataDir}/prompt-state.json`;
}

export function loadPromptState(dataDir: string): PromptState {
  const file = stateFilePath(dataDir);
  try {
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as PromptState;
      if (parsed?.version && parsed?.rules) state = { version: parsed.version, rules: parsed.rules, ...(parsed.coder ? { coder: parsed.coder } : {}) };
    }
  } catch { /* keep current state on parse errors */ }
  return snapshotPromptState();
}

export function savePromptState(dataDir: string): void {
  const file = stateFilePath(dataDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
}

// Back-compat named exports (static views — prefer the getters for live values)
export const ROLE_PROMPTS = BASE_ROLE_PROMPTS;
export const PROMPT_VERSION = BASE_PROMPT_VERSION;
