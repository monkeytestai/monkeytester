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

function stripIp(raw: string): string {
  return raw.trim().toLowerCase().replace(/^\[|\]$/g, '').split('%')[0] ?? '';
}

function parseIpv4(raw: string): number[] | undefined {
  const parts = raw.split('.');
  if (parts.length !== 4) return undefined;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    nums.push(value);
  }
  return nums;
}

/** 16 bytes, or undefined when the text is not an IPv6 address. */
function parseIpv6(raw: string): Uint8Array | undefined {
  let ip = stripIp(raw);
  if (!ip.includes(':')) return undefined;
  const lastColon = ip.lastIndexOf(':');
  const tail = ip.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseIpv4(tail);
    if (!v4) return undefined;
    const hi = ((v4[0]! << 8) | v4[1]!).toString(16);
    const lo = ((v4[2]! << 8) | v4[3]!).toString(16);
    ip = `${ip.slice(0, lastColon)}:${hi}:${lo}`;
  }
  const halves = ip.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return undefined;
  const missing = 8 - (left.length + right.length);
  if (halves.length === 2 && missing < 1) return undefined;
  const groups = halves.length === 2 ? [...left, ...Array(missing).fill('0'), ...right] : left;
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const group = groups[i] ?? '';
    if (!/^[0-9a-f]{1,4}$/.test(group)) return undefined;
    const value = Number.parseInt(group, 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 255;
  }
  return bytes;
}

function mappedIpv4(bytes: Uint8Array): number[] | undefined {
  for (let i = 0; i < 10; i++) if (bytes[i] !== 0) return undefined;
  if (bytes[10] !== 0xff || bytes[11] !== 0xff) return undefined;
  return [bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!];
}

function ipv4NonPublic(parts: number[]): boolean {
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  const c = parts[2] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 0 && c === 0) return true;
  if (a === 192 && b === 0 && c === 2) return true;
  if (a === 192 && b === 88 && c === 99) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 31 && c === 196) return true;
  if (a === 192 && b === 52 && c === 193) return true;
  if (a === 192 && b === 175 && c === 48) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  if (a >= 224) return true;
  return false;
}

function ipv6NonPublic(bytes: Uint8Array): boolean {
  const mapped = mappedIpv4(bytes);
  if (mapped) return ipv4NonPublic(mapped);
  let zero = true;
  for (const byte of bytes) if (byte !== 0) zero = false;
  if (zero || (bytes[15] === 1 && bytes.slice(0, 15).every(byte => byte === 0))) return true;
  const b0 = bytes[0] ?? 0;
  const b1 = bytes[1] ?? 0;
  if ((b0 & 0xfe) === 0xfc) return true;
  if (b0 === 0xfe && (b1 & 0xc0) === 0x80) return true;
  if (b0 === 0xfe && (b1 & 0xc0) === 0xc0) return true;
  if (b0 === 0xff) return true;
  if (b0 === 0x20 && b1 === 0x02) return true;
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) return true;
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x00 && ((bytes[3] ?? 0) >> 4) === 0x1) return true;
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x00 && (bytes[3] ?? 0) >= 0x20 && (bytes[3] ?? 0) <= 0x2f) return true;
  if (b0 === 0x20 && b1 === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x02) return true;
  if (b0 === 0x00 && b1 === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) return true;
  if (b0 === 0x01 && bytes.slice(1, 8).every(byte => byte === 0)) return true;
  return false;
}

/** Stable text for comparisons. IPv4-mapped addresses collapse to dotted IPv4. */
export function canonicalAddress(raw: string): string {
  const text = stripIp(raw);
  const v4 = parseIpv4(text);
  if (v4) return v4.join('.');
  const v6 = parseIpv6(text);
  if (!v6) return text;
  const mapped = mappedIpv4(v6);
  if (mapped) return mapped.join('.');
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) groups.push((((v6[i * 2]! << 8) | v6[i * 2 + 1]!) >>> 0).toString(16));
  return groups.join(':');
}

export function isLiteralAddress(raw: string): boolean {
  const text = stripIp(raw);
  return Boolean(parseIpv4(text) || parseIpv6(text));
}

export function isLoopbackAddress(raw: string): boolean {
  const text = stripIp(raw);
  const v4 = parseIpv4(text);
  if (v4) return v4[0] === 127;
  const v6 = parseIpv6(text);
  if (!v6) return false;
  const mapped = mappedIpv4(v6);
  if (mapped) return mapped[0] === 127;
  if (v6[15] !== 1) return false;
  for (let i = 0; i < 15; i++) if (v6[i] !== 0) return false;
  return true;
}

/**
 * Classify one IP. IPv4-mapped IPv6 is classified as the inner IPv4 address.
 * Unparseable strings that look like addresses are non-public (fail closed).
 * Ordinary hostnames return false; the caller resolves those separately.
 */
export function addressIsNonPublic(raw: string): boolean {
  const text = stripIp(raw);
  const v4 = parseIpv4(text);
  if (v4) return ipv4NonPublic(v4);
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return true;
  const v6 = parseIpv6(text);
  if (v6) return ipv6NonPublic(v6);
  if (text.includes(':')) return true;
  return false;
}

/**
 * Resolve a hosted name before a browser is opened. The signed-in browser
 * path pins the connection in `prepareEgress`. This helper is the same
 * address check for callers that only have a hostname.
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

const COOKIE_FIELDS = ['name', 'value', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite'] as const;
const STATE_FIELDS = new Set(['cookies', 'origins']);
const ORIGIN_FIELDS = new Set(['origin', 'localStorage']);
const STORE_FIELDS = new Set(['name', 'value']);
const SAME_SITE = new Set(['Strict', 'Lax', 'None']);

function csrfName(name: string): boolean {
  return /csrf|xsrf/i.test(name);
}

function exactKeys(value: object, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every(key => allowed.has(key));
}

/** Reject an empty jar, a CSRF-only jar, unknown fields, and oversized items. */
export function acceptSessionMaterial(state: AuthStorageState): BindingCheck {
  const bad = 'The session was not a bounded storage state. It was not loaded.';
  if (!state || typeof state !== 'object' || Array.isArray(state)) return { ok: false, detail: bad };
  if (!exactKeys(state, STATE_FIELDS) || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    return { ok: false, detail: bad };
  }
  if (state.cookies.length > 100 || state.origins.length > 30) return { ok: false, detail: 'The session is too large. It was not loaded.' };
  let encoded = 0;
  try { encoded = JSON.stringify(state).length; } catch { return { ok: false, detail: bad }; }
  if (encoded > 200_000) return { ok: false, detail: 'The session is too large. It was not loaded.' };
  for (const cookie of state.cookies) {
    if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) return { ok: false, detail: bad };
    if (!exactKeys(cookie, new Set(COOKIE_FIELDS)) || COOKIE_FIELDS.some(key => !(key in cookie))) {
      return { ok: false, detail: 'The session has an unexpected or missing cookie field. It was not loaded.' };
    }
    if (typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string') {
      return { ok: false, detail: bad };
    }
    if (!cookie.name || cookie.name.length > 256 || cookie.value.length > 4096 || cookie.domain.length > 253 || !cookie.path.startsWith('/') || cookie.path.length > 2048) {
      return { ok: false, detail: bad };
    }
    if (typeof cookie.expires !== 'number' || !Number.isFinite(cookie.expires)) return { ok: false, detail: bad };
    if (typeof cookie.httpOnly !== 'boolean' || typeof cookie.secure !== 'boolean') return { ok: false, detail: bad };
    if (!SAME_SITE.has(cookie.sameSite)) return { ok: false, detail: bad };
  }
  for (const entry of state.origins) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !exactKeys(entry, ORIGIN_FIELDS)) {
      return { ok: false, detail: 'The session has an unexpected storage field. It was not loaded.' };
    }
    if (typeof entry.origin !== 'string' || entry.origin.length > 300 || !Array.isArray(entry.localStorage)) {
      return { ok: false, detail: bad };
    }
    if (entry.localStorage.length > 200) return { ok: false, detail: 'The session is too large. It was not loaded.' };
    let parsed = '';
    try { parsed = new URL(entry.origin).origin; } catch { parsed = ''; }
    if (!parsed || parsed !== entry.origin) return { ok: false, detail: bad };
    for (const item of entry.localStorage) {
      if (!item || typeof item !== 'object' || Array.isArray(item) || !exactKeys(item, STORE_FIELDS)) {
        return { ok: false, detail: 'The session has an unexpected storage field. It was not loaded.' };
      }
      if (typeof item.name !== 'string' || typeof item.value !== 'string' || !item.name || item.name.length > 256 || item.value.length > 8192) {
        return { ok: false, detail: bad };
      }
    }
  }
  const usefulCookie = state.cookies.some(cookie => cookie.value && !csrfName(cookie.name));
  const usefulStore = state.origins.some(origin => origin.localStorage.some(item => item.value && !csrfName(item.name)));
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
