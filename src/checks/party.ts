/**
 * First-party vs third-party script origins.
 *
 * A script is third-party when its host's registrable domain (eTLD+1)
 * differs from the page's. `www` and a subdomain of the same site stay
 * first-party. Ads, analytics, and tag managers do not.
 */

const MULTI_PART_SUFFIX = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'co.jp', 'co.nz', 'com.au', 'net.au',
  'org.au', 'co.za', 'com.br', 'com.mx', 'co.in', 'com.sg', 'com.hk', 'co.kr',
]);

const HTTP_URL = /https?:\/\/[^\s)'"<>]+/gi;

export function registrableDomain(hostname: string): string {
  const host = hostname.replace(/\.$/, '').toLowerCase();
  if (!host || host === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
  const parts = host.split('.').filter(Boolean);
  if (parts.length <= 2) return parts.join('.');
  const lastTwo = parts.slice(-2).join('.');
  if (MULTI_PART_SUFFIX.has(lastTwo) && parts.length >= 3) return parts.slice(-3).join('.');
  return lastTwo;
}

export function isDifferentRegistrableDomain(sourceUrl: string, pageUrl: string): boolean {
  let source: URL;
  let page: URL;
  try {
    source = new URL(sourceUrl);
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (source.protocol !== 'http:' && source.protocol !== 'https:') return false;
  if (page.protocol !== 'http:' && page.protocol !== 'https:') return false;
  return registrableDomain(source.hostname) !== registrableDomain(page.hostname);
}

/** First http(s) URL in a stack, which is the throwing script when the browser includes one. */
export function scriptUrlFromError(err: { message?: string; stack?: string }): string | undefined {
  const stack = err.stack || '';
  const match = stack.match(HTTP_URL);
  if (!match) return undefined;
  return match[0].replace(/:\d+:\d+$/, '').replace(/[.,;]+$/, '');
}
