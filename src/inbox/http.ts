/**
 * Generic HTTP inbox. Point it at a server you run.
 *
 *   POST {baseUrl}/allocate     { runId, purpose } → { address, expiresAt? }
 *   GET  {baseUrl}/messages?address=&since= → Inbox message, or { data: Message[] }
 *   DELETE {baseUrl}/messages?address=      → optional release
 *
 * The token is `Authorization: Bearer <token>` when you pass one.
 * This adapter has no default host. It does not call any MonkeyTest domain.
 */

import type { InboxProvider } from '../types.js';

export interface HttpInboxOptions {
  /** Origin or base path of the caller's inbox API. Required. */
  baseUrl: string;
  /** Sent as a bearer token. Omit when the caller's API is open on a private network. */
  token?: string;
  fetchImpl?: typeof fetch;
}

interface WireMessage {
  received?: boolean;
  otp?: string;
  links?: string[];
  subject?: string;
  from?: string;
  receivedAt?: string;
  text?: string;
  html?: string;
  address?: string;
  body?: string;
}

export function createHttpInbox(opts: HttpInboxOptions): InboxProvider {
  const base = opts.baseUrl.replace(/\/$/, '');
  if (!base || !/^https?:\/\//i.test(base)) {
    throw new Error('createHttpInbox requires an http(s) baseUrl. The engine does not choose one for you.');
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;

  return {
    async allocate(input) {
      const response = await fetchImpl(`${base}/allocate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ runId: input.runId, purpose: input.purpose }),
      });
      if (!response.ok) throw new Error(`Inbox allocate failed with HTTP ${response.status}`);
      const body = await response.json() as { address?: string; expiresAt?: string };
      if (!body.address) throw new Error('Inbox allocate did not return an address');
      return { address: body.address, ...(body.expiresAt ? { expiresAt: body.expiresAt } : {}) };
    },
    async waitFor(input) {
      const deadline = Date.now() + input.timeoutMs;
      while (Date.now() < deadline) {
        if (input.signal?.aborted) {
          return { received: false };
        }
        const url = new URL(`${base}/messages`);
        url.searchParams.set('address', input.address);
        url.searchParams.set('since', String(input.sinceMs));
        const response = await fetchImpl(url, { headers });
        if (response.ok) {
          const body = await response.json() as WireMessage & { data?: WireMessage[] };
          const message = pickMessage(body, input.sinceMs);
          if (message) return normalise(message, input.kind);
        }
        await sleep(1_000, input.signal);
      }
      return { received: false };
    },
    async release(input) {
      const url = new URL(`${base}/messages`);
      url.searchParams.set('address', input.address);
      await fetchImpl(url, { method: 'DELETE', headers });
    },
  };
}

function pickMessage(body: WireMessage & { data?: WireMessage[] }, sinceMs: number): WireMessage | undefined {
  if (Array.isArray(body.data)) {
    const fresh = body.data.filter(item => {
      if (!item.receivedAt) return true;
      const at = Date.parse(item.receivedAt);
      return Number.isNaN(at) || at >= sinceMs;
    });
    return fresh[fresh.length - 1];
  }
  if (body.received === false) return undefined;
  if (body.received || body.subject || body.text || body.html || body.body || (body.links && body.links.length > 0)) {
    return body;
  }
  return undefined;
}

function normalise(message: WireMessage, kind: 'otp' | 'link' | 'any'): {
  received: boolean;
  otp?: string;
  links?: string[];
  subject?: string;
  from?: string;
  receivedAt?: string;
  text?: string;
  html?: string;
} {
  const text = message.text || message.body;
  const links = unique([...(message.links ?? []), ...extractLinks(`${text || ''}\n${message.html || ''}`)]);
  const otp = message.otp || extractOtp(text || message.html || '');
  const received = kind === 'otp' ? Boolean(otp) : kind === 'link' ? links.length > 0 : true;
  return {
    received,
    ...(otp ? { otp } : {}),
    ...(links.length ? { links } : {}),
    ...(message.subject ? { subject: message.subject } : {}),
    ...(message.from ? { from: message.from } : {}),
    ...(message.receivedAt ? { receivedAt: message.receivedAt } : {}),
    ...(text ? { text } : {}),
    ...(message.html ? { html: message.html } : {}),
  };
}

function extractLinks(body: string): string[] {
  return body.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
}

function extractOtp(body: string): string | undefined {
  const match = body.match(/\b(\d{4,8})\b/);
  return match?.[1];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
