/**
 * A signed-in browser context. Video is not recorded. The session jar is
 * loaded only after it matches the exact authorized hosts.
 */

import type { Browser, BrowserContext } from 'playwright';
import type { AuthOriginPolicy, AuthStorageState } from './contract.js';
import { installSessionFence } from './fence.js';
import { assertSessionBound } from './origins.js';
import { rememberPageSecrets, secretNeedles } from './redact.js';

export interface FencedContextOptions {
  storageState?: AuthStorageState;
  authOrigin?: AuthOriginPolicy;
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
  const context = await browser.newContext({
    ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
    ...(opts.viewport ? { viewport: opts.viewport } : {}),
    ...(!opts.storageState && opts.recordVideo ? { recordVideo: opts.recordVideo } : {}),
    ...extras,
  });
  if (opts.storageState && opts.authOrigin) {
    const needles = secretNeedles(opts.storageState);
    context.on('page', page => rememberPageSecrets(page, needles, true));
    await installSessionFence(context, opts.authOrigin, needles);
  }
  return context;
}
