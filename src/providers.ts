// src/providers.ts — Provider registry + adapters (OpenAI-compatible, Anthropic) + error normalization.
// A provider adapter is the ONLY place that knows wire formats. No provider branching elsewhere.
import { nowIso, withTimeout, TimeoutError } from './core.js';
import type { Credential } from './store.js';

// ---------- Types ----------

export type Cap = 'supported' | 'unsupported' | 'partial' | 'unknown';

export interface ToolCall { id: string; name: string; args: string }

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  name?: string;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON schema
}

export interface ChatOptions {
  messages: WireMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface Usage { inputTokens: number; outputTokens: number }

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason?: string;
  usage?: Usage;
}

export interface ChatChunk {
  delta?: string;
  toolCalls?: ToolCall[];
  done?: boolean;
  usage?: Usage;
}

export type ProviderErrorKind =
  | 'auth' | 'not_found' | 'rate_limit' | 'upstream' | 'timeout' | 'bad_request' | 'network' | 'unknown';

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  status?: number;
  retryable: boolean;

  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
    this.retryable = kind === 'rate_limit' || kind === 'upstream' || kind === 'timeout' || kind === 'network';
  }
}

export function normalizeHttpError(status: number, body: string, modelId?: string): ProviderError {
  const snippet = body.slice(0, 500);
  if (status === 401 || status === 403) return new ProviderError('auth', `auth failed (HTTP ${status}): ${snippet}`, status);
  if (status === 404) {
    const isModel = modelId && snippet.toLowerCase().includes(modelId.toLowerCase());
    return new ProviderError('not_found', isModel ? `model not found: ${modelId}` : `endpoint not found (HTTP 404): ${snippet}`, status);
  }
  if (status === 429) return new ProviderError('rate_limit', `rate limited (HTTP 429): ${snippet}`, status);
  if (status === 400) return new ProviderError('bad_request', `bad request (HTTP 400): ${snippet}`, status);
  if (status >= 500) return new ProviderError('upstream', `upstream error (HTTP ${status}): ${snippet}`, status);
  return new ProviderError('unknown', `HTTP ${status}: ${snippet}`, status);
}

export interface ProviderAdapter {
  id: string;
  label: string;
  kind: 'http' | 'local';
  defaultBaseUrl?: string;
  caps: {
    listModels: Cap;
    streaming: Cap;
    tools: Cap;
    vision: Cap;
    structuredOutput: Cap;
  };
  /** List model IDs from the provider API. Returns null when discovery is unavailable. */
  listModels(cred: Credential, timeoutMs: number): Promise<string[] | null>;
  /** Validate credential with a cheap request. Never echoes the key. */
  verifyCredential(cred: Credential, timeoutMs: number): Promise<{ ok: boolean; error?: string; models?: string[] }>;
  chat(cred: Credential, modelId: string, opts: ChatOptions): Promise<ChatResult>;
  chatStream(cred: Credential, modelId: string, opts: ChatOptions): AsyncIterable<ChatChunk>;
}

// ---------- OpenAI-compatible adapter (covers OpenAI, NVIDIA NIM, DeepSeek, Groq, Together, OpenRouter, Ollama, LM Studio, vLLM, ...) ----------

interface OAChatResponse {
  choices?: { message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAICompatAdapter implements ProviderAdapter {
  id = 'openai-compat';
  label = 'OpenAI-compatible';
  kind: 'http' | 'local' = 'http';
  defaultBaseUrl?: string;
  caps = { listModels: 'supported' as Cap, streaming: 'supported' as Cap, tools: 'supported' as Cap, vision: 'unknown' as Cap, structuredOutput: 'partial' as Cap };

  headers(cred: Credential): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (cred.key) h.authorization = `Bearer ${cred.key}`;
    return h;
  }

  async listModels(cred: Credential, timeoutMs: number): Promise<string[] | null> {
    try {
      const res = await withTimeout(
        (signal) => fetch(this.joinUrl(cred.baseUrl, '/models'), { headers: this.headers(cred), signal }),
        timeoutMs,
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { id?: string }[] };
      const ids = (body.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
      return ids;
    } catch {
      return null;
    }
  }

  async verifyCredential(cred: Credential, timeoutMs: number) {
    const models = await this.listModels(cred, timeoutMs);
    if (models === null) {
      // /models may be blocked; try a minimal chat probe with an explicit unknown model marker
      return { ok: false, error: 'model discovery unavailable or auth failed; enter Model ID manually and run inference test' };
    }
    if (models.length === 0) return { ok: true, models: [] };
    return { ok: true, models };
  }

  async chat(cred: Credential, modelId: string, opts: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: opts.messages.map(toOpenAIMessage),
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    const res = await this.post(cred, '/chat/completions', body, opts);
    const data = (await res.json()) as OAChatResponse;
    const choice = data.choices?.[0];
    const msg = choice?.message;
    return {
      text: msg?.content ?? '',
      toolCalls: (msg?.tool_calls ?? []).map((tc) => ({ id: tc.id, name: tc.function.name, args: tc.function.arguments })),
      finishReason: choice?.finish_reason,
      usage: data.usage ? { inputTokens: data.usage.prompt_tokens ?? 0, outputTokens: data.usage.completion_tokens ?? 0 } : undefined,
    };
  }

  async *chatStream(cred: Credential, modelId: string, opts: ChatOptions): AsyncIterable<ChatChunk> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages: opts.messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    }
    const res = await this.post(cred, '/chat/completions', body, opts);
    if (!res.body) throw new ProviderError('upstream', 'empty stream body');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') {
          yield { done: true };
          return;
        }
        try {
          const j = JSON.parse(payload) as {
            choices?: { delta?: { content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[];
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const delta = j.choices?.[0]?.delta;
          if (delta?.content) yield { delta: delta.content };
          if (delta?.tool_calls?.length) {
            const tcs = delta.tool_calls.map((tc) => ({
              id: tc.id ?? `call_${tc.index}`,
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
            }));
            yield { toolCalls: tcs };
          }
          if (j.usage) yield { usage: { inputTokens: j.usage.prompt_tokens ?? 0, outputTokens: j.usage.completion_tokens ?? 0 } };
        } catch {
          // skip malformed chunk line
        }
      }
    }
    yield { done: true };
  }

  protected joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${path}`;
  }

  private async post(cred: Credential, path: string, body: unknown, opts: ChatOptions): Promise<Response> {
    const modelId = (body as { model?: string }).model;
    try {
      const res = await withTimeout(
        (signal) => fetch(this.joinUrl(cred.baseUrl, path), {
          method: 'POST',
          headers: this.headers(cred),
          body: JSON.stringify(body),
          signal,
        }),
        opts.timeoutMs ?? 120_000,
        opts.signal,
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw normalizeHttpError(res.status, text, modelId);
      }
      return res;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (e instanceof TimeoutError || (e instanceof Error && e.name === 'AbortError')) {
        throw new ProviderError('timeout', `request timed out or was aborted: ${(e as Error).message}`);
      }
      throw new ProviderError('network', `network error: ${(e as Error).message}`);
    }
  }
}

function toOpenAIMessage(m: WireMessage): Record<string, unknown> {
  if (m.role === 'tool') {
    return { role: 'tool', content: m.content, tool_call_id: m.toolCallId };
  }
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })),
    };
  }
  return { role: m.role, content: m.content };
}

// ---------- Anthropic adapter ----------

interface AnthropicResponse {
  content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  stop_reason?: string;
  error?: { type?: string; message?: string };
}

export class AnthropicAdapter implements ProviderAdapter {
  id = 'anthropic';
  label = 'Anthropic API';
  kind = 'http' as const;
  defaultBaseUrl = 'https://api.anthropic.com';
  caps = { listModels: 'supported' as Cap, streaming: 'partial' as Cap, tools: 'supported' as Cap, vision: 'partial' as Cap, structuredOutput: 'partial' as Cap };

  private headers(cred: Credential): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': cred.key,
      'anthropic-version': '2023-06-01',
    };
  }

  private joinUrl(baseUrl: string, path: string): string {
    return `${baseUrl.replace(/\/+$/, '')}${path}`;
  }

  async listModels(cred: Credential, timeoutMs: number): Promise<string[] | null> {
    try {
      const res = await withTimeout(
        (signal) => fetch(this.joinUrl(cred.baseUrl, '/v1/models'), { headers: this.headers(cred), signal }),
        timeoutMs,
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { id?: string }[] };
      return (body.data ?? []).map((m) => m.id).filter((x): x is string => Boolean(x));
    } catch {
      return null;
    }
  }

  async verifyCredential(cred: Credential, timeoutMs: number) {
    const models = await this.listModels(cred, timeoutMs);
    if (models === null) return { ok: false, error: 'model discovery unavailable; enter Model ID manually and run inference test' };
    return { ok: true, models };
  }

  private toAnthropicMessages(messages: WireMessage[]): { system: string; messages: Record<string, unknown>[] } {
    let system = '';
    const out: Record<string, unknown>[] = [];
    for (const m of messages) {
      if (m.role === 'system') {
        system += (system ? '\n' : '') + m.content;
        continue;
      }
      if (m.role === 'tool') {
        out.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] });
        continue;
      }
      if (m.role === 'assistant' && m.toolCalls?.length) {
        const content: Record<string, unknown>[] = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const tc of m.toolCalls) {
          let input: unknown = {};
          try { input = JSON.parse(tc.args || '{}'); } catch { input = { _raw: tc.args }; }
          content.push({ type: 'tool_use', id: tc.id, name: tc.name, input });
        }
        out.push({ role: 'assistant', content });
        continue;
      }
      out.push({ role: m.role, content: m.content });
    }
    return { system, messages: out };
  }

  async chat(cred: Credential, modelId: string, opts: ChatOptions): Promise<ChatResult> {
    const { system, messages } = this.toAnthropicMessages(opts.messages);
    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature,
      messages,
    };
    if (system) body.system = system;
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    }
    let res: Response;
    try {
      res = await withTimeout(
        (signal) => fetch(this.joinUrl(cred.baseUrl, '/v1/messages'), {
          method: 'POST',
          headers: this.headers(cred),
          body: JSON.stringify(body),
          signal,
        }),
        opts.timeoutMs ?? 120_000,
        opts.signal,
      );
    } catch (e) {
      if (e instanceof TimeoutError || (e instanceof Error && e.name === 'AbortError')) {
        throw new ProviderError('timeout', `request timed out: ${(e as Error).message}`);
      }
      throw new ProviderError('network', `network error: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw normalizeHttpError(res.status, text, modelId);
    }
    const data = (await res.json()) as AnthropicResponse;
    let text = '';
    const toolCalls: ToolCall[] = [];
    for (const block of data.content ?? []) {
      if (block.type === 'text' && block.text) text += block.text;
      if (block.type === 'tool_use' && block.id && block.name) {
        toolCalls.push({ id: block.id, name: block.name, args: JSON.stringify(block.input ?? {}) });
      }
    }
    return {
      text,
      toolCalls,
      finishReason: data.stop_reason,
      usage: data.usage ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 } : undefined,
    };
  }

  async *chatStream(cred: Credential, modelId: string, opts: ChatOptions): AsyncIterable<ChatChunk> {
    // v1: stream via one-shot chat then emit (honest 'partial' capability, no fake token streaming)
    const result = await this.chat(cred, modelId, opts);
    if (result.text) yield { delta: result.text };
    if (result.toolCalls.length) yield { toolCalls: result.toolCalls };
    if (result.usage) yield { usage: result.usage };
    yield { done: true };
  }
}

// ---------- Ollama adapter (OpenAI-compatible endpoint + /api/tags discovery) ----------

export class OllamaAdapter extends OpenAICompatAdapter {
  override id = 'ollama';
  override label = 'Ollama (local)';
  override kind = 'local' as const;
  override defaultBaseUrl = 'http://127.0.0.1:11434';

  override async listModels(cred: Credential, timeoutMs: number): Promise<string[] | null> {
    try {
      const res = await withTimeout(
        (signal) => fetch(this.joinUrl(cred.baseUrl, '/api/tags'), { signal }),
        timeoutMs,
      );
      if (!res.ok) return null;
      const body = (await res.json()) as { models?: { name?: string }[] };
      return (body.models ?? []).map((m) => m.name).filter((x): x is string => Boolean(x));
    } catch {
      return null;
    }
  }

  override async verifyCredential(cred: Credential, timeoutMs: number) {
    const models = await this.listModels(cred, timeoutMs);
    if (models === null) return { ok: false, error: `Ollama not reachable at ${cred.baseUrl} — is the server running?` };
    return { ok: true, models };
  }
}

// ---------- Catalog: named presets so users never have to memorize base URLs ----------

export interface ProviderPreset {
  id: string;
  label: string;
  adapter: string;         // adapter id used for wire format
  defaultBaseUrl: string;
  authScheme: 'bearer' | 'x-api-key' | 'none';
  notes?: string;
}

export const PROVIDER_CATALOG: ProviderPreset[] = [
  { id: 'openai', label: 'OpenAI', adapter: 'openai-compat', defaultBaseUrl: 'https://api.openai.com/v1', authScheme: 'bearer' },
  { id: 'anthropic', label: 'Anthropic', adapter: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com', authScheme: 'x-api-key' },
  { id: 'nvidia', label: 'NVIDIA Build / NIM', adapter: 'openai-compat', defaultBaseUrl: 'https://integrate.api.nvidia.com/v1', authScheme: 'bearer', notes: 'Model discovery may be limited; manual Model ID supported' },
  { id: 'deepseek', label: 'DeepSeek', adapter: 'openai-compat', defaultBaseUrl: 'https://api.deepseek.com/v1', authScheme: 'bearer' },
  { id: 'groq', label: 'Groq', adapter: 'openai-compat', defaultBaseUrl: 'https://api.groq.com/openai/v1', authScheme: 'bearer' },
  { id: 'together', label: 'Together AI', adapter: 'openai-compat', defaultBaseUrl: 'https://api.together.xyz/v1', authScheme: 'bearer' },
  { id: 'openrouter', label: 'OpenRouter', adapter: 'openai-compat', defaultBaseUrl: 'https://openrouter.ai/api/v1', authScheme: 'bearer' },
  { id: 'mistral', label: 'Mistral', adapter: 'openai-compat', defaultBaseUrl: 'https://api.mistral.ai/v1', authScheme: 'bearer' },
  { id: 'xai', label: 'xAI', adapter: 'openai-compat', defaultBaseUrl: 'https://api.x.ai/v1', authScheme: 'bearer' },
  { id: 'ollama', label: 'Ollama (local)', adapter: 'ollama', defaultBaseUrl: 'http://127.0.0.1:11434', authScheme: 'none' },
  { id: 'lmstudio', label: 'LM Studio (local)', adapter: 'openai-compat', defaultBaseUrl: 'http://127.0.0.1:1234/v1', authScheme: 'none' },
  { id: 'custom', label: 'Custom OpenAI-compatible', adapter: 'openai-compat', defaultBaseUrl: 'http://localhost:8000/v1', authScheme: 'bearer', notes: 'Any gateway: LiteLLM, vLLM, SGLang, LocalAI, ...' },
];

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  constructor() {
    this.register(new OpenAICompatAdapter());
    this.register(new AnthropicAdapter());
    this.register(new OllamaAdapter());
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  getAdapter(adapterId: string): ProviderAdapter {
    const a = this.adapters.get(adapterId);
    if (!a) throw new ProviderError('unknown', `no adapter registered for provider '${adapterId}'`);
    return a;
  }

  adapterForCredential(cred: Credential): ProviderAdapter {
    const preset = PROVIDER_CATALOG.find((p) => p.id === cred.provider);
    if (preset) return this.getAdapter(preset.adapter);
    // allow directly-registered adapter ids (custom adapters, test stubs)
    if (this.adapters.has(cred.provider)) return this.adapters.get(cred.provider) as ProviderAdapter;
    return this.getAdapter('openai-compat');
  }

  listPresets(): ProviderPreset[] {
    return [...PROVIDER_CATALOG];
  }

  listAdapters(): { id: string; label: string; caps: ProviderAdapter['caps'] }[] {
    return [...this.adapters.values()].map((a) => ({ id: a.id, label: a.label, caps: a.caps }));
  }
}

export function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return '*'.repeat(key.length);
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

export function publicCredential(c: Credential): Record<string, unknown> {
  return { id: c.id, label: c.label, provider: c.provider, baseUrl: c.baseUrl, keyMasked: maskKey(c.key), createdAt: c.createdAt, hasKey: Boolean(c.key) };
}

export function verifyModelInference(
  adapter: ProviderAdapter,
  cred: Credential,
  modelId: string,
  timeoutMs: number,
): Promise<{ ok: boolean; error?: string; sample?: string }> {
  return adapter.chat(cred, modelId, {
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
    maxTokens: 200, // reasoning models burn tokens thinking before answering — 10 was too low
    timeoutMs,
  }).then((r) => {
    const sample = r.text.trim().slice(0, 50);
    return {
      ok: true,
      sample: sample || `(empty text; finish=${r.finishReason ?? 'unknown'} - possibly reasoning-only response)`,
    };
  }).catch((e: unknown) => {
    const pe = e as ProviderError;
    return { ok: false, error: `${pe.kind ?? 'unknown'}: ${(pe as Error).message}` };
  });
}

export function nowIsoProvider(): string { return nowIso(); }
