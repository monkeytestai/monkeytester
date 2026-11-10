/**
 * Auth contract, session file, and hosted provider. No browser.
 * Fixture values here are synthetic and must not appear in public metadata.
 */

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AUTH_PROVIDER_ABI,
  AUTH_PROVIDER_CONTRACT,
  authBlockedRun,
  bindAuthProvider,
  createAuthProvider,
  createEnvSecretProvider,
  decideRerunAuth,
  deleteAuthSession,
  readAuthSession,
  rejectCredentialArg,
  triage,
  writeAuthSession,
} from '../src/index.js';
import { saveRun } from '../src/persistence/index.js';
import { checkHostedTarget, policyFrom } from '../src/auth/origins.js';
import { redactValue } from '../src/auth/redact.js';
import { withSensitiveSinks } from '../src/auth/secrets.js';
import { assertEnvName } from '../src/auth/provider.js';
import type { AuthStorageState } from '../src/auth/contract.js';

const PASSWORD = 'synthetic-pass-9';
const COOKIE = 'fixture-session-cookie-value';

function jar(domain: string): AuthStorageState {
  return {
    cookies: [{
      name: 'session',
      value: COOKIE,
      domain,
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    }],
    origins: [],
  };
}

describe('AUTH_PROVIDER_CONTRACT', () => {
  it('is the string id the server can pin with ===', () => {
    expect(AUTH_PROVIDER_CONTRACT).toBe('monkeytester.auth.provider.v1');
    expect(AUTH_PROVIDER_ABI.id).toBe(AUTH_PROVIDER_CONTRACT);
    expect(AUTH_PROVIDER_ABI.create).toBe('createAuthProvider');
    expect(AUTH_PROVIDER_ABI.allowSensitive).toBe('not-granted');
    expect(AUTH_PROVIDER_ABI.providerLoopback).toBe('rejected');
    expect(AUTH_PROVIDER_ABI.hostedDns).toBe('preflight-plus-per-request-recheck');
    expect(AUTH_PROVIDER_ABI.runtimeSession).toBe('repeatable-until-close');
    expect(AUTH_PROVIDER_ABI.open).toBe('once');
    expect(JSON.stringify(AUTH_PROVIDER_ABI)).not.toContain('loopback-allowed');
    expect(AUTH_PROVIDER_ABI.hostedProduct).toBe(false);
    expect(JSON.stringify(AUTH_PROVIDER_ABI)).not.toContain(PASSWORD);
  });

  it('refuses plaintext argv and does not echo a rejected env name', async () => {
    expect(rejectCredentialArg('--password')).toMatch(/Do not pass a password/);
    expect(rejectCredentialArg('--password-env')).toBeUndefined();
    expect(assertEnvName('hunter2') || '').not.toContain('hunter2');
    const provider = createEnvSecretProvider({
      usernameEnv: 'MONKEYTEST_USERNAME',
      passwordEnv: 'not-a-name',
      env: { MONKEYTEST_USERNAME: 'ada@example.test', 'not-a-name': PASSWORD },
    });
    expect(JSON.stringify(provider)).not.toContain(PASSWORD);
    provider.release();
  });
});

describe('createAuthProvider', () => {
  const future = new Date(Date.now() + 120_000).toISOString();

  it('refuses loopback, private hosts, otp seeds, and allowSensitive without storing them', async () => {
    const loop = createAuthProvider({
      mode: 'hosted_credentials',
      targetOrigin: 'http://127.0.0.1:9/login',
      username: 'ada@example.test',
      password: PASSWORD,
      expiresAt: future,
    });
    const looped = await loop.open();
    expect(looped.ok).toBe(false);
    if (!looped.ok) expect(looped.metadata.status).toBe('unsafe_origin');
    expect(JSON.stringify(looped)).not.toContain(PASSWORD);
    expect(JSON.stringify(loop)).not.toContain(PASSWORD);

    const privateHost = await createAuthProvider({
      mode: 'hosted_credentials',
      targetOrigin: 'https://10.1.1.1/login',
      username: 'ada@example.test',
      password: PASSWORD,
      expiresAt: future,
    }).open();
    expect(privateHost.ok).toBe(false);
    if (!privateHost.ok) expect(privateHost.metadata.status).toBe('unsafe_origin');

    const seed = 'otp-seed-should-not-leak';
    const otp = await createAuthProvider({
      mode: 'hosted_credentials',
      targetOrigin: 'https://app.example.com/login',
      username: 'ada@example.test',
      password: PASSWORD,
      expiresAt: future,
      otp_seed: seed,
    }).open();
    expect(otp.ok).toBe(false);
    if (!otp.ok) expect(otp.metadata.status).toBe('auth_required');
    expect(JSON.stringify(otp)).not.toContain(seed);
    expect(JSON.stringify(otp)).not.toContain(PASSWORD);

    const sensitive = await createAuthProvider({
      mode: 'local_session',
      targetOrigin: 'https://app.example.com',
      storageState: jar('app.example.com'),
      expiresAt: future,
      allowSensitive: ['payment'],
    }).open();
    expect(sensitive.ok).toBe(false);
    if (!sensitive.ok) expect(sensitive.metadata.detail).toMatch(/allowSensitive/);
  });

  it('binds a same-host jar once and does not reload it', async () => {
    const provider = createAuthProvider({
      mode: 'local_session',
      targetOrigin: 'https://app.example.com',
      storageState: jar('app.example.com'),
      expiresAt: future,
    });
    const first = await provider.open();
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.metadata.status).toBe('auth_required');
    expect(JSON.stringify(first)).not.toContain(COOKIE);
    const second = await provider.open();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.metadata.status).toBe('auth_required');
    expect(JSON.stringify(second)).not.toContain(COOKIE);
    provider.release();
    expect(JSON.stringify(provider)).not.toContain(COOKIE);
  });

  it('rejects another host, a parent domain, and an expired envelope', async () => {
    const other = await createAuthProvider({
      mode: 'local_session',
      targetOrigin: 'https://app.example.com',
      storageState: jar('other.example.com'),
      expiresAt: future,
    }).open();
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.metadata.status).toBe('unsafe_origin');
    expect(JSON.stringify(other)).not.toContain(COOKIE);

    const copied = jar('app.example.com');
    let passwordReads = 0;
    const input = {
      mode: 'local_session' as const,
      targetOrigin: 'https://app.example.com',
      storageState: copied,
      expiresAt: future,
    };
    const tracked = new Proxy(input, {
      get(target, key, receiver) {
        if (key === 'password') passwordReads += 1;
        return Reflect.get(target, key, receiver);
      },
    });
    const provider = createAuthProvider(tracked);
    const readsAfterCreate = passwordReads;
    input.storageState = { cookies: [], origins: [] };
    const kept = await provider.open();
    expect(passwordReads).toBe(readsAfterCreate);
    expect(kept.ok).toBe(false);
    expect(JSON.stringify(kept)).not.toContain(COOKIE);

    const empty = await bindAuthProvider({
      targetOrigin: 'https://app.example.com',
      storageState: { cookies: [], origins: [] },
    });
    expect(empty.ok).toBe(false);
    const csrf = await bindAuthProvider({
      targetOrigin: 'https://app.example.com',
      storageState: {
        cookies: [{ ...jar('app.example.com').cookies[0]!, name: 'csrf_token' }],
        origins: [],
      },
    });
    expect(csrf.ok).toBe(false);
    const extra = await bindAuthProvider({
      targetOrigin: 'https://app.example.com',
      storageState: { ...jar('app.example.com'), comment: 'no' } as AuthStorageState,
    });
    expect(extra.ok).toBe(false);
    const badTime = await bindAuthProvider({
      targetOrigin: 'https://app.example.com',
      storageState: jar('app.example.com'),
      expiresAt: 'not-a-time',
    });
    expect(badTime.ok).toBe(false);

    const parent = await bindAuthProvider({
      targetOrigin: 'https://app.example.com',
      storageState: {
        cookies: [{ ...jar('example.com').cookies[0]!, domain: '.example.com' }],
        origins: [],
      },
    });
    expect(parent.ok).toBe(false);

    const expired = await createAuthProvider({
      mode: 'local_session',
      targetOrigin: 'https://app.example.com',
      storageState: jar('app.example.com'),
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }).open();
    expect(expired.ok).toBe(false);
    if (!expired.ok) {
      expect(expired.metadata.status).toBe('expired');
      expect(expired.metadata.detail).toMatch(/not a verified run/);
      expect(expired.metadata.detail).not.toMatch(/no confirmed bugs/);
      expect(expired.metadata.detail).toMatch(/couldn'?t complete/);
    }
    const triaged = triage(authBlockedRun('https://app.example.com', expired.ok ? expired.metadata : expired.metadata));
    expect(triaged.outcome).toBe('could_not_test');
    expect(triaged.outcome_reason).toBe('auth_expired');
    expect(triaged.outcome_detail).toMatch(/not a verified run/);
    expect(triaged.outcome_detail).not.toMatch(/no confirmed bugs/);
    expect(triaged.bugs).toEqual([]);
  });
});

describe('local session file', () => {
  it('is mode 600 in a mode 700 auth directory and is not reused without consent', () => {
    const root = mkdtempSync(join(tmpdir(), 'mt-auth-'));
    const path = join(root, 'auth', 'session.json');
    const policy = policyFrom('http://127.0.0.1:9/login').ok
      ? policyFrom('http://127.0.0.1:9/login')
      : undefined;
    expect(policy && policy.ok).toBe(true);
    if (!policy || !policy.ok) return;
    writeAuthSession({ path, policy: policy.policy, storageState: jar('127.0.0.1') });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'auth')).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toMatch(/^auth\/$/m);

    const refused = readAuthSession(path, policy.policy, { allow: false });
    expect(refused.storageState).toBeUndefined();
    expect(refused.metadata.status).toBe('auth_required');

    const loaded = readAuthSession(path, policy.policy, { allow: true });
    expect(loaded.metadata.status).toBe('authenticated');
    expect(JSON.stringify(loaded.metadata)).not.toContain(COOKIE);

    writeFileSync(join(root, 'auth', 'notes.txt'), 'keep');
    expect(() => writeAuthSession({ path, policy: policy.policy, storageState: jar('127.0.0.1') })).toThrow(/notes\.txt/);

    const past = mkdtempSync(join(tmpdir(), 'mt-auth-exp-'));
    const expiredPath = join(past, 'auth', 'session.json');
    writeAuthSession({
      path: expiredPath,
      policy: policy.policy,
      storageState: jar('127.0.0.1'),
      ttlMs: 60_000,
      nowMs: Date.now() - 120_000,
    });
    const stale = readAuthSession(expiredPath, policy.policy, { allow: true });
    expect(stale.metadata.status).toBe('expired');
    expect(stale.storageState).toBeUndefined();

    const kept = deleteAuthSession(path, { confirm: false });
    expect(kept.deleted).toBe(false);
    expect(kept.detail).toMatch(/does not sign the account out/);
    expect(deleteAuthSession(path, { confirm: true }).deleted).toBe(true);
    expect(decideRerunAuth(true, { useSession: false, freshSecret: false, manual: false })).toBe('not_authorized');
    expect(checkHostedTarget('http://127.0.0.1:9/login').ok).toBe(false);
    expect(checkHostedTarget('https://app.example.com/login').ok).toBe(true);
  });

  it('refuses a symlink and strips secrets from a saved run', () => {
    const root = mkdtempSync(join(tmpdir(), 'mt-auth-link-'));
    const dir = join(root, 'auth');
    const real = join(root, 'real-session.json');
    writeFileSync(real, '{"kind":"other"}');
    mkdirSync(dir, { recursive: true });
    symlinkSync(real, join(dir, 'session.json'));
    const policy = policyFrom('https://app.example.com').ok ? policyFrom('https://app.example.com') : undefined;
    if (!policy || !policy.ok) throw new Error('policy');
    expect(() => writeAuthSession({ path: join(dir, 'session.json'), policy: policy.policy, storageState: jar('app.example.com') })).toThrow(/symlink/);

    const blocked = authBlockedRun('https://app.example.com', {
      schema: 1,
      mode: 'session',
      outcome: 'expired',
      status: 'expired',
      targetOrigin: 'https://app.example.com',
      idpOrigins: [],
      sessionReused: false,
      loginCapture: 'disabled',
      runCapture: 'disabled',
      visibility: 'private',
      privateDataScrubbed: false,
      custody: 'in-memory',
      hostedProduct: false,
      interaction: 'read-mostly',
      detail: 'Our test couldn\'t complete the run because the sign-in expired.',
    });
    const dirty = {
      ...blocked,
      password: PASSWORD,
      storageState: jar('app.example.com'),
    };
    const saved = saveRun(dirty as never, { dir: root });
    const text = readFileSync(saved.path, 'utf8');
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(COOKIE);
    expect(text).not.toContain('storageState');
    expect(redactValue(`saw ${COOKIE}`, [COOKIE])).toBe('saw [redacted]');
  });
});

describe('stdout buffers', () => {
  it('scrubs a Buffer write while a sensitive scope is active', async () => {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return true;
    }) as typeof process.stdout.write;
    try {
      await withSensitiveSinks([PASSWORD], async () => {
        process.stdout.write(Buffer.from(`prefix ${PASSWORD} suffix`));
      });
    } finally {
      process.stdout.write = original;
    }
    expect(chunks.join('')).not.toContain(PASSWORD);
    expect(chunks.join('')).toContain('[redacted]');
  });
});
