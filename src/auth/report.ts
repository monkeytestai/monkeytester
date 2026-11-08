/**
 * Failed sign-in becomes `could_not_test` with an auth reason.
 * That is not a verified run and it does not say the site has no bugs.
 */

import type { AuthOutcome, AuthPublicMetadata, AuthStatus } from './contract.js';
import type { OutcomeReason, RunOutcome, RunResult } from '../types.js';

const DETAILS: Record<Exclude<AuthOutcome, 'authenticated'>, { reason: OutcomeReason; detail: string }> = {
  mfa_required: {
    reason: 'auth_mfa_required',
    detail: 'Our test couldn\'t complete the run because the site asked for a second factor or SSO. Form login stopped. Use a fresh manual login in a headed browser. No one-time-code seed was stored. This is not a verified run.',
  },
  expired: {
    reason: 'auth_expired',
    detail: 'Our test couldn\'t complete the run because the saved sign-in expired. It was not loaded. This is not a verified run and it does not mean the site has no bugs. Sign in again.',
  },
  origin_rejected: {
    reason: 'auth_origin_rejected',
    detail: 'Our test couldn\'t complete the run because sign-in left the authorized origin or the session is bound to a different origin. Credentials were not sent to that other origin. This is not a verified run.',
  },
  credentials_rejected: {
    reason: 'auth_rejected',
    detail: 'Our test couldn\'t complete the run because the sign-in form did not accept the supplied credentials. The password was not saved. This is not a verified run.',
  },
  not_authorized: {
    reason: 'auth_not_authorized',
    detail: 'Our test couldn\'t complete the run because this attempt was not authorized to reuse a sign-in. Pass --use-session or a new --password-env / --password-stdin. This is not a verified run.',
  },
  target_rejected: {
    reason: 'auth_target_rejected',
    detail: 'Our test couldn\'t complete the run because the target is not an authorized https origin. Nothing was submitted. This is not a verified run.',
  },
  storage_unsafe: {
    reason: 'auth_storage_unsafe',
    detail: 'Our test couldn\'t complete the run because the sign-in response put the password into browser storage. That session was discarded and was not saved. This is not a verified run.',
  },
};

export function authStatus(outcome: AuthOutcome): AuthStatus {
  switch (outcome) {
    case 'authenticated': return 'authenticated';
    case 'origin_rejected':
    case 'target_rejected': return 'unsafe_origin';
    case 'mfa_required': return 'mfa_required';
    case 'expired': return 'expired';
    case 'not_authorized': return 'auth_required';
    case 'credentials_rejected': return 'credentials_rejected';
    case 'storage_unsafe': return 'storage_unsafe';
  }
}

export function outcomeFromAuth(auth: AuthPublicMetadata | undefined): {
  outcome: RunOutcome;
  outcome_reason: OutcomeReason;
  outcome_detail: string;
} | undefined {
  if (!auth || auth.outcome === 'authenticated') return undefined;
  const mapped = DETAILS[auth.outcome];
  return {
    outcome: 'could_not_test',
    outcome_reason: mapped.reason,
    outcome_detail: auth.detail || mapped.detail,
  };
}

export function authBlockedRun(startUrl: string, auth: AuthPublicMetadata): RunResult {
  const startedAt = new Date().toISOString();
  const derived = outcomeFromAuth(auth);
  return {
    startUrl,
    startedAt,
    finishedAt: startedAt,
    flows: [],
    bugs: [],
    auth,
    ...(derived ?? {}),
    stats: {
      flowsTotal: 0, flowsPassed: 0, flowsFailed: 0, flowsBlocked: 0, flowsInconclusive: 0,
      stepsTotal: 0, stepsPassed: 0, stepsFailed: 0,
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
  };
}

export function publicMetadata(input: {
  mode: AuthPublicMetadata['mode'];
  outcome: AuthOutcome;
  policy: { targetOrigin: string; idpOrigins: string[] };
  custody?: AuthPublicMetadata['custody'];
  sessionReused?: boolean;
  expiresAt?: string;
  detail?: string;
}): AuthPublicMetadata {
  const fallback = input.outcome === 'authenticated'
    ? 'Signed in for this process only. The session was not uploaded. Reports can contain private application data and are not scrubbed of that data. Screenshots and video are off. The hosted product does not hold this session.'
    : DETAILS[input.outcome].detail;
  return {
    schema: 1,
    mode: input.mode,
    outcome: input.outcome,
    status: authStatus(input.outcome),
    targetOrigin: input.policy.targetOrigin,
    idpOrigins: [...input.policy.idpOrigins],
    sessionReused: Boolean(input.sessionReused),
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    loginCapture: 'disabled',
    runCapture: 'disabled',
    visibility: 'private',
    privateDataScrubbed: false,
    custody: input.custody ?? 'customer-local',
    hostedProduct: false,
    interaction: 'read-mostly',
    detail: input.detail || fallback,
  };
}

export function authProcessExit(outcome: AuthOutcome, setup: boolean): number {
  if (outcome === 'authenticated') return 0;
  return setup ? 2 : 1;
}

export function decideRerunAuth(
  priorAuthenticated: boolean,
  request: { useSession: boolean; freshSecret: boolean; manual: boolean },
): 'anonymous' | 'proceed' | 'not_authorized' {
  if (!priorAuthenticated && !request.useSession && !request.freshSecret && !request.manual) return 'anonymous';
  if (priorAuthenticated && !request.useSession && !request.freshSecret && !request.manual) return 'not_authorized';
  return 'proceed';
}
