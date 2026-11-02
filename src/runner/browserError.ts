/**
 * Browser error pages and net::ERR_* navigations.
 *
 * A chrome-error:// or about:neterror page is never a pass. When monkeytester
 * aborted the request, the flow is inconclusive. Any other net error is a
 * failure, and the evidence names that error.
 */

import type { CheckVerdict } from '../outcome/check.js';
import type { NetworkFailureEvidence } from '../types.js';

const NET_ERROR = /(?:net::)?(ERR_[A-Z0-9_]+)/i;

/** Chromium, Edge, and Firefox internal pages shown when a navigation fails. */
export function isBrowserInternalUrl(url: string | undefined): boolean {
  if (!url) return false;
  const value = url.trim().toLowerCase();
  return value.startsWith('chrome-error:')
    || value.startsWith('edge-error:')
    || value.startsWith('about:neterror')
    || value.startsWith('about:certerror');
}

export function isHttpPageUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url.trim());
}

/** First real http(s) URL. Browser-internal URLs are skipped. */
export function firstHttpPageUrl(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    if (isHttpPageUrl(candidate) && !isBrowserInternalUrl(candidate)) return candidate;
  }
  return undefined;
}

/** `net::ERR_*` spelled the way Chromium reports it. `ERR_NAME` alone is accepted. */
export function netErrorCode(text: string | undefined): string | undefined {
  const match = (text || '').match(NET_ERROR);
  if (!match) return undefined;
  return `net::${match[1].toUpperCase()}`;
}

export function isGuardNetError(code: string | undefined): boolean {
  return code === 'net::ERR_BLOCKED_BY_CLIENT';
}

/**
 * Our guard aborted the navigation: a sensitive or contact submit, or a
 * network request blocked in the browser (`net::ERR_BLOCKED_BY_CLIENT`).
 */
export function isRequestBlockedText(text: string | undefined): boolean {
  const raw = text || '';
  if (/missing-validation/i.test(raw)) return false;
  return /\brequest_blocked\b/i.test(raw)
    || /request was blocked/i.test(raw)
    || /net::ERR_BLOCKED_BY_CLIENT/i.test(raw)
    || /blockedbyclient/i.test(raw);
}

export function isRequestBlockedStep(step: { error?: string; observation?: string }): boolean {
  if (step.error === 'missing-validation') return false;
  if (step.error === 'request_blocked') return true;
  return isRequestBlockedText(`${step.error || ''}\n${step.observation || ''}`);
}

export function guardBrowserObservation(net?: string): string {
  const named = net ? ` (${net})` : '';
  return `The browser showed an error page because a request was blocked${named}. The outcome is inconclusive (request_blocked).`;
}

export function browserErrorObservation(net: string): string {
  return `The page showed a browser error (${net}).`;
}

export interface BrowserErrorContext {
  guardCaused?: boolean;
  networkFailures?: NetworkFailureEvidence[];
  /** Action or navigation error text. Used only to name a net error. */
  navigationError?: string;
}

/**
 * Outcome-check result for a browser error page.
 * `undefined` means the page is a normal document and the check can run.
 * A guard-caused error page is unverifiable. Any other error page is a failure
 * whose observation names the net error.
 */
export function browserErrorVerdict(
  url: string,
  ctx: BrowserErrorContext = {},
  netError?: string,
): CheckVerdict | undefined {
  if (!isBrowserInternalUrl(url)) return undefined;
  const net = netError || netErrorFromContext(ctx, url);
  const guard = ctx.guardCaused || isGuardNetError(net) || isRequestBlockedText(ctx.navigationError);
  if (guard) {
    return { state: 'unverifiable', observation: guardBrowserObservation(net) };
  }
  return {
    state: 'failed',
    observation: browserErrorObservation(net || 'net::ERR_FAILED'),
  };
}

/**
 * A passed action that landed on a browser error page is not a pass.
 * A product failure already recorded (empty contact with no validation) is kept.
 * A guard abort stays a skip. Any other error page fails and names the net error.
 */
export function settleActionBrowserError<T extends { status: string; observation: string; error?: string }>(
  outcome: T,
  pageUrl: string | undefined,
  failures: NetworkFailureEvidence[] | undefined,
): T {
  if (outcome.error === 'missing-validation') return outcome;
  if (outcome.error === 'sensitive-submit' || outcome.error === 'oauth-navigation') return outcome;
  if (outcome.error === 'request_blocked') return outcome;
  const net = netErrorCode(outcome.error)
    || netErrorCode(outcome.observation)
    || documentNetError(failures);
  const named = Boolean(netErrorCode(outcome.error) || netErrorCode(outcome.observation));
  if (outcome.status === 'failed' && named) return outcome;
  if (outcome.status === 'failed' && !isBrowserInternalUrl(pageUrl)) return outcome;
  if (!isBrowserInternalUrl(pageUrl)) return outcome;

  if (isGuardNetError(net) || isRequestBlockedText(`${outcome.error || ''}\n${outcome.observation}`)) {
    return {
      ...outcome,
      status: 'skipped',
      observation: guardBrowserObservation(net),
      error: 'request_blocked',
    };
  }
  // A product failure that already happened on the error page stays. The
  // report uses the last http(s) page, not this URL.
  if (outcome.status === 'failed') return outcome;
  const code = net || 'net::ERR_FAILED';
  return {
    ...outcome,
    status: 'failed',
    observation: browserErrorObservation(code),
    error: code,
  };
}

/** Fields to spread onto a failed outcome step so the bug evidence names the net error. */
export function netEvidenceFor(
  text: string | undefined,
  failures: NetworkFailureEvidence[] | undefined,
  pageUrl: string | undefined,
): { networkFailures: NetworkFailureEvidence[] } | Record<string, never> {
  const code = netErrorCode(text);
  if (!code || isGuardNetError(code)) return {};
  const networkFailures = ensureNetErrorEvidence(failures, text, pageUrl);
  return networkFailures?.length ? { networkFailures } : {};
}

/** Keep a document net error in the step evidence when the action already named one. */
export function ensureNetErrorEvidence(
  failures: NetworkFailureEvidence[] | undefined,
  text: string | undefined,
  pageUrl: string | undefined,
): NetworkFailureEvidence[] | undefined {
  const code = netErrorCode(text);
  if (!code || isGuardNetError(code)) return failures;
  if ((failures || []).some(item => netErrorCode(item.failureText) === code)) return failures;
  const url = firstHttpPageUrl([
    pageUrl,
    ...(failures || []).map(item => item.url),
  ]) || pageUrl || '';
  const entry: NetworkFailureEvidence = {
    url,
    method: 'GET',
    failureText: code,
    resourceType: 'document',
  };
  return [...(failures || []), entry];
}

function netErrorFromContext(ctx: BrowserErrorContext, url: string): string | undefined {
  const fromDoc = documentNetError(ctx.networkFailures);
  if (fromDoc) return fromDoc;
  const fromNav = netErrorCode(ctx.navigationError);
  if (fromNav) return fromNav;
  if (!isBrowserInternalUrl(url)) return undefined;
  for (const item of ctx.networkFailures || []) {
    const code = netErrorCode(item.failureText);
    if (code) return code;
  }
  return undefined;
}

function documentNetError(failures: NetworkFailureEvidence[] | undefined): string | undefined {
  for (const item of failures || []) {
    const type = (item.resourceType || '').toLowerCase();
    if (type && type !== 'document') continue;
    const code = netErrorCode(item.failureText);
    if (code) return code;
  }
  return undefined;
}
