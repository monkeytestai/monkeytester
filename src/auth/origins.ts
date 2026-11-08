/**
 * Credentials and session jars are bound to the exact origin the user named.
 * http is only for loopback, which is the local-dev case already used when
 * the user names 127.0.0.1, localhost, or ::1. There is no bypass flag.
 */

import type { AuthOriginPolicy, AuthStorageState } from './contract.js';

const LOOPBACK = /^(?:localhost|.*\.localhost|127(?:\.\d{1,3}){3}|::1)$/i;

export interface ParsedOrigin {
  origin: string;
  protocol: 'http:' | 'https:';
  hostname: string;
}

export type OriginCheck =
  | { ok: true; parsed: ParsedOrigin }
  | { ok: false; detail: string };

export function checkCredentialTarget(raw: string): OriginCheck {
  let url: URL;
  try { url = new URL(raw); }
  catch { return { ok: false, detail: 'The target is not an absolute http(s) URL. Nothing was submitted.' }; }
  if (url.username || url.password || /[?&](?:password|passwd|pwd|token|secret|code)=/i.test(url.search)) {
    return {
      ok: false,
      detail: 'The target URL must not carry userinfo or a password, token, or code query. Nothing was submitted.',
    };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, detail: 'Credentials are only sent to an http(s) origin. Nothing was submitted.' };
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    return {
      ok: false,
      detail: 'A password or session is only sent to the exact https origin you name. http is limited to loopback (localhost, 127.0.0.1, ::1) for local dev. Nothing was submitted.',
    };
  }
  return {
    ok: true,
    parsed: { origin: url.origin, protocol: url.protocol, hostname: url.hostname.toLowerCase() },
  };
}

export function policyFrom(targetUrl: string, idpOrigins: string[] = []):
  | { ok: true; policy: AuthOriginPolicy }
  | { ok: false; detail: string } {
  const target = checkCredentialTarget(targetUrl);
  if (!target.ok) return target;
  const idp: string[] = [];
  for (const raw of idpOrigins) {
    const checked = checkCredentialTarget(raw);
    if (!checked.ok) return { ok: false, detail: `An IdP origin was rejected. ${checked.detail}` };
    if (checked.parsed.origin !== target.parsed.origin && !idp.includes(checked.parsed.origin)) {
      idp.push(checked.parsed.origin);
    }
  }
  return { ok: true, policy: { targetOrigin: target.parsed.origin, idpOrigins: idp } };
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.test(hostname.toLowerCase().replace(/^\[|\]$/g, ''));
}

/** Literal address or name that must not receive hosted credentials. Not a DNS lookup. */
export function isNonPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || isLoopbackHost(host) || host.endsWith('.local') || host.endsWith('.internal')) return true;
  if (host.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return addressIsNonPublic(host);
  return false;
}

/** Classify one IP. IPv4-mapped IPv6 is classified as the inner IPv4 address. */
export function addressIsNonPublic(raw: string): boolean {
  let ip = raw.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (dotted?.[1]) ip = dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(ip);
  if (hex?.[1] && hex[2]) {
    const hi = Number.parseInt(hex[1], 16);
    const lo = Number.parseInt(hex[2], 16);
    ip = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  if (ip.includes('.')) {
    const parts = ip.split('.').map(part => Number(part));
    if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const a = parts[0] ?? 0;
    const b = parts[1] ?? 0;
    const c = parts[2] ?? 0;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 0 && c === 2) return true;
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;
    return false;
  }
  if (!ip.includes(':')) return false;
  if (ip === '::' || ip === '::1') return true;
  if (ip.startsWith('fe80:') || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('ff')) return true;
  if (ip.startsWith('2001:db8')) return true;
  return false;
}

/**
 * Resolve a hosted name before a browser is opened. This is a preflight.
 * Chromium may resolve the name again later. A worker that can reach
 * private or link-local addresses must block those routes itself. This
 * function does not pin that later connection.
 */
export async function hostedDnsPreflight(hostname: string): Promise<{ ok: true } | { ok: false; detail: string }> {
  if (isNonPublicHost(hostname) || addressIsNonPublic(hostname)) {
    return { ok: false, detail: 'Hosted sign-in refuses a non-public name or address. Nothing was submitted.' };
  }
  if (hostname.includes(':') || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return { ok: true };
  try {
    const dns = await import('node:dns/promises');
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    if (records.length === 0 || records.some(record => addressIsNonPublic(record.address))) {
      return { ok: false, detail: 'Hosted sign-in refused the name because a resolved address is not public. This is a preflight, not a connection-time pin. Nothing was submitted.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, detail: 'Hosted sign-in could not resolve the host. Nothing was submitted.' };
  }
}

/** https and a public host. Loopback stays on the local CLI, not this check. */
export function checkHostedTarget(raw: string): OriginCheck {
  const checked = checkCredentialTarget(raw);
  if (!checked.ok) return checked;
  if (checked.parsed.protocol !== 'https:') {
    return { ok: false, detail: 'Hosted sign-in only sends credentials to an https origin. Nothing was submitted.' };
  }
  if (isNonPublicHost(checked.parsed.hostname)) {
    return { ok: false, detail: 'Hosted sign-in refuses loopback, private, link-local, .local, and .internal hosts. Nothing was submitted.' };
  }
  return checked;
}

export function originAllowed(url: URL, policy: AuthOriginPolicy): boolean {
  if (url.protocol === 'about:' || url.protocol === 'data:' || url.protocol === 'blob:') return true;
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return false;
  }
  return url.origin === policy.targetOrigin || policy.idpOrigins.includes(url.origin);
}

export interface BindingCheck {
  ok: boolean;
  detail: string;
}

/** Parent-domain cookies can reach another tenant, so they are refused. Values are not included in detail. */
export function assertSessionBound(state: AuthStorageState, policy: AuthOriginPolicy): BindingCheck {
  const hosts = allowedHosts(policy);
  for (const cookie of state.cookies || []) {
    if (String(cookie.domain || '').startsWith('.')) {
      return { ok: false, detail: 'The session has a parent-domain cookie, which could be sent to another tenant. It was not loaded.' };
    }
    const domain = String(cookie.domain || '').replace(/^\./, '').toLowerCase();
    if (!domain || !hosts.includes(domain)) {
      return { ok: false, detail: 'The session has a cookie for a host outside the authorized origin. It was not loaded.' };
    }
  }
  for (const entry of state.origins || []) {
    let origin = '';
    try { origin = new URL(entry.origin).origin; } catch { origin = ''; }
    if (!origin || (origin !== policy.targetOrigin && !policy.idpOrigins.includes(origin))) {
      return { ok: false, detail: 'The session has web storage for an origin that was not authorized. It was not loaded.' };
    }
  }
  return { ok: true, detail: '' };
}

const COOKIE_FIELDS = new Set(['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']);

function csrfName(name: string): boolean {
  return /csrf|xsrf/i.test(name);
}

/** Reject an empty jar, a CSRF-only jar, and unexpected cookie fields. */
export function acceptSessionMaterial(state: AuthStorageState): BindingCheck {
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    return { ok: false, detail: 'The session was not a storage state. It was not loaded.' };
  }
  if (JSON.stringify(state).length > 200_000) {
    return { ok: false, detail: 'The session is too large. It was not loaded.' };
  }
  for (const cookie of state.cookies) {
    if (!cookie || typeof cookie !== 'object') return { ok: false, detail: 'The session has a malformed cookie. It was not loaded.' };
    if (Object.keys(cookie).some(key => !COOKIE_FIELDS.has(key))) {
      return { ok: false, detail: 'The session has an unexpected cookie field. It was not loaded.' };
    }
    if (!cookie.name || typeof cookie.value !== 'string' || !cookie.domain || cookie.name.length > 256 || cookie.value.length > 4096) {
      return { ok: false, detail: 'The session has a malformed cookie. It was not loaded.' };
    }
  }
  const usefulCookie = state.cookies.some(cookie => cookie.value && !csrfName(cookie.name));
  const usefulStore = state.origins.some(origin => (origin.localStorage || []).some(item => item?.value && !csrfName(item.name || '')));
  if (!usefulCookie && !usefulStore) {
    return { ok: false, detail: 'The browser did not store an application session. An empty jar or only a CSRF cookie is not signed in.' };
  }
  return { ok: true, detail: '' };
}

export function allowedHosts(policy: AuthOriginPolicy): string[] {
  const hosts: string[] = [];
  for (const origin of [policy.targetOrigin, ...policy.idpOrigins]) {
    try {
      const host = new URL(origin).hostname.toLowerCase();
      if (!hosts.includes(host)) hosts.push(host);
    } catch { /* already parsed */ }
  }
  return hosts;
}

export function jarExpired(state: AuthStorageState, nowMs: number): boolean {
  const cookies = state.cookies || [];
  if (cookies.length === 0) return false;
  let session = false;
  let dated = 0;
  let live = 0;
  for (const cookie of cookies) {
    const expires = Number(cookie.expires);
    if (!Number.isFinite(expires) || expires <= 0) {
      session = true;
      continue;
    }
    dated += 1;
    if (expires * 1000 > nowMs) live += 1;
  }
  return !session && dated > 0 && live === 0;
}
