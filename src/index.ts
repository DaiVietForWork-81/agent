// src/index.ts — app wiring + entrypoint. boots store, registries, orchestrator, api.
import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import { Store } from './store.js';
import { EventBus } from './core.js';
import type { WorkspaceEvent, Credential } from './store.js';
import { ProviderRegistry } from './providers.js';
import { EngineRegistry, BuiltinEngine, OpenCodeEngine } from './engines.js';
import { Orchestrator } from './orchestrator.js';
import { startApi } from './api.js';
import { log } from './core.js';
import type { ChatOptions, ChatResult } from './providers.js';
import { loadConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 7333);
const DATA_DIR = process.env.MADW_DATA_DIR ?? path.join(__dirname, '..', 'data');

async function main(): Promise<void> {
  const store = new Store(path.join(DATA_DIR, 'madw.db'));
  const bus = new EventBus<WorkspaceEvent>();
  const providers = new ProviderRegistry();
  const engines = new EngineRegistry();

  // builtin engine needs a chatFn that resolves credential -> adapter -> chat
  const chatFn = async (modelConfigId: string, opts: ChatOptions): Promise<ChatResult> => {
    const mc = store.listModelConfigs().find((m) => m.id === modelConfigId);
    if (!mc) throw new Error(`model config '${modelConfigId}' not found`);
    const cred = store.listCredentials().find((c: Credential) => c.id === mc.credentialId);    if (!cred) throw new Error(`credential for '${modelConfigId}' not found`);
    const adapter = providers.adapterForCredential(cred);
    return adapter.chat(cred, mc.modelId, opts);
  };
  engines.register(new BuiltinEngine({ chatFn }));
  engines.register(new OpenCodeEngine());

  // on boot: anything that claimed to be running is interrupted (safe resume semantics)
  const interrupted = store.markActiveRunsInterrupted();
  if (interrupted.length) {
    log.warn(`marked ${interrupted.length} run(s) as interrupted on boot`, { runs: interrupted.map((r) => r.id) });
  }

  // orbit.json config (global + first project): theme, verify commands, default engine
  {
    const project0 = store.listProjects()[0];
    const { merged } = await loadConfig(undefined, project0?.path);
    const s = store.getSettings();
    if (merged.theme) s.theme = merged.theme;
    if (merged.verifyCommands?.length) s.verifyCommands = [...new Set([...s.verifyCommands, ...merged.verifyCommands])];
    if (merged.defaultEngineId) s.defaultEngineId = merged.defaultEngineId;
    store.saveSettings(s);
  }

  const orchestrator = new Orchestrator({ store, bus, providers, engines });
  const publicDir = path.join(__dirname, '..', 'public');

  const { port } = await startApi({ store, bus, providers, engines, orchestrator, publicDir, port: PORT });
  log.info(`Orbit listening on http://localhost:${port}`, { dataDir: DATA_DIR, engines: engines.list().map((e) => e.id) });
}

main().catch((e: unknown) => {
  log.error(`fatal: ${(e as Error).stack ?? (e as Error).message}`);
  process.exit(1);
});
