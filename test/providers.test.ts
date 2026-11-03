// test/providers.test.ts — OpenAI-compat adapter against a local mock server (no real API calls)
import { describe, it, expect, afterEach } from 'vitest';
import { startMockOpenAI, type MockServer } from './helpers.js';
import { OpenAICompatAdapter, ProviderError } from '../src/providers.js';
import type { Credential } from '../src/store.js';

let mocks: MockServer[] = [];

async function make(opts = {}) {
  const m = await startMockOpenAI(opts);
  mocks.push(m);
  return m;
}

afterEach(async () => {
  for (const m of mocks) await m.close();
  mocks = [];
});

function cred(baseUrl: string, key = 'sk-test-valid-key-123456'): Credential {
  return { id: 'c1', label: 'mock', provider: 'openai-compat', baseUrl, key, createdAt: new Date().toISOString() };
}

describe('OpenAI-compatible adapter', () => {
  it('discovers models', async () => {
    const m = await make();
    const a = new OpenAICompatAdapter();
    const models = await a.listModels(cred(m.baseUrl), 5000);
    expect(models).toEqual(['mock-model-1', 'mock-model-2']);
  });

  it('verifies valid and rejects invalid credentials without leaking the key', async () => {
    const m = await make();
    const a = new OpenAICompatAdapter();
    const ok = await a.verifyCredential(cred(m.baseUrl), 5000);
    expect(ok.ok).toBe(true);
    expect(ok.models).toHaveLength(2);

    const bad = cred(m.baseUrl, 'sk-totally-wrong-key');
    const badRes = await a.verifyCredential(bad, 5000);
    expect(badRes.ok).toBe(false);
    expect(JSON.stringify(badRes)).not.toContain('sk-totally-wrong-key');
  });

  it('chats and reports usage', async () => {
    const m = await make();
    const a = new OpenAICompatAdapter();
    const res = await a.chat(cred(m.baseUrl), 'mock-model-1', {
      messages: [{ role: 'user', content: 'hi' }],
    });
    expect(res.text).toBe('Hello from mock');
    expect(res.usage?.inputTokens).toBe(12);
    const chatReq = m.requests.find((r) => r.path.includes('/chat/completions'));
    expect(chatReq?.auth).toBe('Bearer sk-test-valid-key-123456');
  });

  it('streams chunks', async () => {
    const m = await make();
    const a = new OpenAICompatAdapter();
    const chunks: string[] = [];
    for await (const chunk of a.chatStream(cred(m.baseUrl), 'mock-model-1', { messages: [{ role: 'user', content: 'hi' }] })) {
      if (chunk.delta) chunks.push(chunk.delta);
    }
    expect(chunks.join('')).toBe('Hello from mock');
  });

  it('normalizes model-not-found vs auth vs rate limit', async () => {
    const m = await make({ failChatForModels: ['ghost-model'] });
    const a = new OpenAICompatAdapter();

    await expect(a.chat(cred(m.baseUrl), 'ghost-model', { messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ kind: 'not_found' });

    await expect(a.chat(cred(m.baseUrl, 'sk-bad'), 'mock-model-1', { messages: [{ role: 'user', content: 'x' }] }))
      .rejects.toMatchObject({ kind: 'auth' });

    const m2 = await make({ rateLimitOnce: true });
    // retry-once policy: first attempt hits 429, adapter backs off and succeeds on attempt 2
    const res = await a.chat(cred(m2.baseUrl), 'mock-model-1', { messages: [{ role: 'user', content: 'x' }] });
    expect(res.text).toBe('Hello from mock');
    expect(m2.requests.filter((r) => r.path.includes('/chat/completions')).length).toBe(2);
  });

  it('never includes the api key in thrown error messages', async () => {
    const m = await make();
    const a = new OpenAICompatAdapter();
    try {
      await a.chat(cred(m.baseUrl, 'sk-secret-key-value-9876'), 'ghost-model', { messages: [{ role: 'user', content: 'x' }] });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as Error).message).not.toContain('sk-secret-key-value-9876');
    }
  });
});
