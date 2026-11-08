/**
 * Bind an in-memory session before explore, plan, or replay.
 * Does not read a previous run, write a file, grant allowSensitive, or
 * record a screenshot. A past expiresAt is `expired` and is not applied.
 */

import type { AuthStorageState } from './contract.js';
import type { AuthResult } from './establish.js';
import { acceptSessionMaterial, assertSessionBound, jarExpired, policyFrom } from './origins.js';
import { publicMetadata } from './report.js';

export interface AuthBindInput {
  targetOrigin: string;
  idpOrigins?: string[];
  storageState: AuthStorageState;
  /** Caller envelope expiry. The server uses 120 seconds. Past this, the jar is not applied. */
  expiresAt?: string;
  nowMs?: number;
}

export async function bindAuthProvider(input: AuthBindInput): Promise<AuthResult> {
  const policyResult = policyFrom(input.targetOrigin, input.idpOrigins ?? []);
  if (!policyResult.ok) {
    return {
      ok: false,
      setup: true,
      metadata: publicMetadata({
        mode: 'session',
        outcome: 'target_rejected',
        policy: { targetOrigin: 'https://invalid.invalid', idpOrigins: [] },
        custody: 'in-memory',
        detail: policyResult.detail,
      }),
    };
  }
  const policy = policyResult.policy;
  const now = input.nowMs ?? Date.now();
  if (input.expiresAt !== undefined) {
    const expiresMs = Date.parse(input.expiresAt);
    if (Number.isNaN(expiresMs)) {
      return {
        ok: false,
        setup: true,
        metadata: publicMetadata({
          mode: 'session',
          outcome: 'not_authorized',
          policy,
          custody: 'in-memory',
          detail: 'The session expiry is not a time. It was not applied. This is not a verified run.',
        }),
      };
    }
  }
  if (input.expiresAt && Date.parse(input.expiresAt) <= now) {
    return {
      ok: false,
      setup: false,
      metadata: publicMetadata({
        mode: 'session',
        outcome: 'expired',
        policy,
        custody: 'in-memory',
        expiresAt: input.expiresAt,
        detail: 'Our test couldn\'t complete the run because the in-memory sign-in envelope expired. It was not applied. This is not a verified run and it does not mean the site has no bugs.',
      }),
    };
  }
  if (jarExpired(input.storageState, now)) {
    return {
      ok: false,
      setup: false,
      metadata: publicMetadata({
        mode: 'session',
        outcome: 'expired',
        policy,
        custody: 'in-memory',
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        detail: 'Our test couldn\'t complete the run because the session cookies are expired. They were not applied. This is not a verified run and it does not mean the site has no bugs.',
      }),
    };
  }
  const material = acceptSessionMaterial(input.storageState);
  if (!material.ok) {
    return {
      ok: false,
      setup: false,
      metadata: publicMetadata({
        mode: 'session',
        outcome: 'not_authorized',
        policy,
        custody: 'in-memory',
        detail: `Our test couldn't complete the run. ${material.detail} This is not a verified run.`,
      }),
    };
  }
  const bound = assertSessionBound(input.storageState, policy);
  if (!bound.ok) {
    return {
      ok: false,
      setup: false,
      metadata: publicMetadata({
        mode: 'session',
        outcome: 'origin_rejected',
        policy,
        custody: 'in-memory',
        detail: `Our test couldn't complete the run. ${bound.detail} This is not a verified run.`,
      }),
    };
  }
  const metadata = publicMetadata({
    mode: 'session',
    outcome: 'authenticated',
    policy,
    custody: 'in-memory',
    ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    detail: 'Bound an in-memory session for this process and this exact origin. It was not written to a plan, run, or report. Screenshots and video are off. A later rerun needs a new envelope. The hosted product is not holding this session.',
  });
  return {
    ok: true,
    setup: false,
    metadata,
    storageState: input.storageState,
    authOrigin: policy,
    toJSON() {
      return { ok: true as const, setup: false as const, metadata, storageState: { redacted: true as const } };
    },
  };
}
