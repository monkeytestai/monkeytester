/**
 * Outcome decision shared by a live run and a stored-plan replay.
 *
 * Replay must not keep a second copy of the auth-redirect pass, the
 * oracle-flow rule, or the sensitive-submit / OAuth guard. Both callers
 * hand the same inputs to these functions.
 */

import type { CheckVerdict } from '../outcome/check.js';
import {
  authRedirectObservation,
  authRedirectSuggestion,
  classifyDocumentRedirect,
  isPageVisitFlow,
} from '../explorer/authRedirect.js';
import type { FlowAssertion, StepResult, Suggestion } from '../types.js';

export interface VisitFlow {
  name: string;
  description?: string;
  startUrl: string;
  steps: Array<{ action?: string }>;
}

export function appendSuggestions(list: Suggestion[], incoming: readonly Suggestion[] | undefined): void {
  if (!incoming?.length) return;
  for (const item of incoming) {
    if (list.some(existing => sameSuggestion(existing, item))) continue;
    list.push(item);
  }
}

/**
 * Two `auth-redirect` notes for the same landing page are one note.
 * The opening navigation and the planned goto both observe it.
 */
function sameSuggestion(a: Suggestion, b: Suggestion): boolean {
  if (a.kind === 'auth-redirect' && b.kind === 'auth-redirect') return a.pageUrl === b.pageUrl;
  return a.kind === b.kind && a.pageUrl === b.pageUrl && a.detail === b.detail;
}

export function oracleAssertion(steps: StepResult[]): FlowAssertion {
  const planned = steps.filter(step => step.index > 0);
  const last = planned[planned.length - 1];
  if (last?.status === 'passed' || planned.some(step => step.status === 'failed')) return 'verified';
  return 'unverifiable';
}

export function assertionFromVerdict(verdict: CheckVerdict, unfinished: boolean): FlowAssertion {
  if (verdict.state === 'verified') return 'verified';
  if (verdict.state === 'failed' && !unfinished) return 'failed';
  if (verdict.state === 'missing') return 'missing';
  return 'unverifiable';
}

/**
 * A logged-out page visit that settled on a same-origin sign-in URL passes.
 * The info suggestion is recorded once.
 */
export function passSignedOutVisit(
  verdict: CheckVerdict,
  flow: VisitFlow,
  landedUrl: string,
  navStatus: number | undefined,
  suggestions: Suggestion[],
): CheckVerdict {
  const visit = isPageVisitFlow({
    name: flow.name,
    description: flow.description,
    steps: flow.steps.map(step => ({ action: step.action || '' })),
  });
  const kind = classifyDocumentRedirect({
    requestedUrl: flow.startUrl,
    landedUrl,
    statuses: navStatus === undefined ? undefined : [navStatus],
  });
  if (!visit || kind !== 'expected-auth' || verdict.state === 'verified') return verdict;
  appendSuggestions(suggestions, [authRedirectSuggestion(flow.startUrl, landedUrl)]);
  return { state: 'verified', observation: authRedirectObservation(flow.startUrl, landedUrl) };
}

/**
 * A sensitive submit or an OAuth navigation is inconclusive. A failed
 * outcome step recorded before the guard is dropped so it cannot become a bug.
 */
export function applySubmissionGuard(
  assertion: FlowAssertion,
  steps: StepResult[],
  guarded: boolean,
): { assertion: FlowAssertion; failed: boolean } {
  if (!guarded) {
    return {
      assertion,
      failed: steps.some(step => step.status === 'failed') || assertion === 'failed',
    };
  }
  const outcomeStep = steps.find(step => isOutcomeAssertAction(step.action) && step.status === 'failed');
  if (outcomeStep) {
    outcomeStep.status = 'skipped';
    delete outcomeStep.error;
  }
  return {
    assertion: 'unverifiable',
    failed: steps.some(step => step.status === 'failed'),
  };
}

export function isOutcomeAssertAction(action: string | undefined): boolean {
  return /^check the expected outcome\b/i.test((action || '').trim());
}

/** A recorded skip that the live runner produced by refusing a submit. */
export function isRecordedSubmissionHalt(step: { error?: string; observation?: string }): boolean {
  if (step.error === 'sensitive-submit' || step.error === 'oauth-navigation') return true;
  const text = step.observation || '';
  return text.startsWith('Refused to submit')
    || text.startsWith('Sign-up was not submitted')
    || /signup_reason (?:no_inbox|cap_reached)/.test(text);
}
