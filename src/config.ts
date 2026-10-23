// src/config.ts — orbit.json config loading (global + project), OpenCode-config-style.
// API keys intentionally NOT supported here — credentials live in the encrypted-ish store.
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface OrbitConfig {
  theme?: string;
  verifyCommands?: string[];
  defaultEngineId?: string;
  permissions?: 'plan' | 'build' | 'full';
  /** Custom slash commands: name -> prompt template. $ARGUMENTS is replaced with user text. */
  commands?: Record<string, string>;
}

export const CONFIG_FILE = 'orbit.json';

export function globalConfigPath(): string {
  return path.join(os.homedir(), '.config', 'orbit', CONFIG_FILE);
}

export function projectConfigPath(projectPath: string): string {
  return path.join(projectPath, CONFIG_FILE);
}

async function readOne(file: string): Promise<OrbitConfig | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as OrbitConfig;
    if (parsed && typeof parsed === 'object') return parsed;
    return null;
  } catch {
    return null;
  }
}

export function mergeConfigs(base: OrbitConfig | null, ...layers: (OrbitConfig | null)[]): OrbitConfig {
  const out: OrbitConfig = {};
  for (const layer of [base, ...layers]) {
    if (!layer) continue;
    if (layer.theme !== undefined) out.theme = layer.theme;
    if (layer.defaultEngineId !== undefined) out.defaultEngineId = layer.defaultEngineId;
    if (layer.permissions !== undefined) out.permissions = layer.permissions;
    if (layer.verifyCommands?.length) out.verifyCommands = [...(out.verifyCommands ?? []), ...layer.verifyCommands];
    if (layer.commands) out.commands = { ...(out.commands ?? {}), ...layer.commands };
  }
  return out;
}

export async function loadConfig(globalPath?: string, projectPath?: string): Promise<{ global: OrbitConfig | null; project: OrbitConfig | null; merged: OrbitConfig }> {
  const g = await readOne(globalPath ?? globalConfigPath());
  const p = projectPath ? await readOne(projectConfigPath(projectPath)) : null;
  return { global: g, project: p, merged: mergeConfigs(g, p) };
}

/** Expand a custom command template: $ARGUMENTS -> user text. */
export function expandCommand(template: string, args: string): string {
  return template.replace(/\$ARGUMENTS/g, args.trim());
}
