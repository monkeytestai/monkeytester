/**
 * Explicit egress proxy for Playwright.
 * `route.fetch` and `context.request` ignore HTTPS_PROXY. They use the
 * proxy object passed to both `chromium.launch` and `browser.newContext`.
 * Credentials stay on that object and are not included in errors.
 */

/**
 * Hosted browsers use only this token.
 * On Playwright 1.59.1 (this package's lockfile) and 1.64 (the hosted
 * review), `<-loopback>` does not exempt 127.0.0.1, localhost, or ::1, so
 * those requests reach the proxy. Naming the hosts sends them direct.
 */
export const HOSTED_EGRESS_PROXY_BYPASS = '<-loopback>' as const;

/**
 * Owned local targets, when a proxy is configured. The named hosts stay off
 * the proxy so a loopback fixture still loads. Private and unique-local
 * addresses are not in this list.
 */
export const LOCAL_EGRESS_PROXY_BYPASS = '<-loopback>,localhost,127.0.0.1,::1,[::1]' as const;

export type EgressProxyBypass = typeof HOSTED_EGRESS_PROXY_BYPASS | typeof LOCAL_EGRESS_PROXY_BYPASS;

export function bypassForPin(mode: 'hosted-public' | 'local-loopback'): EgressProxyBypass {
  return mode === 'hosted-public' ? HOSTED_EGRESS_PROXY_BYPASS : LOCAL_EGRESS_PROXY_BYPASS;
}

export interface EgressProxy {
  server: string;
  bypass: EgressProxyBypass;
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
    bypass: LOCAL_EGRESS_PROXY_BYPASS,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
  };
  return { ok: true, proxy };
}

/** Host and port only. Safe to put in an error or a log line. */
export function describeEgressProxy(proxy: EgressProxy): string {
  return proxy.server;
}
