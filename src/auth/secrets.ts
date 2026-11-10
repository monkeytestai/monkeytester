/**
 * One run-scoped list of credential needles. Sinks scrub the raw value and
 * the usual encodings before they log, emit, prompt, or persist.
 * JavaScript strings cannot be wiped from the heap. `release` only drops
 * our references.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLM } from '../llm/index.js';

interface Scope {
  needles: string[];
}

const storage = new AsyncLocalStorage<Scope>();
const attached = new WeakMap<object, string[]>();
let consoleDepth = 0;
let restoreConsole: (() => void) | undefined;

export function secretVariants(secret: string): string[] {
  if (secret.length < 4) return [];
  const found = new Set<string>([secret]);
  if (secret.length < 8) return [...found];
  const encoded = encodeURIComponent(secret);
  if (encoded !== secret) found.add(encoded);
  const twice = encodeURIComponent(encoded);
  if (twice !== encoded) found.add(twice);
  const b64 = Buffer.from(secret, 'utf8').toString('base64');
  found.add(b64);
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  if (b64url !== b64) found.add(b64url);
  return [...found];
}

function addNeedles(scope: Scope, values: string[]): void {
  const seen = new Set(scope.needles);
  for (const value of values) {
    if (value.length < 4 || seen.has(value)) continue;
    seen.add(value);
    scope.needles.push(value);
  }
  scope.needles.sort((a, b) => b.length - a.length);
}

export function registerSecrets(secrets: string[]): void {
  const scope = storage.getStore();
  if (!scope) return;
  const variants: string[] = [];
  for (const secret of secrets) variants.push(...secretVariants(secret));
  addNeedles(scope, variants);
}

/** Keep username and password with the jar object, not with the input record. */
export function rememberSecrets(holder: object | undefined, secrets: string[]): void {
  if (!holder) return;
  const variants: string[] = [];
  for (const secret of secrets) variants.push(...secretVariants(secret));
  const merged = new Set([...(attached.get(holder) ?? []), ...variants]);
  attached.set(holder, [...merged].sort((a, b) => b.length - a.length));
  registerSecrets(secrets);
}

export function attachedSecrets(holder: object | undefined): string[] {
  if (!holder) return [];
  return attached.get(holder) ?? [];
}

export function adoptAttached(holder: object | undefined): void {
  const scope = storage.getStore();
  if (!scope || !holder) return;
  addNeedles(scope, attached.get(holder) ?? []);
}

export function activeNeedles(): string[] {
  return storage.getStore()?.needles ?? [];
}

export function scrubString(text: string, extra: string[] = []): string {
  const needles = [...extra, ...activeNeedles()].filter(needle => needle.length >= 4);
  if (needles.length === 0 || !text) return text;
  const unique = [...new Set(needles)].sort((a, b) => b.length - a.length);
  let out = text;
  for (const needle of unique) out = out.split(needle).join('[redacted]');
  return out;
}

export function scrubUnknown<T>(value: T, extra: string[] = []): T {
  const needles = [...extra, ...activeNeedles()];
  if (needles.length === 0) return value;
  if (typeof value === 'string') return scrubString(value, extra) as T;
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.map(item => scrubUnknown(item, extra)) as T;
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (needles.some(needle => needle.length >= 4 && key.includes(needle))) continue;
      out[scrubString(key, extra)] = scrubUnknown(inner, extra);
    }
    return out as T;
  }
  return value;
}

export async function absorbPageSecrets(page: {
  context(): { storageState(): Promise<{ cookies?: Array<{ value?: string }>; origins?: Array<{ localStorage?: Array<{ value?: string }> }> }> };
}): Promise<void> {
  const state = await page.context().storageState().catch(() => undefined);
  if (!state) return;
  const values: string[] = [];
  for (const cookie of state.cookies || []) if (cookie.value) values.push(cookie.value);
  for (const origin of state.origins || []) {
    for (const item of origin.localStorage || []) if (item.value) values.push(item.value);
  }
  registerSecrets(values);
}

function patchConsole(): () => void {
  const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
  const saved = methods.map(name => [name, console[name]] as const);
  const scrubArg = (arg: unknown): unknown => {
    if (typeof arg === 'string') return scrubString(arg);
    if (arg instanceof Error) {
      const error = new Error(scrubString(arg.message));
      if (arg.stack) error.stack = scrubString(arg.stack);
      return error;
    }
    if (typeof arg === 'object' && arg) {
      try { return JSON.parse(scrubString(JSON.stringify(arg))); }
      catch { return '[omitted]'; }
    }
    return arg;
  };
  for (const name of methods) {
    console[name] = ((...args: unknown[]) => {
      saved.find(entry => entry[0] === name)?.[1](...args.map(scrubArg));
    }) as typeof console.log;
  }
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), callback?: (err?: Error | null) => void) => {
    const text = typeof chunk === 'string' ? scrubString(chunk) : chunk;
    return stdout(text, encoding as BufferEncoding, callback);
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((err?: Error | null) => void), callback?: (err?: Error | null) => void) => {
    const text = typeof chunk === 'string' ? scrubString(chunk) : chunk;
    return stderr(text, encoding as BufferEncoding, callback);
  }) as typeof process.stderr.write;
  return () => {
    for (const [name, fn] of saved) console[name] = fn;
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  };
}

export async function withSensitiveSinks<T>(secrets: string[], fn: () => Promise<T>): Promise<T> {
  const parent = storage.getStore();
  const scope: Scope = { needles: parent ? [...parent.needles] : [] };
  return storage.run(scope, async () => {
    registerSecrets(secrets);
    consoleDepth += 1;
    if (consoleDepth === 1) restoreConsole = patchConsole();
    try {
      return await fn();
    } finally {
      consoleDepth -= 1;
      if (consoleDepth === 0 && restoreConsole) {
        restoreConsole();
        restoreConsole = undefined;
      }
    }
  });
}

export function scrubModel<T extends LLM>(llm: T): T {
  return {
    providerLabel: llm.providerLabel,
    get lastUsage() { return llm.lastUsage; },
    async generateJSON(opts) {
      const safe = {
        ...opts,
        prompt: scrubString(opts.prompt),
        ...(opts.system ? { system: scrubString(opts.system) } : {}),
        ...(opts.cacheable ? { cacheable: scrubString(opts.cacheable) } : {}),
      };
      try {
        return scrubUnknown(await llm.generateJSON(safe));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(scrubString(message));
      }
    },
  } as T;
}
