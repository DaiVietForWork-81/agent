// src/core.ts — shared primitives: ids, redaction, structured logging, event bus
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

const SECRET_LINE = /(api[-_]?key|authorization|bearer|password|secret)\s*[:=]\s*("?)[A-Za-z0-9._\-+/=]{8,}\2/gi;
const SK_TOKEN = /\bsk-[A-Za-z0-9._\-]{10,}\b/g;

/** Redact obvious secrets from text before it reaches logs or events. */
export function redact(text: string): string {
  if (!text) return text;
  return text.replace(SK_TOKEN, 'sk-***REDACTED***').replace(SECRET_LINE, (_m, g1) => `${g1}=***REDACTED***`);
}

export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /key|secret|password|authorization|token/i.test(k) && typeof v === 'string' && v.length > 4
        ? '***REDACTED***'
        : redactDeep(v);
    }
    return out as unknown as T;
  }
  return value;
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel: LogLevel = (process.env.MADW_LOG as LogLevel) || 'info';

export function setLogLevel(l: LogLevel) { minLevel = l; }

export const log = {
  debug(msg: string, fields?: Record<string, unknown>) { emit('debug', msg, fields); },
  info(msg: string, fields?: Record<string, unknown>) { emit('info', msg, fields); },
  warn(msg: string, fields?: Record<string, unknown>) { emit('warn', msg, fields); },
  error(msg: string, fields?: Record<string, unknown>) { emit('error', msg, fields); },
};

function emit(level: LogLevel, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const entry = { ts: nowIso(), level, msg: redact(msg), ...(fields ? redactDeep(fields) : {}) };
  const line = JSON.stringify(entry);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Typed in-process pub/sub. Every domain event flows through here. */
export class EventBus<T extends { type: string; ts?: string }> {
  private ee = new EventEmitter();

  constructor() {
    this.ee.setMaxListeners(200);
  }

  publish(evt: T): T {
    const withTs = { ...evt, ts: evt.ts ?? nowIso() } as T;
    this.ee.emit('event', withTs);
    return withTs;
  }

  subscribe(fn: (evt: T) => void): () => void {
    this.ee.on('event', fn);
    return () => this.ee.off('event', fn);
  }
}

/** Extract the first balanced JSON object/array from model output. */
export function extractJson(text: string): unknown | null {
  const cleaned = text.replace(/```(?:json)?\s*/g, '```').split('```');
  const candidates = [text, ...cleaned];
  for (const cand of candidates) {
    const start = cand.search(/[[{]/);
    if (start === -1) continue;
    const open = cand[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < cand.length; i++) {
      const c = cand[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === open) depth++;
      else if (c === close) {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cand.slice(start, i + 1));
          } catch {
            break;
          }
        }
      }
    }
  }
  return null;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    }, { once: true });
  });
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timeout after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number, external?: AbortSignal): Promise<T> {
  const ac = new AbortController();
  const onAbort = () => ac.abort(external?.reason);
  external?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => ac.abort(new TimeoutError(ms)), ms);
  try {
    return await p(ac.signal);
  } finally {
    clearTimeout(timer);
    external?.removeEventListener('abort', onAbort);
  }
}
