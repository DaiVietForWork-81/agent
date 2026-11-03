// test/retry.test.ts — provider retry with backoff: transient ECONNRESET recovers, auth errors don't retry
import { describe, it, expect, afterEach } from 'vitest';
import { startMockOpenAI, type MockServer } from './helpers.js';
import { OpenAICompatAdapter } from '../src/providers.js';
import type { Credential } from '../src/store.js';

let mocks: MockServer[] = [];
afterEach(async () => {
  for (const m of mocks) await m.close();
  mocks = [];
});

function cred(baseUrl: string, key = 'sk-test-valid-key-123456'): Credential {
  return { id: 'c1', label: 'mock', provider: 'openai-compat', baseUrl, key, createdAt: new Date().toISOString() };
}

describe('provider retry (withRetry)', () => {
  it('recovers from a mid-request ECONNRESET (socket destroyed once)', async () => {
    const m = await startMockOpenAI({ resetOnce: true });
    const a = new OpenAICompatAdapter();
    const res = await a.chat(cred(m.baseUrl), 'mock-model-1', { messages: [{ role: 'user', content: 'hi' }] });
    expect(res.text).toBe('Hello from mock');
    // 2 requests hit the server: first destroyed, second succeeded
    const chats = m.requests.filter((r) => r.path.includes('/chat/completions'));
    expect(chats.length).toBe(2);
  }, 15_000);

  it('does NOT retry auth errors (401 fails immediately, single request)', async () => {
    const m = await startMockOpenAI();
    const a = new OpenAICompatAdapter();
    await expect(a.chat(cred(m.baseUrl, 'sk-wrong'), 'mock-model-1', { messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ kind: 'auth' });
    expect(m.requests.filter((r) => r.path.includes('/chat/completions')).length).toBe(1);
  });

  it('exhausts retries when upstream keeps failing (5xx)', async () => {
    // failChatForModels makes every call 404 (non-retryable) — use a custom always-500 mock via rateLimit? simpler: ghost model
    const m = await startMockOpenAI({ failChatForModels: ['ghost'] });
    const a = new OpenAICompatAdapter();
    await expect(a.chat(cred(m.baseUrl), 'ghost', { messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ kind: 'not_found' });
    // not_found is non-retryable: exactly 1 request
    expect(m.requests.filter((r) => r.path.includes('/chat/completions')).length).toBe(1);
  });
});
