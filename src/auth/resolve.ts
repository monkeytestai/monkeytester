/**
 * Choose the sign-in path for this invocation.
 * A previous session is not applied unless this invocation opts in.
 */

import type { Page } from 'playwright';
import type { AuthPublicMetadata } from './contract.js';
import { establishFormAuth, establishManualAuth, type AuthResult } from './establish.js';
import { policyFrom } from './origins.js';
import { assertEnvName, createEnvSecretProvider, createMemorySecretProvider } from './provider.js';
import { publicMetadata } from './report.js';
import { readAuthSession, writeAuthSession } from './sessionFile.js';

export interface AuthInvocation {
  targetUrl: string;
  idpOrigins?: string[];
  usernameEnv?: string;
  passwordEnv?: string;
  passwordFromStdin?: string;
  useSession: boolean;
  saveSession: boolean;
  sessionPath?: string;
  sessionTtlMs?: number;
  manual: boolean;
  priorAuthenticated: boolean;
  env?: NodeJS.ProcessEnv;
  headless?: boolean;
  settle?: (page: Page) => Promise<void>;
  nowMs?: number;
  postLoginUrl?: string;
  postLoginSelector?: string;
}

export type AuthResolution =
  | { kind: 'anonymous' }
  | { kind: 'ready'; result: Extract<AuthResult, { ok: true }>; sessionPath?: string }
  | { kind: 'blocked'; result: Extract<AuthResult, { ok: false }> };

export async function resolveAuthInvocation(input: AuthInvocation): Promise<AuthResolution> {
  const freshSecret = Boolean(input.passwordEnv || input.passwordFromStdin !== undefined);
  const wants = input.manual || input.useSession || freshSecret || input.priorAuthenticated || input.saveSession;
  if (!wants) return { kind: 'anonymous' };
  if (input.manual && freshSecret) {
    return blocked(input, 'not_authorized', true, 'Manual login does not take a password flag. Sign in in the browser, including any second factor.');
  }
  if (input.passwordEnv && input.passwordFromStdin !== undefined) {
    return blocked(input, 'not_authorized', true, 'Pass either --password-env NAME or --password-stdin, not both.');
  }
  if (input.priorAuthenticated && !input.manual && !input.useSession && !freshSecret) {
    return blocked(input, 'not_authorized', false);
  }
  const policy = policyFrom(input.targetUrl, input.idpOrigins ?? []);
  if (!policy.ok) return blocked(input, 'target_rejected', true, policy.detail);

  if (input.manual) {
    return finish(input, await establishManualAuth({
      targetUrl: input.targetUrl,
      idpOrigins: input.idpOrigins,
      headless: input.headless,
      settle: input.settle,
      postLoginUrl: input.postLoginUrl,
      postLoginSelector: input.postLoginSelector,
    }));
  }
  if (freshSecret) {
    if (!input.usernameEnv) {
      return blocked(input, 'not_authorized', true, 'Form login needs --username-env NAME as well as a password reference.');
    }
    const nameError = assertEnvName(input.usernameEnv) || (input.passwordEnv ? assertEnvName(input.passwordEnv) : undefined);
    if (nameError) return blocked(input, 'not_authorized', true, nameError);
    const env = input.env ?? process.env;
    if (input.passwordFromStdin !== undefined && !env[input.usernameEnv]) {
      return blocked(input, 'not_authorized', true, `Environment variable ${input.usernameEnv} is unset. Nothing was typed.`);
    }
    const provider = input.passwordFromStdin !== undefined
      ? createMemorySecretProvider({ username: env[input.usernameEnv] || '', password: input.passwordFromStdin })
      : createEnvSecretProvider({ usernameEnv: input.usernameEnv, passwordEnv: input.passwordEnv || '', env });
    return finish(input, await establishFormAuth({
      targetUrl: input.targetUrl,
      idpOrigins: input.idpOrigins,
      provider,
      headless: input.headless !== false,
      postLoginUrl: input.postLoginUrl,
      postLoginSelector: input.postLoginSelector,
    }));
  }
  if (!input.sessionPath) {
    return blocked(input, 'not_authorized', true, '--use-session needs a session file path ending in auth/session.json.');
  }
  const read = readAuthSession(input.sessionPath, policy.policy, { allow: input.useSession, nowMs: input.nowMs });
  if (!read.storageState) {
    return {
      kind: 'blocked',
      result: { ok: false, setup: Boolean(read.needsPermission) && !input.priorAuthenticated, metadata: read.metadata },
    };
  }
  return finish(input, {
    ok: true,
    setup: false,
    metadata: read.metadata,
    storageState: read.storageState,
    authOrigin: policy.policy,
    toJSON: () => ({ ok: true as const, setup: false as const, metadata: read.metadata, storageState: { redacted: true as const } }),
  });
}

function finish(input: AuthInvocation, result: AuthResult): AuthResolution {
  if (!result.ok) return { kind: 'blocked', result };
  if (!input.saveSession) return { kind: 'ready', result };
  if (!input.sessionPath) {
    return blocked(input, 'not_authorized', true, 'Saving a session needs a path ending in auth/session.json.');
  }
  const written = writeAuthSession({
    path: input.sessionPath,
    policy: result.authOrigin,
    storageState: result.storageState,
    ttlMs: input.sessionTtlMs,
    nowMs: input.nowMs,
  });
  const metadata: AuthPublicMetadata = written.expiresAt ? { ...result.metadata, expiresAt: written.expiresAt } : result.metadata;
  return { kind: 'ready', result: { ...result, metadata }, sessionPath: written.path };
}

function blocked(
  input: AuthInvocation,
  outcome: Exclude<AuthPublicMetadata['outcome'], 'authenticated'>,
  setup: boolean,
  detail?: string,
): AuthResolution {
  const policy = policyFrom(input.targetUrl, input.idpOrigins ?? []);
  const safe = policy.ok ? policy.policy : { targetOrigin: 'https://invalid.invalid', idpOrigins: [] };
  return {
    kind: 'blocked',
    result: {
      ok: false,
      setup,
      metadata: publicMetadata({
        mode: input.manual ? 'manual' : input.useSession ? 'session' : 'form',
        outcome,
        policy: safe,
        detail,
      }),
    },
  };
}
