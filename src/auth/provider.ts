/**
 * Secret providers keep values in closures. `toJSON` cannot reveal them.
 * `release` drops the closure. It does not revoke a website session.
 */

import type { AuthSecretProvider, AuthStorageState, RuntimeAuthProvider } from './contract.js';

const ENV_NAME = /^[A-Z][A-Z0-9_]{0,80}$/;

/** A rejected name is not echoed. It may be the password itself. */
export function assertEnvName(name: string | undefined): string | undefined {
  if (!name || !ENV_NAME.test(name)) {
    return 'The value after --username-env or --password-env must be an uppercase variable name such as MONKEYTEST_PASSWORD, not the secret itself.';
  }
  return undefined;
}

export function createEnvSecretProvider(input: {
  usernameEnv: string;
  passwordEnv: string;
  env?: NodeJS.ProcessEnv;
}): AuthSecretProvider {
  const env = input.env ?? process.env;
  let released = false;
  return {
    source: 'env',
    describe() {
      return `username env ${input.usernameEnv}, password env ${input.passwordEnv}. Env vars are visible to the shell, CI logs, and process listings.`;
    },
    takeSecrets() {
      if (released) return { missing: input.passwordEnv };
      const username = env[input.usernameEnv];
      const password = env[input.passwordEnv];
      if (!username) return { missing: input.usernameEnv };
      if (!password) return { missing: input.passwordEnv };
      return { username, password };
    },
    release() { released = true; },
    toJSON() {
      return { source: 'env' as const, redacted: true as const, usernameEnv: input.usernameEnv, passwordEnv: input.passwordEnv };
    },
  };
}

export function createMemorySecretProvider(secrets: { username: string; password: string }): AuthSecretProvider {
  let username: string | undefined = secrets.username;
  let password: string | undefined = secrets.password;
  return {
    source: 'memory',
    describe: () => 'in-memory username and password for this process. Not written to argv.',
    takeSecrets() {
      if (username === undefined || password === undefined) return undefined;
      return { username, password };
    },
    release() { username = undefined; password = undefined; },
    toJSON: () => ({ source: 'memory' as const, redacted: true as const }),
  };
}

export function createManualSecretProvider(): AuthSecretProvider {
  return {
    source: 'manual',
    describe: () => 'manual headed login. The engine does not receive the password.',
    takeSecrets: () => undefined,
    release() { /* nothing held */ },
    toJSON: () => ({ source: 'manual' as const, redacted: true as const }),
  };
}

export function createRuntimeSessionProvider(
  session: AuthStorageState | undefined,
  missingOutcome: 'not_authorized' | 'expired' = 'not_authorized',
): RuntimeAuthProvider {
  let current = session;
  return {
    async open() {
      if (!current) return { ok: false, outcome: missingOutcome };
      return { ok: true, storageState: current };
    },
    close() { current = undefined; },
    toJSON: () => ({ source: 'memory-session' as const, redacted: true as const, held: Boolean(current) }),
  };
}
