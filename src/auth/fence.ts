/**
 * One signed-in fence. Page routes cannot skip it: a later route's
 * continue() and fallback() are turned into this handler, which aborts
 * anything outside the exact origin and does not follow an off-origin
 * redirect. WebSocket handshakes are closed the same way. Service workers
 * are blocked by the browser context.
 */

import type { BrowserContext, Page, Route } from 'playwright';
import type { AuthOriginPolicy } from './contract.js';
import type { EgressPin } from './egress.js';
import { connectionAllowed } from './egress.js';
import { originAllowed } from './origins.js';
import { registerSecrets } from './secrets.js';
import { blockSensitiveRequest } from '../runner/sensitive.js';

export interface FenceState {
  originRejected: boolean;
}

async function deny(route: { abort: (errorCode?: 'blockedbyclient') => Promise<void> }): Promise<void> {
  await route.abort('blockedbyclient').catch(() => {});
}

function secretInUrl(url: URL): boolean {
  return /(?:^|[?&#])(?:password|passwd|pwd|access_token|refresh_token|id_token)=/i.test(`${url.search}${url.hash}`);
}

async function allowRequest(
  url: URL,
  policy: AuthOriginPolicy,
  pin: EgressPin,
  onReject?: () => void,
): Promise<boolean> {
  if (!originAllowed(url, policy) || secretInUrl(url) || !(await connectionAllowed(url, policy, pin))) {
    onReject?.();
    return false;
  }
  return true;
}

function rememberSetCookie(headers: Array<{ name: string; value: string }>): void {
  const values: string[] = [];
  for (const header of headers) {
    if (header.name.toLowerCase() !== 'set-cookie') continue;
    const pair = header.value.split(';', 1)[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const value = pair.slice(eq + 1).trim();
    if (value) values.push(value);
  }
  registerSecrets(values);
}

async function safeFulfill(
  route: Route,
  policy: AuthOriginPolicy,
  pin: EgressPin,
  onReject?: () => void,
): Promise<void> {
  let url: URL;
  try { url = new URL(route.request().url()); }
  catch {
    onReject?.();
    await deny(route);
    return;
  }
  if (!(await allowRequest(url, policy, pin, onReject))) {
    await deny(route);
    return;
  }
  let response: import('playwright').APIResponse;
  try {
    response = await route.fetch({ maxRedirects: 0 });
  } catch {
    await deny(route);
    return;
  }
  const status = response.status();
  if (status >= 300 && status < 400) {
    const location = response.headers()['location'];
    let next: URL | undefined;
    if (location) {
      try { next = new URL(location, url); } catch { next = undefined; }
    }
    if (!next || !(await allowRequest(next, policy, pin, onReject))) {
      onReject?.();
      await deny(route);
      return;
    }
  }
  rememberSetCookie(response.headersArray());
  await route.fulfill({ response }).catch(async () => { await deny(route); });
}

function wrapRoute(route: Route, policy: AuthOriginPolicy, pin: EgressPin, onReject?: () => void): Route {
  return new Proxy(route, {
    get(target, prop, receiver) {
      if (prop === 'continue' || prop === 'fallback') {
        return async (overrides?: { url?: string }) => {
          if (overrides?.url) {
            try {
              const next = new URL(overrides.url, target.request().url());
              if (!(await allowRequest(next, policy, pin, onReject))) {
                await deny(target);
                return;
              }
            } catch {
              onReject?.();
              await deny(target);
              return;
            }
          }
          await safeFulfill(target, policy, pin, onReject);
        };
      }
      if (prop === 'fetch') {
        return (options?: Parameters<Route['fetch']>[0]) => target.fetch({ ...options, maxRedirects: 0 });
      }
      const value = Reflect.get(target, prop, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

async function socketAllowed(raw: string, policy: AuthOriginPolicy, pin: EgressPin): Promise<boolean> {
  let url: URL;
  try { url = new URL(raw); }
  catch { return false; }
  return allowRequest(url, policy, pin);
}

function patchPage(page: Page, policy: AuthOriginPolicy, pin: EgressPin, onReject?: () => void): void {
  const originalRoute = page.route.bind(page);
  page.route = (async (url, handler, options) => {
    return originalRoute(url, async (route, request) => {
      let parsed: URL;
      try { parsed = new URL(route.request().url()); }
      catch {
        onReject?.();
        await deny(route);
        return;
      }
      if (!(await allowRequest(parsed, policy, pin, onReject))) {
        await deny(route);
        return;
      }
      await handler(wrapRoute(route, policy, pin, onReject), request);
    }, options);
  }) as typeof page.route;

  const originalSocket = page.routeWebSocket.bind(page);
  page.routeWebSocket = ((url, handler) => {
    return originalSocket(url, async ws => {
      if (!(await socketAllowed(ws.url(), policy, pin))) {
        onReject?.();
        // close() waits on the page, and the page is waiting on this handler.
        void ws.close();
        return;
      }
      await handler(ws);
    });
  }) as typeof page.routeWebSocket;
}

async function installFence(
  context: BrowserContext,
  policy: AuthOriginPolicy,
  pin: EgressPin,
  onReject?: () => void,
): Promise<void> {
  const originalRoute = context.route.bind(context);
  const originalSocket = context.routeWebSocket.bind(context);
  context.on('page', page => patchPage(page, policy, pin, onReject));

  context.route = (async (url, handler) => {
    return originalRoute(url, async (route, request) => {
      let parsed: URL;
      try { parsed = new URL(route.request().url()); }
      catch {
        onReject?.();
        await deny(route);
        return;
      }
      if (!(await allowRequest(parsed, policy, pin, onReject))) {
        await deny(route);
        return;
      }
      await handler(wrapRoute(route, policy, pin, onReject), request);
    });
  }) as typeof context.route;

  await originalRoute('**/*', async route => {
    let parsed: URL;
    try { parsed = new URL(route.request().url()); }
    catch {
      onReject?.();
      await deny(route);
      return;
    }
    if (!(await allowRequest(parsed, policy, pin, onReject))) {
      await deny(route);
      return;
    }
    const page = route.request().frame()?.page();
    if (page && await blockSensitiveRequest(route, page)) return;
    await safeFulfill(route, policy, pin, onReject);
  });

  await originalSocket(/.*/, async ws => {
    if (!(await socketAllowed(ws.url(), policy, pin))) {
      onReject?.();
      // Awaiting close() deadlocks: the page is blocked in this handler.
      void ws.close();
      return;
    }
    ws.connectToServer();
  });
}

export async function installLoginFence(
  context: BrowserContext,
  policy: AuthOriginPolicy,
  state: FenceState,
  pin: EgressPin,
): Promise<void> {
  await installFence(context, policy, pin, () => { state.originRejected = true; });
}

export async function installSessionFence(
  context: BrowserContext,
  policy: AuthOriginPolicy,
  pin: EgressPin,
): Promise<void> {
  await installFence(context, policy, pin);
}
