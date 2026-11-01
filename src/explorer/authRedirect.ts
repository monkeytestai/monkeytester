/**
 * A logged-out visitor sent from a page to sign-in is not a broken visit.
 *
 * Same-origin HTTP redirects and client-side navigations to a login, sign-in,
 * or sign-up URL are expected. Cross-origin redirects, error pages, redirect
 * loops, and 4xx/5xx responses stay failures.
 */

import type { Page } from 'playwright';
import type { Suggestion } from '../types.js';
import { isSameCrawlSite, sameCrawlPage } from './queue.js';

const LOGGED_OUT_AUTH = /(?:^|[/?#=&._-])(?:log[-_]?in|sign[-_]?in|sign[-_]?up|register|create[-_]?account)(?=$|[/?#=&._-])/i;

const ERROR_PAGE = /(?:^|[/?#=&._-])(?:404|500|error|not[-_]?found|server[-_]?error|unavailable)(?=$|[/?#=&._-])/i;

export type AuthRedirectClass =
  | 'expected-auth'
  | 'not-redirect'
  | 'cross-origin'
  | 'error-page'
  | 'loop'
  | 'http-error'
  | 'other';

export interface DocumentRedirect {
  requestedUrl: string;
  landedUrl: string;
  /** Document statuses, including a final 4xx/5xx. Intermediate 3xx may be omitted. */
  statuses?: number[];
  /** Requested URL first. A repeated URL is a loop. */
  chain?: string[];
}

export function isLoggedOutAuthSurface(url: string): boolean {
  try {
    const parsed = new URL(url);
    return LOGGED_OUT_AUTH.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return LOGGED_OUT_AUTH.test(url);
  }
}

function isErrorPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ERROR_PAGE.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return ERROR_PAGE.test(url);
  }
}

function chainLoops(chain: string[] | undefined): boolean {
  if (!chain || chain.length < 2) return false;
  const seen = new Set<string>();
  for (const url of chain) {
    let key = url;
    try {
      const parsed = new URL(url);
      parsed.hash = '';
      key = `${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch { /* keep the raw string */ }
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/**
 * Classify where a document navigation settled.
 * `expected-auth` is the only class a page-visit may treat as a pass.
 */
export function classifyDocumentRedirect(input: DocumentRedirect): AuthRedirectClass {
  if (chainLoops(input.chain)) return 'loop';
  if ((input.statuses || []).some(status => status >= 400)) return 'http-error';
  const requested = input.requestedUrl;
  const landed = input.landedUrl;
  if (!requested || !landed) return 'other';
  if (sameCrawlPage(requested, landed)) return 'not-redirect';
  if (!isSameCrawlSite(landed, requested)) return 'cross-origin';
  if (isErrorPage(landed)) return 'error-page';
  if (isLoggedOutAuthSurface(landed)) return 'expected-auth';
  return 'other';
}

const PAGE_VISIT = /\b(visit|open|navigate|go to|goto|browse|read|load|view|homepage|home page)\b/i;
const NOT_A_VISIT = /\b(fill|type|submit|send|press enter|pay now|delete|select)\b/i;

/** A journey that only opens a page, such as "Visit Homepage". */
export function isPageVisitFlow(flow: { name: string; description?: string; steps: Array<{ action: string }> }): boolean {
  const blob = [flow.name, flow.description || '', ...flow.steps.map(step => step.action)].join('\n');
  if (NOT_A_VISIT.test(blob)) return false;
  return PAGE_VISIT.test(blob);
}

export function authRedirectObservation(requestedUrl: string, landedUrl: string): string {
  return `Opened ${requestedUrl} and landed on ${landedUrl}. A same-origin redirect to sign-in is expected for a logged-out visitor.`;
}

export function authRedirectSuggestion(requestedUrl: string, landedUrl: string): Suggestion {
  return {
    pageUrl: landedUrl,
    title: 'Signed-out redirect',
    detail: authRedirectObservation(requestedUrl, landedUrl),
    kind: 'auth-redirect',
    severity: 'info',
  };
}

/**
 * Give a client-side router a moment to replace the URL, then stop.
 * Returns as soon as the URL has been stable, so a page that does not
 * redirect does not wait for the full timeout.
 */
export async function waitForSettledLocation(page: Page, timeoutMs = 1000): Promise<void> {
  const started = Date.now();
  let last = '';
  try { last = page.url(); } catch { return; }
  let stableSince = started;
  while (Date.now() - started < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, 50));
    let current = last;
    try { current = page.url(); } catch { return; }
    if (current !== last) {
      last = current;
      stableSince = Date.now();
      if (isLoggedOutAuthSurface(current)) {
        await new Promise(resolve => setTimeout(resolve, 100));
        return;
      }
      continue;
    }
    const ready = await page.evaluate(() => document.readyState === 'complete').catch(() => false);
    if (ready && Date.now() - stableSince >= 400 && Date.now() - started >= 400) return;
  }
}
