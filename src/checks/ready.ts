/**
 * Wait until a document has had a chance to hydrate.
 *
 * `domcontentloaded` fires before an SPA paints. Checks that run in that
 * gap see an empty root, finish in 0ms, and come back inconclusive.
 * Network-idle is capped because a websocket would otherwise wait forever.
 */

import type { Page } from 'playwright';

/**
 * How long a page check waits for paint, live and on replay.
 * A shorter replay wait judged `/signup` before it rendered.
 */
export const PAGE_CHECK_SETTLE_MS = 800;

/** Same settle a live page check uses before axe, HTTP, console, meta, or mobile. */
export function settlePageCheck(page: Page): Promise<boolean> {
  return waitForDocumentReady(page, PAGE_CHECK_SETTLE_MS);
}

export async function waitForDocumentReady(page: Page, capMs = 6_000): Promise<boolean> {
  const started = Date.now();
  const idle = Math.min(2_500, Math.max(300, capMs));
  await page.waitForLoadState('networkidle', { timeout: idle }).catch(() => {});
  const remaining = Math.max(400, capMs - (Date.now() - started));
  const ready = await page.waitForFunction(() => {
    const body = document.body;
    const text = (body?.innerText || '').replace(/\s+/g, '');
    const root = document.querySelector('#root, #app, #__next, [data-reactroot]');
    const hydrated = Boolean(root && (root.childElementCount > 0 || (root.textContent || '').replace(/\s+/g, '').length > 0));
    return text.length > 20 || hydrated;
  }, undefined, { timeout: remaining }).then(() => true).catch(() => false);
  return ready;
}
