/**
 * Keep known secrets out of logs, prompts, and saved plans/runs.
 * Signed-in page text can still contain private application data.
 * That data is not claimed to be scrubbed.
 */

import { activeNeedles, attachedSecrets, scrubString } from './secrets.js';

export { attachedSecrets };

const FORBIDDEN_KEYS = new Set([
  'storagestate',
  'cookies',
  'cookie',
  'setcookie',
  'localstorage',
  'password',
  'passwd',
  'authorization',
  'proxyauthorization',
  'accesstoken',
  'refreshtoken',
  'idtoken',
  'otp',
  'otpseed',
  'secret',
  'clientsecret',
  'sessiontoken',
]);

const pageSecrets = new WeakMap<object, string[]>();
const noCapture = new WeakSet<object>();

function normalKey(key: string): string {
  return key.toLowerCase().replace(/[_-]/g, '');
}

export function persistReplacer(key: string, value: unknown): unknown {
  if (key && FORBIDDEN_KEYS.has(normalKey(key))) return undefined;
  if (typeof value === 'string') return scrubString(value);
  return value;
}

export function stringifyPersisted(value: unknown): string {
  return JSON.stringify(value, persistReplacer, 2);
}

export function redactSecrets(text: string, secrets: string[]): string {
  return scrubString(text, secrets.filter(secret => secret.length >= 4));
}

export function redactError(err: unknown, secrets: string[]): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const error = new Error(redactSecrets(raw, secrets));
  if (err instanceof Error && err.stack) error.stack = redactSecrets(err.stack, secrets);
  return error;
}

export function assertPublicSafe(value: unknown, secrets: string[]): void {
  const json = JSON.stringify(value) ?? '';
  const needles = [...secrets, ...activeNeedles()].filter(secret => secret.length >= 4);
  for (const secret of needles) {
    if (json.includes(secret)) {
      throw new Error('Refusing to expose auth output that contains a secret.');
    }
  }
}

export function storageContainsSecret(
  state: { cookies?: Array<{ value?: string }>; origins?: Array<{ localStorage?: Array<{ value?: string }> }> },
  secrets: string[],
): boolean {
  const needles = secrets.filter(secret => secret.length >= 8);
  if (needles.length === 0) return false;
  for (const cookie of state.cookies || []) {
    if (needles.some(secret => (cookie.value || '').includes(secret))) return true;
  }
  for (const origin of state.origins || []) {
    for (const item of origin.localStorage || []) {
      if (needles.some(secret => (item.value || '').includes(secret))) return true;
    }
  }
  return false;
}

export function secretNeedles(
  state?: { cookies?: Array<{ value?: string }>; origins?: Array<{ localStorage?: Array<{ value?: string }> }> },
  extra: string[] = [],
): string[] {
  const values = [...extra];
  for (const cookie of state?.cookies || []) if (cookie.value) values.push(cookie.value);
  for (const origin of state?.origins || []) {
    for (const item of origin.localStorage || []) if (item.value) values.push(item.value);
  }
  return [...new Set(values.filter(value => value.length >= 8))];
}

export function rememberPageSecrets(page: object, secrets: string[], forceNoCapture = false): void {
  const needles = secrets.filter(secret => secret.length >= 4);
  if (needles.length) pageSecrets.set(page, needles);
  if (forceNoCapture || needles.length) noCapture.add(page);
}

export function secretsFor(page: object): string[] {
  return pageSecrets.get(page) || [];
}

export function captureDisabled(page: object): boolean {
  return noCapture.has(page);
}

export function redactValue<T>(value: T, secrets: string[]): T {
  const needles = [...secrets.filter(secret => secret.length >= 4), ...activeNeedles()];
  if (needles.length === 0) return value;
  return walkRedacted(value, needles) as T;
}

function walkRedacted(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') return redactSecrets(value, secrets);
  if (Array.isArray(value)) return value.map(item => walkRedacted(item, secrets));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (secrets.some(secret => secret.length >= 4 && key.includes(secret))) continue;
      if (key && FORBIDDEN_KEYS.has(normalKey(key))) continue;
      out[key] = walkRedacted(inner, secrets);
    }
    return out;
  }
  return value;
}
