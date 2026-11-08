/**
 * Every request is checked, not only the top-level navigation.
 * Login mode aborts anything off the authorized origins so page script
 * cannot post the password elsewhere. Session mode strips cookie and
 * bearer headers off-origin, and aborts a request that still carries a
 * known secret in the URL, body, or another header.
 */

import type { BrowserContext, Route } from 'playwright';
import type { AuthOriginPolicy } from './contract.js';
import { originAllowed } from './origins.js';

export interface FenceState {
  originRejected: boolean;
}

const STRIPPED = ['cookie', 'authorization', 'proxy-authorization', 'x-api-key', 'x-auth-token', 'x-access-token', 'x-csrf-token'];

export async function installLoginFence(
  context: BrowserContext,
  policy: AuthOriginPolicy,
  secrets: string[],
  state: FenceState,
): Promise<void> {
  const needles = secrets.filter(secret => secret.length >= 8);
  await context.route('**/*', async route => {
    const request = route.request();
    let url: URL;
    try { url = new URL(request.url()); }
    catch {
      state.originRejected = true;
      await route.abort('blockedbyclient');
      return;
    }
    const allowed = originAllowed(url, policy);
    const blob = `${url.href}\n${request.postData() || ''}\n${Object.values(request.headers()).join('\n')}`;
    const carried = needles.some(secret => blob.includes(secret));
    if (!allowed || url.href.split('?')[1] && needles.some(secret => url.href.includes(secret))) {
      if (carried || request.isNavigationRequest() || request.resourceType() === 'document') state.originRejected = true;
      if (!allowed && carried) state.originRejected = true;
      if (needles.some(secret => url.href.includes(secret))) state.originRejected = true;
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
}

export async function installSessionFence(
  context: BrowserContext,
  policy: AuthOriginPolicy,
  secrets: string[],
): Promise<void> {
  const needles = secrets.filter(secret => secret.length >= 8);
  await context.route('**/*', async route => {
    const request = route.request();
    let url: URL;
    try { url = new URL(request.url()); }
    catch {
      await route.abort('blockedbyclient');
      return;
    }
    const headers = { ...request.headers() };
    const body = request.postData() || '';
    if (originAllowed(url, policy)) {
      if (needles.some(secret => url.href.includes(secret))) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
      return;
    }
    const leaked = needles.some(secret => url.href.includes(secret) || body.includes(secret))
      || Object.entries(headers).some(([name, value]) => !STRIPPED.includes(name.toLowerCase()) && needles.some(secret => value.includes(secret)));
    const method = request.method().toUpperCase();
    const write = method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
    const type = request.resourceType();
    if (leaked || request.isNavigationRequest() || type === 'document' || type === 'websocket' || write) {
      await route.abort('blockedbyclient');
      return;
    }
    for (const name of Object.keys(headers)) {
      if (STRIPPED.includes(name.toLowerCase())) delete headers[name];
    }
    await route.continue({ headers });
  });
}
