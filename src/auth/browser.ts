/**
 * A signed-in browser context. Video is not recorded. The session jar is
 * loaded only after it matches the exact authorized hosts. Service workers
 * are blocked so they cannot leave this context's fence.
 */

import type { Browser, BrowserContext } from 'playwright';
import type { AuthOriginPolicy, AuthStorageState } from './contract.js';
import { browserHasPin, EgressProxyRequiredError, prepareEgress, proxyForBrowser, type EgressPin, type EgressProxy } from './egress.js';
import { installSessionFence } from './fence.js';
import { assertSessionBound } from './origins.js';
import { attachedSecrets, rememberPageSecrets, secretNeedles } from './redact.js';

/** Page routes do not see Worker sockets or WebRTC. Signed-in pages cannot construct them. */
export const SIGNED_IN_BLOCK_SCRIPT = `(() => {
  const names = ['Worker', 'SharedWorker', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel', 'WebTransport'];
  for (const name of names) {
    try {
      Object.defineProperty(globalThis, name, {
        configurable: false,
        enumerable: false,
        get() { throw new Error(name + ' is disabled while signed in'); },
      });
    } catch (err) { /* already sealed */ }
  }
})();`;

export async function blockUnroutableEgress(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: SIGNED_IN_BLOCK_SCRIPT });
}

export interface FencedContextOptions {
  storageState?: AuthStorageState;
  authOrigin?: AuthOriginPolicy;
  egressPin?: EgressPin;
  /** Overrides the proxy remembered from `launchFencedBrowser`. */
  proxy?: EgressProxy;
  /** Test-only. Production callers leave certificate checks on. */
  ignoreHTTPSErrors?: boolean;
  userAgent?: string;
  viewport?: { width: number; height: number };
  recordVideo?: { dir: string; size: { width: number; height: number } };
}

export function authContextExtras(opts: {
  storageState?: AuthStorageState;
  authOrigin?: AuthOriginPolicy;
}): { storageState?: AuthStorageState } {
  if (!opts.storageState && !opts.authOrigin) return {};
  if (!opts.storageState || !opts.authOrigin) {
    throw new Error('A signed-in browser requires both storageState and authOrigin.');
  }
  const bound = assertSessionBound(opts.storageState, opts.authOrigin);
  if (!bound.ok) throw new Error(bound.detail);
  return { storageState: opts.storageState };
}

export async function openFencedContext(browser: Browser, opts: FencedContextOptions): Promise<BrowserContext> {
  const extras = authContextExtras(opts);
  let pin = opts.egressPin;
  if (opts.storageState && opts.authOrigin && !pin) {
    const prepared = await prepareEgress(opts.authOrigin);
    if (!prepared.ok) throw new Error(prepared.detail);
    if (prepared.pin.mode === 'hosted-public' && !browserHasPin(browser)) {
      throw new Error('A hosted signed-in browser must be launched with the DNS pin. Nothing was opened.');
    }
    pin = prepared.pin;
  }
  const proxy = opts.proxy ?? proxyForBrowser(browser);
  if (pin?.mode === 'hosted-public' && !proxy) throw new EgressProxyRequiredError();
  const context = await browser.newContext({
    ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(!opts.storageState && opts.recordVideo ? { recordVideo: opts.recordVideo } : {}),
    ...(opts.storageState ? { serviceWorkers: 'block' as const } : {}),
    ...(opts.ignoreHTTPSErrors ? { ignoreHTTPSErrors: true } : {}),
    ...(proxy ? { proxy } : {}),
    ...extras,
  });
  if (opts.storageState && opts.authOrigin && pin) {
    await blockUnroutableEgress(context);
    const needles = [...secretNeedles(opts.storageState), ...attachedSecrets(opts.storageState)];
    context.on('page', page => rememberPageSecrets(page, needles, true));
    await installSessionFence(context, opts.authOrigin, pin);
  }
  return context;
}
