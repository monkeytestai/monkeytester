/**
 * Signed-in egress is default-deny for every request that is not the
 * exact authorized origin. Cookie stripping and raw token matching are
 * not the boundary: an off-origin request is aborted before it is sent.
 * WebSocket handshakes are closed the same way. Service workers are
 * blocked by the browser context, not by this HTTP route.
 */

import type { BrowserContext } from 'playwright';
import type { AuthOriginPolicy } from './contract.js';
import { originAllowed } from './origins.js';

export interface FenceState {
  originRejected: boolean;
}

async function deny(route: { abort: (errorCode?: 'blockedbyclient') => Promise<void> }): Promise<void> {
  await route.abort('blockedbyclient').catch(() => {});
}

/**
 * route.continue() lets Chromium follow a 307/308 without passing the next
 * hop through this handler, which resends a login body off-origin. Fetch
 * with no redirect follow, and abort before the browser sees an off-origin
 * Location.
 */
async function gate(
  route: import('playwright').Route,
  policy: AuthOriginPolicy,
  onReject?: () => void,
): Promise<void> {
  let url: URL;
  try { url = new URL(route.request().url()); }
  catch {
    onReject?.();
    await deny(route);
    return;
  }
  if (!originAllowed(url, policy) || secretInUrl(url)) {
    onReject?.();
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
    if (!next || !originAllowed(next, policy) || secretInUrl(next)) {
      onReject?.();
      await deny(route);
      return;
    }
  }
  await route.fulfill({ response }).catch(async () => { await deny(route); });
}

export async function installLoginFence(
  context: BrowserContext,
  policy: AuthOriginPolicy,
  state: FenceState,
): Promise<void> {
  await context.route('**/*', async route => {
    await gate(route, policy, () => { state.originRejected = true; });
  });
  await installSocketFence(context, policy);
}

export async function installSessionFence(
  context: BrowserContext,
  policy: AuthOriginPolicy,
): Promise<void> {
  await context.route('**/*', async route => {
    await gate(route, policy);
  });
  await installSocketFence(context, policy);
}

/** A credential in the URL is not sent, even on the authorized origin. */
function secretInUrl(url: URL): boolean {
  return /(?:^|[?&#])(?:password|passwd|pwd|access_token|refresh_token|id_token)=/i.test(`${url.search}${url.hash}`);
}

async function installSocketFence(context: BrowserContext, policy: AuthOriginPolicy): Promise<void> {
  await context.routeWebSocket(/.*/, ws => {
    let url: URL;
    try { url = new URL(ws.url()); }
    catch {
      ws.close();
      return;
    }
    if (!originAllowed(url, policy)) {
      ws.close();
      return;
    }
    ws.connectToServer();
  });
}
