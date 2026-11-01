/**
 * Console and page-error noise.
 *
 * A message is a site bug only when it is first-party and it is not one of
 * our own automation failures. Extension URLs, third-party hosts, Chrome's
 * "Failed to load resource" line, and `isOwnAutomationBug` signatures are
 * dropped before a check can file them.
 */

import { isOwnAutomationBug } from '../automation/signatures.js';
import { isSameCrawlSite } from '../explorer/queue.js';

const EXTENSION = /(?:chrome|moz|safari|edge)-extension:|webkit-masked-url:|about:blank/i;

const NOISE = [
  /ResizeObserver loop/i,
  /favicon\.ico/i,
  /apple-touch-icon/i,
  /Failed to load resource/i,
  /net::ERR_BLOCKED_BY_CLIENT/i,
  /net::ERR_ABORTED/i,
  /net::ERR_FAILED/i,
  /Download the React DevTools/i,
  /\[vite\]/i,
  /\[HMR\]/i,
  /webpack-dev-server/i,
  /^Script error\.?$/i,
  /chrome-extension:/i,
  /moz-extension:/i,
];

export function isIgnoredConsoleMessage(
  message: string,
  sourceUrl: string | undefined,
  pageUrl: string,
): boolean {
  const text = message.trim();
  if (!text) return true;
  if (EXTENSION.test(text) || (sourceUrl && EXTENSION.test(sourceUrl))) return true;
  if (NOISE.some(pattern => pattern.test(text))) return true;
  if (isOwnAutomationBug({ title: text, observed: text, error: text })) return true;
  if (sourceUrl && isThirdParty(sourceUrl, pageUrl)) return true;
  return false;
}

function isThirdParty(sourceUrl: string, pageUrl: string): boolean {
  try {
    const source = new URL(sourceUrl);
    if (source.protocol !== 'http:' && source.protocol !== 'https:') return false;
    return !isSameCrawlSite(sourceUrl, pageUrl);
  } catch {
    return false;
  }
}
