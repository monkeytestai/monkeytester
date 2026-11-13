/**
 * Explicit egress proxy for Playwright.
 * `route.fetch` and `context.request` ignore HTTPS_PROXY. They use the
 * proxy object passed to both `chromium.launch` and `browser.newContext`.
 * Credentials stay on that object and are not included in errors.
 */

/**
 * Chromium's `<-loopback>` token is what the hosted review verified.
 * On Playwright 1.59 a context proxy still sends 127.0.0.1 through the
 * proxy when that token is the whole bypass list, so the loopback names
 * are listed too. Private and unique-local addresses are not bypassed.
 */
export const EGRESS_PROXY_BYPASS = '<-loopback>,localhost,127.0.0.1,::1,[::1]';

export interface EgressProxy {
  server: string;
  bypass: typeof EGRESS_PROXY_BYPASS;
  username?: string;
  password?: string;
}

const PROXY_PROTOCOLS = new Set(['http:', 'https:', 'socks5:']);

const INVALID_PROXY = 'The egress proxy URL must be an absolute http, https, or socks5 URL with a host and no path or query. Nothing was opened.';

export const HOSTED_PROXY_REQUIRED = 'Hosted sign-in requires an egress proxy so route.fetch and context.request cannot reach a private address directly. Set egressProxy or MTAI_EGRESS_PROXY. Nothing was opened.';

/**
 * `explicit` wins, including an empty string, which means no proxy.
 * Otherwise `MTAI_EGRESS_PROXY` is used. An empty result is "not configured".
 */
export function resolveEgressProxy(explicit?: string):
  | { ok: true; proxy?: EgressProxy }
  | { ok: false; detail: string } {
  const raw = explicit !== undefined ? explicit : (process.env.MTAI_EGRESS_PROXY ?? '');
  const trimmed = raw.trim();
  if (!trimmed) return { ok: true };
  return parseEgressProxy(trimmed);
}

export function parseEgressProxy(raw: string):
  | { ok: true; proxy: EgressProxy }
  | { ok: false; detail: string } {
  let url: URL;
  try { url = new URL(raw); }
  catch { return { ok: false, detail: INVALID_PROXY }; }
  if (!PROXY_PROTOCOLS.has(url.protocol) || !url.hostname) return { ok: false, detail: INVALID_PROXY };
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) return { ok: false, detail: INVALID_PROXY };
  let username = '';
  let password = '';
  try {
    username = url.username ? decodeURIComponent(url.username) : '';
    password = url.password ? decodeURIComponent(url.password) : '';
  } catch {
    return { ok: false, detail: INVALID_PROXY };
  }
  const host = url.hostname.includes(':') ? `[${url.hostname}]` : url.hostname;
  const port = url.port ? `:${url.port}` : '';
  const proxy: EgressProxy = {
    server: `${url.protocol}//${host}${port}`,
    bypass: EGRESS_PROXY_BYPASS,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
  return { ok: true, proxy };
}

/** Host and port only. Safe to put in an error or a log line. */
export function describeEgressProxy(proxy: EgressProxy): string {
  return proxy.server;
}
