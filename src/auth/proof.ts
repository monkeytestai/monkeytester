/**
 * A stored jar is not a signed-in session until the target shows the
 * configured post-login URL or selector. A password field later in the
 * run means that session is gone.
 */

import type { BrowserContext, Page } from 'playwright';
import type { AuthOriginPolicy, AuthStorageState } from './contract.js';
import { launchFencedBrowser } from './egress.js';
import { originAllowed } from './origins.js';
import { openFencedContext } from './browser.js';

const provedJars = new WeakSet<object>();

export function markSessionProved(state: object): void {
  provedJars.add(state);
}

export function sessionAlreadyProved(state: object | undefined): boolean {
  return Boolean(state && provedJars.has(state));
}

export async function loginProved(
  page: Page,
  policy: AuthOriginPolicy,
  postLoginUrl?: string,
  postLoginSelector?: string,
): Promise<boolean> {
  let pageUrl: URL;
  try { pageUrl = new URL(page.url()); }
  catch { return false; }
  if (!originAllowed(pageUrl, policy)) return false;
  if (postLoginUrl) {
    let want: URL;
    try { want = new URL(postLoginUrl, policy.targetOrigin); }
    catch { return false; }
    if (want.origin !== pageUrl.origin) return false;
    const wanted = want.pathname.replace(/\/$/, '') || '/';
    const got = pageUrl.pathname.replace(/\/$/, '') || '/';
    if (got !== wanted && !got.startsWith(`${wanted}/`)) return false;
  }
  if (postLoginSelector) {
    const count = await page.locator(postLoginSelector).count().catch(() => 0);
    if (count < 1) return false;
  }
  return Boolean(postLoginUrl || postLoginSelector);
}

export async function passwordFieldVisible(page: Page): Promise<boolean> {
  const count = await page.locator('input[type="password"]').count().catch(() => 0);
  return count > 0;
}

export interface SessionWatch {
  lost: boolean;
  unproved: boolean;
}

export async function observeSignedInPage(page: Page, opts: {
  storageState?: unknown;
  authOrigin?: AuthOriginPolicy;
  postLoginUrl?: string;
  postLoginSelector?: string;
  sessionWatch?: SessionWatch;
}): Promise<void> {
  if (!opts.storageState || !opts.authOrigin || !opts.sessionWatch) return;
  // The post-login URL is checked once, when the session is bound.
  // Later pages are allowed to leave that path. A password field, or a
  // missing post-login selector, means the session is no longer proved.
  if (await passwordFieldVisible(page)) opts.sessionWatch.lost = true;
  if (opts.postLoginSelector) {
    const count = await page.locator(opts.postLoginSelector).count().catch(() => 0);
    if (count < 1) opts.sessionWatch.unproved = true;
  }
}

/** Open the target once and require the post-login check. No page text is returned. */
export async function proveStoredSession(input: {
  targetUrl: string;
  policy: AuthOriginPolicy;
  storageState: AuthStorageState;
  postLoginUrl?: string;
  postLoginSelector?: string;
}): Promise<boolean> {
  if (sessionAlreadyProved(input.storageState)) return true;
  const launched = await launchFencedBrowser({ headless: true, policy: input.policy });
  if (!launched.ok || !launched.pin) return false;
  let context: BrowserContext | undefined;
  try {
    context = await openFencedContext(launched.browser, {
      storageState: input.storageState,
      authOrigin: input.policy,
      egressPin: launched.pin,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    let openUrl = input.targetUrl;
    if (input.postLoginUrl) {
      try { openUrl = new URL(input.postLoginUrl, input.policy.targetOrigin).href; }
      catch { return false; }
    }
    await page.goto(openUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 }).catch(() => {});
    if (await passwordFieldVisible(page)) return false;
    const proved = await loginProved(page, input.policy, input.postLoginUrl, input.postLoginSelector);
    if (proved) markSessionProved(input.storageState);
    return proved;
  } finally {
    await context?.close().catch(() => {});
    await launched.browser.close().catch(() => {});
  }
}
