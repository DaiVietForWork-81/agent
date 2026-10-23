// src/tools.ts — workspace tools with permission gating: fs, shell, git.
// Every tool call passes through PermissionManager. High-risk ops require approval.
import { spawn } from 'node:child_process';
import { promises as fs, existsSync } from 'node:fs';
import * as path from 'node:path';
import { nowIso, redact } from './core.js';

export interface Permissions {
  allowRead: boolean;
  allowWrite: boolean;
  allowDelete: boolean;
  allowShell: 'none' | 'safe' | 'all';
  allowNetworkTools: boolean;
  workspaceOnly: boolean; // confine fs ops to the project dir
}

export const DEFAULT_PERMISSIONS: Permissions = {
  allowRead: true,
  allowWrite: true,
  allowDelete: false,
  allowShell: 'safe',
  allowNetworkTools: false,
  workspaceOnly: true,
};

export class PermissionDenied extends Error {
  constructor(public operation: string, public reason: string) {
    super(`permission denied for '${operation}': ${reason}`);
    this.name = 'PermissionDenied';
  }
}

export class PermissionManager {
  constructor(private perms: Permissions, private projectPath: string) {}

  checkRead(p: string): void {
    if (!this.perms.allowRead) throw new PermissionDenied('read', 'allowRead is off');
    this.checkPath(p);
  }

  checkWrite(p: string): void {
    if (!this.perms.allowWrite) throw new PermissionDenied('write', 'allowWrite is off');
    this.checkPath(p);
  }

  checkDelete(p: string): void {
    if (!this.perms.allowDelete) throw new PermissionDenied('delete', 'allowDelete is off');
    this.checkPath(p);
  }

  checkShell(cmd: string): { allowed: boolean; reason?: string } {
    if (this.perms.allowShell === 'none') return { allowed: false, reason: 'shell execution disabled' };
    if (this.perms.allowShell === 'all') return { allowed: true };
    if (isSafeCommand(cmd)) return { allowed: true };
    return { allowed: false, reason: `command not in safe allowlist and allowShell='safe' — requires user approval` };
  }

  private checkPath(p: string): void {
    const abs = path.isAbsolute(p) ? p : path.resolve(this.projectPath, p);
    if (this.perms.workspaceOnly && !abs.startsWith(path.resolve(this.projectPath))) {
      throw new PermissionDenied('path', `outside workspace: ${redact(abs)}`);
    }
  }
}

const SAFE_COMMAND_PREFIXES = [
  'node', 'node --version', 'node -v', 'npm test', 'npm run', 'npx tsc', 'tsc ', 'vitest', 'npx vitest',
  'npm install', 'npm ci', 'pytest', 'python -m pytest', 'cargo test', 'cargo build', 'go test', 'go build',
  'git status', 'git diff', 'git log', 'git branch', 'git add', 'git commit', 'git worktree list',
  'ls', 'dir', 'cat ', 'type ', 'echo ', 'ruff', 'eslint', 'prettier', 'mypy', 'pyright',
];

export function isSafeCommand(cmd: string): boolean {
  const c = cmd.trim().toLowerCase();
  const first = c.split(/\s+/)[0];
  if (['rm', 'rmdir', 'del', 'rd', 'format', 'shutdown', 'reg', 'remove-item', 'dd', 'mkfs'].includes(first)) return false;
  if (/[;&|`$>]{2,}|>\s*\w|&&|\|\|/.test(cmd)) return false; // no chaining/redirect tricks
  return SAFE_COMMAND_PREFIXES.some((p) => c.startsWith(p.trim()) || c.startsWith(p));
}

export interface CommandResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export function runCommand(cmd: string, cwd: string, timeoutMs = 60_000, signal?: AbortSignal): Promise<CommandResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const shellPath = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', cmd] : ['-c', cmd];
    const child = spawn(shellPath, shellArgs, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); if (stdout.length > 200_000) stdout = stdout.slice(-200_000); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); if (stderr.length > 100_000) stderr = stderr.slice(-100_000); });
    child.on('error', (err) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}${err.message}`, timedOut, durationMs: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

// ---------- Git helpers (porcelain, read-only by default) ----------

export async function gitStatus(cwd: string, timeoutMs = 15_000): Promise<{ isRepo: boolean; porcelain: string; branch?: string }> {
  const branchRes = await runCommand('git rev-parse --abbrev-ref HEAD', cwd, timeoutMs);
  const statusRes = await runCommand('git status --porcelain', cwd, timeoutMs);
  const isRepo = branchRes.ok && statusRes.ok;
  return { isRepo, porcelain: statusRes.stdout, branch: branchRes.stdout.trim() || undefined };
}

export async function gitDiff(cwd: string, timeoutMs = 20_000): Promise<string> {
  const res = await runCommand('git diff HEAD --stat && git diff HEAD', cwd, timeoutMs);
  return (res.stdout + (res.stderr ? `\n[stderr] ${res.stderr}` : '')).slice(0, 100_000);
}

export async function repoTreeSummary(cwd: string, maxEntries = 120): Promise<string> {
  try {
    const entries = await fs.readdir(cwd, { withFileTypes: true });
    const skip = new Set(['node_modules', '.git', 'dist', '__pycache__', '.venv', 'venv', 'target', '.next']);
    const lines = entries
      .filter((e) => !skip.has(e.name))
      .slice(0, maxEntries)
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
    return lines.join('\n');
  } catch (e) {
    return `[cannot read dir: ${(e as Error).message}]`;
  }
}

// ---------- Tool set exposed to agent models ----------

export interface ToolContext {
  projectPath: string;
  perms: PermissionManager;
  onAction?: (action: { tool: string; args: Record<string, unknown>; result: string; ok: boolean; ts: string }) => void;
}

export const TOOL_SPECS = [
  {
    name: 'read_file',
    description: 'Read a workspace text file. Args: {path}',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'write_file',
    description: 'Create/overwrite a workspace file with full content. Args: {path, content}',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
  },
  {
    name: 'list_dir',
    description: 'List a directory. Args: {path} (default "."))',
    parameters: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'run_command',
    description: 'Run a shell command (tests, builds). Permission-gated. Args: {command, timeoutMs?}',
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeoutMs: { type: 'number' } }, required: ['command'] },
  },
  {
    name: 'git_status',
    description: 'Get git status of the workspace. Args: {}',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'git_diff',
    description: 'Get current diff of the workspace. Args: {}',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'finish',
    description: 'Finish the task. Args: {summary, files} — files: array of file paths you created/modified',
    parameters: { type: 'object', properties: { summary: { type: 'string' }, files: { type: 'array', items: { type: 'string' } } }, required: ['summary'] },
  },
] as const;

export function resolveWorkspacePath(ctx: ToolContext, p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(ctx.projectPath, p);
}

const SKILLS_ROOT = process.env.ORBIT_SKILLS_DIR ?? 'D:\\Skills';

function spawnNodeCapture(script: string, args: string[], timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { windowsHide: true, shell: false });
    let out = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { out += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); resolve(`skill search error: ${err.message}`); });
    child.on('close', () => { clearTimeout(timer); resolve(out.trim()); });
  });
}

export async function executeTool(ctx: ToolContext, name: string, argsJson: string): Promise<{ ok: boolean; output: string }> {
  let args: Record<string, unknown> = {};
  try { args = JSON.parse(argsJson || '{}') as Record<string, unknown>; } catch { return { ok: false, output: 'invalid JSON arguments' }; }
  const ts = nowIso();
  let ok = true;
  let output = '';
  try {
    switch (name) {
      case 'read_file': {
        const p = resolveWorkspacePath(ctx, String(args.path));
        ctx.perms.checkRead(p);
        output = (await fs.readFile(p, 'utf8')).slice(0, 20_000);
        if (output.length >= 20_000) output += '\n...[truncated at 20k chars - read specific ranges if needed]';
        break;
      }
      case 'write_file': {
        const p = resolveWorkspacePath(ctx, String(args.path));
        ctx.perms.checkWrite(p);
        await fs.mkdir(path.dirname(p), { recursive: true });
        // models sometimes pass content as an object (e.g. package.json) — serialize instead of "[object Object]"
        const rawContent = args.content;
        const content = typeof rawContent === 'string'
          ? rawContent
          : rawContent !== null && typeof rawContent === 'object'
            ? JSON.stringify(rawContent, null, 2)
            : String(rawContent ?? '');
        await fs.writeFile(p, content, 'utf8');
        output = `wrote ${String(args.path)} (${content.length} chars)`;
        break;
      }
      case 'list_dir': {
        const rel = String(args.path ?? '.');
        const p = resolveWorkspacePath(ctx, rel);
        ctx.perms.checkRead(p);
        const entries = await fs.readdir(p, { withFileTypes: true });
        output = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('\n') || '(empty)';
        break;
      }
      case 'run_command': {
        const cmd = String(args.command);
        const gate = ctx.perms.checkShell(cmd);
        if (!gate.allowed) {
          ok = false;
          output = `BLOCKED: ${gate.reason}. Command: ${cmd}`;
          break;
        }
        const res = await runCommand(cmd, ctx.projectPath, Number(args.timeoutMs) || 120_000);
        ok = res.ok;
        output = `exit=${res.code}${res.timedOut ? ' TIMED_OUT' : ''}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`.slice(0, 60_000);
        break;
      }
      case 'git_status': {
        const st = await gitStatus(ctx.projectPath);
        output = st.isRepo ? `branch: ${st.branch}\n${st.porcelain || '(clean)'}` : '(not a git repository)';
        break;
      }
      case 'git_diff': {
        output = (await gitDiff(ctx.projectPath)).slice(0, 60_000) || '(no diff)';
        break;
      }
      case 'find_skill': {
        const q = String(args.query ?? '').trim().slice(0, 120);
        if (!q) { ok = false; output = 'query required'; break; }
        const script = path.join(SKILLS_ROOT, 'tools', 'find-skill.mjs');
        if (!existsSync(script)) { ok = false; output = 'skill library not found at ' + SKILLS_ROOT; break; }
        output = (await spawnNodeCapture(script, [q, '--limit', '3'])).slice(0, 4000);
        break;
      }
      case 'read_skill': {
        const rp = resolveWorkspacePath(ctx, String(args.path));
        const norm = path.normalize(rp);
        if (!norm.toLowerCase().startsWith(path.normalize(SKILLS_ROOT).toLowerCase())) {
          ok = false; output = 'read_skill only accepts paths inside the skill library'; break;
        }
        if (!norm.toLowerCase().endsWith('skill.md')) { ok = false; output = 'only SKILL.md files can be loaded'; break; }
        if (!existsSync(norm)) { ok = false; output = 'skill file not found'; break; }
        output = (await fs.readFile(norm, 'utf8')).slice(0, 12_000);
        break;
      }
      case 'finish': {
        output = JSON.stringify({ summary: String(args.summary ?? ''), files: Array.isArray(args.files) ? args.files : [] });
        break;
      }
      default:
        ok = false;
        output = `unknown tool: ${name}`;
    }
  } catch (e) {
    ok = false;
    output = `error: ${(e as Error).message}`;
  }
  ctx.onAction?.({ tool: name, args, result: output.slice(0, 2000), ok, ts });
  return { ok, output };
}
