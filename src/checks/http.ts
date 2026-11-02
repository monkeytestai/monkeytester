/**
 * Same-site failed requests, plus broken same-site links fetched over HTTP
 * without rendering. The link probe is capped so a footer of 200 URLs cannot
 * dominate the run.
 */

import type { NetworkFailureEvidence } from '../types.js';
import { isSameCrawlSite, sameCrawlPage } from '../explorer/queue.js';

/** About 20 link probes per run, shared across pages. */
export const BROKEN_LINK_CAP = 20;

const SKIP_STATUS = new Set([401, 403, 429]);

const SKIP_PATH = /favicon\.ico|apple-touch-icon|\.map$|\/pixel|\/beacon|\/track|\/analytics|\/gtm/i;

const ACTION_TYPES = new Set(['document', 'xhr', 'fetch', 'script', 'stylesheet', 'image']);

export interface ObservedRequest {
  url: string;
  method?: string;
  status?: number;
  failureText?: string;
  resourceType?: string;
}

export interface BrokenLink {
  url: string;
  status?: number;
  failureText?: string;
}

export function isReportableRequest(item: ObservedRequest, pageUrl: string): boolean {
  if (!item.url || !isSameCrawlSite(item.url, pageUrl)) return false;
  if (SKIP_PATH.test(item.url)) return false;
  const type = (item.resourceType || 'other').toLowerCase();
  if (!ACTION_TYPES.has(type) && !item.failureText) return false;
  if (type === 'image' && SKIP_PATH.test(item.url)) return false;
  if (item.failureText) {
    if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT|ERR_FAILED/i.test(item.failureText)) return false;
    return type === 'document' || type === 'xhr' || type === 'fetch' || type === 'script' || type === 'stylesheet';
  }
  const status = item.status ?? 0;
  if (status < 400 || SKIP_STATUS.has(status)) return false;
  return true;
}

export function requestEvidence(items: ObservedRequest[]): NetworkFailureEvidence[] {
  return items.slice(0, 8).map(item => ({
    url: item.url,
    method: (item.method || 'GET').toUpperCase(),
    ...(item.status ? { status: item.status } : {}),
    ...(item.failureText ? { failureText: item.failureText.slice(0, 180) } : {}),
    ...(item.resourceType ? { resourceType: item.resourceType } : {}),
  }));
}

const SKIP_LINK = /^(?:mailto:|tel:|javascript:|#)/i;

/** Absolute http(s) links on this site, deduped, skipping the page itself. */
export function sameSiteLinks(hrefs: string[], pageUrl: string, remaining: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let pageKey = pageUrl;
  try { pageKey = new URL(pageUrl).href; } catch { /* keep */ }
  for (const raw of hrefs) {
    if (out.length >= remaining) break;
    if (!raw || SKIP_LINK.test(raw.trim())) continue;
    let absolute: string;
    try { absolute = new URL(raw, pageUrl).href; }
    catch { continue; }
    if (absolute === pageKey || seen.has(absolute)) continue;
    if (!isSameCrawlSite(absolute, pageUrl)) continue;
    if (SKIP_PATH.test(absolute)) continue;
    seen.add(absolute);
    out.push(absolute);
  }
  return out;
}

export function linkEvidence(links: BrokenLink[]): NetworkFailureEvidence[] {
  return links.slice(0, 8).map(link => ({
    url: link.url,
    method: 'GET',
    ...(link.status ? { status: link.status } : {}),
    ...(link.failureText ? { failureText: link.failureText.slice(0, 180) } : {}),
    resourceType: 'document',
  }));
}

export function isBrokenStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status < 400) return false;
  return !SKIP_STATUS.has(status);
}

export interface HttpFailureSource {
  url: string;
  status?: number;
  resourceType?: string;
}

/**
 * A 404 on a document discovered only through a sitemap is minor.
 * A link found in the page DOM keeps the check's own severity (`undefined`
 * here, so the flow severity still applies). A 5xx is not capped.
 */
export function sitemapDocumentSeverity(
  requests: readonly HttpFailureSource[],
  probedLinks: readonly { url: string }[],
  sitemapOnlyUrls: readonly string[],
): 'minor' | undefined {
  if (probedLinks.length > 0) return undefined;
  if (sitemapOnlyUrls.length === 0) return undefined;
  if (requests.some(item => (item.status || 0) >= 500)) return undefined;
  const documents = requests.filter(item =>
    item.status === 404 && (item.resourceType || 'document') === 'document',
  );
  if (documents.length === 0) return undefined;
  const onlySitemap = documents.every(item =>
    sitemapOnlyUrls.some(candidate => sameCrawlPage(candidate, item.url)),
  );
  return onlySitemap ? 'minor' : undefined;
}
