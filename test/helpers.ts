// test/helpers.ts — mock OpenAI-compatible HTTP server + stub adapter for deterministic orchestration tests
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockServerOptions {
  validKey?: string;
  models?: string[];
  failChatForModels?: string[];
  rateLimitOnce?: boolean;
  stream?: boolean;
  resetOnce?: boolean; // simulate ECONNRESET: destroy socket on first chat request
}

export interface MockServer {
  server: Server;
  baseUrl: string;
  requests: { path: string; auth: string | undefined; body?: unknown }[];
  close: () => Promise<void>;
}

export async function startMockOpenAI(opts: MockServerOptions = {}): Promise<MockServer> {
  const validKey = opts.validKey ?? 'sk-test-valid-key-123456';
  const models = opts.models ?? ['mock-model-1', 'mock-model-2'];
  const requests: MockServer['requests'] = [];
  let rateLimited = false;

  const server = createServer((req, res) => {
    let bodyRaw = '';
    req.on('data', (c) => { bodyRaw += c; });
    req.on('end', () => {
      const auth = req.headers.authorization;
      requests.push({ path: req.url ?? '', auth, body: bodyRaw ? JSON.parse(bodyRaw) : undefined });

      if (req.url === '/v1/models' || req.url === '/models') {
        if (auth !== `Bearer ${validKey}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }

      if (req.url?.includes('/chat/completions')) {
        if (opts.resetOnce && !rateLimited) {
          rateLimited = true; // raw socket destroy, no response — client sees ECONNRESET
          res.socket?.destroy();
          return;
        }
        if (auth !== `Bearer ${validKey}`) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'invalid api key' } }));
          return;
        }
        const body = JSON.parse(bodyRaw || '{}') as { model?: string; stream?: boolean };
        if (opts.failChatForModels?.includes(body.model ?? '')) {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `model ${body.model} does not exist` } }));
          return;
        }
        if (opts.rateLimitOnce && !rateLimited) {
          rateLimited = true;
          res.writeHead(429, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
          return;
        }
        const usage = { prompt_tokens: 12, completion_tokens: 8 };
        if (body.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          const chunks = ['Hello', ' from', ' mock'];
          for (const c of chunks) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
          }
          res.write(`data: ${JSON.stringify({ usage })}\n\n`);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: 'Hello from mock' }, finish_reason: 'stop' }],
          usage,
        }));
        return;
      }

      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'no such endpoint' } }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}/v1`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

// ---------- stub adapter: deterministic multi-stage responses for orchestrator tests ----------

import type { ProviderAdapter, ChatOptions, ChatResult, ChatChunk, Credential } from '../src/providers.js';

export class StubAdapter implements ProviderAdapter {
  id = 'stub';
  label = 'Stub';
  kind = 'http' as const;
  caps = { listModels: 'supported' as const, streaming: 'unsupported' as const, tools: 'supported' as const, vision: 'unsupported' as const, structuredOutput: 'supported' as const };
  calls: { system: string; user: string }[] = [];

  async listModels(): Promise<string[] | null> {
    return ['stub-a', 'stub-b'];
  }

  async verifyCredential(): Promise<{ ok: boolean; models?: string[] }> {
    return { ok: true, models: ['stub-a', 'stub-b'] };
  }

  async chat(_cred: Credential, modelId: string, opts: ChatOptions): Promise<ChatResult> {
    const system = opts.messages.find((m) => m.role === 'system')?.content ?? '';
    const user = opts.messages.find((m) => m.role === 'user')?.content ?? '';
    this.calls.push({ system: system.slice(0, 120), user: user.slice(0, 120) });

    if (system.includes('analysis stage')) {
      return this.json({ goal: 'build the thing', constraints: ['keep it small'], risks: ['scope creep'], open_questions: [] });
    }
    if (system.includes('Propose your own independent')) {
      return this.json({ architecture: 'monolith + tests', plan: ['create util', 'add tests'], risks: [] });
    }
    if (system.includes('Review the OTHER proposals')) {
      return this.json({ agree: ['monolith ok'], disagree: ['util should be pure'], evidence: ['repo has no deps'], revisions: [] });
    }
    if (system.includes('orchestrator synthesizing')) {
      return this.json({
        goal: 'build the thing',
        constraints: ['keep it small'],
        acceptance: ['tests pass'],
        consensus: ['monolith'],
        unresolved: [],
        tasks: [
          { id: 't1', title: 'Implement util', description: 'write util.ts', role: 'backend', deps: [], files: ['src/util.ts'] },
          { id: 't2', title: 'Add tests', description: 'write util.test.ts', role: 'tester', deps: ['t1'], files: ['src/util.test.ts'] },
        ],
      });
    }
    if (system.includes('strict code reviewer')) {
      return this.json({ verdict: 'pass', findings: [] });
    }
    // builtin engine tool-loop: immediately finish
    if (opts.tools?.length) {
      return {
        text: '',
        toolCalls: [{ id: 'call_1', name: 'finish', args: JSON.stringify({ summary: `done by ${modelId}`, files: [] }) }],
        usage: { inputTokens: 5, outputTokens: 5 },
      };
    }
    return { text: 'ok', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } };
  }

  async *chatStream(): AsyncIterable<ChatChunk> {
    yield { delta: 'ok', done: false };
    yield { done: true };
  }

  private json(obj: unknown): ChatResult {
    return { text: JSON.stringify(obj), toolCalls: [], usage: { inputTokens: 10, outputTokens: 10 } };
  }
}
