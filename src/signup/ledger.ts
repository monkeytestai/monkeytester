/**
 * One sign-up decision per run. Higher-ranked results replace lower ones.
 * Validation-only runs stay `not_tested` / `no_inbox`. A verified inbox
 * sign-up wins over that.
 */

import type { SignupReason, SignupStatus } from '../types.js';

export interface SignupLedger {
  sawForm: boolean;
  attempted: boolean;
  verified: boolean;
  status?: SignupStatus;
  reason?: SignupReason;
  /** The one live submit this run is allowed to make. */
  usedLiveSubmit: boolean;
}

export function emptySignupLedger(): SignupLedger {
  return { sawForm: false, attempted: false, verified: false, usedLiveSubmit: false };
}

function rank(status: SignupStatus | undefined, reason: SignupReason | undefined): number {
  if (status === 'verified') return 50;
  if (status === 'unverified') return 40;
  if (status === 'blocked') return 30;
  if (reason === 'cap_reached') return 20;
  if (reason === 'no_inbox') return 10;
  if (status === 'not_tested') return 5;
  return 0;
}

export function noteSignup(ledger: SignupLedger, update: {
  saw?: boolean;
  attempted?: boolean;
  verified?: boolean;
  status?: SignupStatus;
  reason?: SignupReason;
  usedLiveSubmit?: boolean;
}): void {
  if (update.saw) ledger.sawForm = true;
  if (update.usedLiveSubmit) ledger.usedLiveSubmit = true;
  if (update.verified) {
    ledger.verified = true;
    ledger.attempted = true;
    ledger.sawForm = true;
    ledger.status = 'verified';
    ledger.reason = undefined;
    return;
  }
  if (ledger.status === 'verified') {
    if (update.attempted) ledger.attempted = true;
    return;
  }
  if (update.attempted) ledger.attempted = true;
  const nextRank = rank(update.status, update.reason);
  if (!update.status || nextRank < rank(ledger.status, ledger.reason)) return;
  ledger.status = update.status;
  ledger.reason = update.reason;
}

export function signupFields(ledger: SignupLedger): {
  signup_attempted?: boolean;
  signup_verified?: boolean;
  signup_status?: SignupStatus;
  signup_reason?: SignupReason;
} {
  if (!ledger.sawForm && !ledger.status) return {};
  return {
    signup_attempted: ledger.attempted,
    signup_verified: ledger.verified,
    ...(ledger.status ? { signup_status: ledger.status } : {}),
    ...(ledger.reason ? { signup_reason: ledger.reason } : {}),
  };
}
