/**
 * In-memory provider the server calls after it pins AUTH_PROVIDER_CONTRACT.
 * One open per provider. No disk, no OTP seed, no allowSensitive, no reuse.
 * Hosted targets are public https only. Loopback sign-in stays on the local CLI.
 */

import type { AuthStorageState } from './contract.js';
import { AUTH_PROVIDER_CONTRACT } from './contract.js';
import { bindAuthProvider } from './bind.js';
import type { AuthResult } from './establish.js';
import { establishFormAuth } from './establish.js';
import { checkHostedTarget, policyFrom } from './origins.js';
import { createMemorySecretProvider } from './provider.js';
import { publicMetadata } from './report.js';

const REFUSED = ['otp', 'otp_seed', 'totp_seed', 'auth_otp', 'auth_reuse', 'auth_secret_handle', 'allowSensitive'] as const;

export interface HostedCredentialsInput {
  mode: 'hosted_credentials';
  targetOrigin: string;
  username: string;
  password: string;
  /** Envelope expiry. The server uses 120 seconds. */
  expiresAt: string;
}

export interface LocalSessionInput {
  mode: 'local_session';
  targetOrigin: string;
  storageState: AuthStorageState;
  expiresAt: string;
}

export interface AuthProvider {
  readonly contract: typeof AUTH_PROVIDER_CONTRACT;
  /** Sign in or accept the jar once. A second call does not reuse the secret. */
  open(): Promise<AuthResult>;
  /** Drop this provider's references. Does not sign the website out. */
  release(): void;
  toJSON(): { contract: typeof AUTH_PROVIDER_CONTRACT; redacted: true; released: boolean };
}

export function createAuthProvider(input: HostedCredentialsInput | LocalSessionInput | Record<string, unknown>): AuthProvider {
  const record = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const refused = REFUSED.find(key => record[key] != null && record[key] !== false);
  let username = typeof record.username === 'string' ? record.username : '';
  let password = typeof record.password === 'string' ? record.password : '';
  let storage = isStorage(record.storageState) ? record.storageState : undefined;
  let used = false;
  let released = false;

  const fail = (outcome: 'not_authorized' | 'target_rejected' | 'expired' | 'origin_rejected', setup: boolean, detail: string): AuthResult => ({
    ok: false,
    setup,
    metadata: publicMetadata({
      mode: 'session',
      outcome,
      policy: hostedPolicy(record.targetOrigin),
      custody: 'in-memory',
      detail,
    }),
  });

  return {
    contract: AUTH_PROVIDER_CONTRACT,
    async open() {
      if (released || used) {
        return fail('not_authorized', false, 'Our test couldn\'t complete the run because this provider was already used or released. A rerun needs a new createAuthProvider call and a new secret. This is not a verified run.');
      }
      used = true;
      if (refused) {
        return fail('not_authorized', true, `Field ${refused} is not accepted. Nothing was stored. This is not a verified run.`);
      }
      const mode = record.mode;
      const target = typeof record.targetOrigin === 'string' ? record.targetOrigin : '';
      const hosted = checkHostedTarget(target);
      if (!hosted.ok) return fail('target_rejected', true, hosted.detail);
      const expiresAt = typeof record.expiresAt === 'string' ? record.expiresAt : '';
      const expiresMs = Date.parse(expiresAt);
      if (!expiresAt || Number.isNaN(expiresMs)) {
        return fail('not_authorized', true, 'Hosted sign-in requires an expiresAt instant. Nothing was submitted.');
      }
      if (expiresMs <= Date.now()) {
        return fail('expired', false, 'Our test couldn\'t complete the run because the sign-in envelope expired. It was not applied. This is not a verified run and it does not mean the site has no bugs.');
      }
      if (mode === 'local_session') {
        if (!storage) return fail('not_authorized', true, 'local_session requires a storageState for the exact target host. Nothing was stored.');
        const bound = await bindAuthProvider({
          targetOrigin: target,
          storageState: storage,
          expiresAt,
        });
        storage = undefined;
        return bound;
      }
      if (mode !== 'hosted_credentials') {
        return fail('not_authorized', true, 'mode must be hosted_credentials or local_session. Nothing was stored.');
      }
      const provider = createMemorySecretProvider({ username, password });
      username = '';
      password = '';
      const result = await establishFormAuth({ targetUrl: target, provider, headless: true });
      if (!result.ok && result.metadata.outcome === 'target_rejected') return result;
      return result;
    },
    release() {
      released = true;
      username = '';
      password = '';
      storage = undefined;
    },
    toJSON() {
      return { contract: AUTH_PROVIDER_CONTRACT, redacted: true as const, released };
    },
  };
}

function hostedPolicy(target: unknown): { targetOrigin: string; idpOrigins: string[] } {
  if (typeof target !== 'string') return { targetOrigin: 'https://invalid.invalid', idpOrigins: [] };
  const policy = policyFrom(target, []);
  return policy.ok ? policy.policy : { targetOrigin: 'https://invalid.invalid', idpOrigins: [] };
}

function isStorage(value: unknown): value is AuthStorageState {
  if (!value || typeof value !== 'object') return false;
  const record = value as { cookies?: unknown; origins?: unknown };
  return Array.isArray(record.cookies) && Array.isArray(record.origins);
}
