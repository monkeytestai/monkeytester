/**
 * Deterministic sign-in before any model call.
 * Form mode types the password only into a password field whose form posts
 * to an authorized origin. Manual mode never receives the password.
 * Neither mode records a screenshot, video, HAR, or trace. Playwright debug
 * tracing is unset for this phase because it can print typed text.
 */

import { chromium, type BrowserContext, type Page } from 'playwright';
import type {
  AuthOriginPolicy, AuthPublicMetadata, AuthSecretProvider, AuthStorageState, RuntimeAuthProvider,
} from './contract.js';
import { installLoginFence, type FenceState } from './fence.js';
import { acceptSessionMaterial, assertSessionBound, originAllowed, policyFrom } from './origins.js';
import { assertPublicSafe, redactError, storageContainsSecret } from './redact.js';
import { publicMetadata } from './report.js';

export interface AuthSuccess {
  ok: true;
  setup: false;
  metadata: AuthPublicMetadata;
  storageState: AuthStorageState;
  authOrigin: AuthOriginPolicy;
  toJSON(): { ok: true; setup: false; metadata: AuthPublicMetadata; storageState: { redacted: true } };
}

export interface AuthFailure {
  ok: false;
  setup: boolean;
  metadata: AuthPublicMetadata;
}

export type AuthResult = AuthSuccess | AuthFailure;

const MIN_PASSWORD = 8;

export async function establishFormAuth(input: {
  targetUrl: string;
  idpOrigins?: string[];
  provider: AuthSecretProvider;
  headless?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  expiresAt?: string;
  custody?: AuthPublicMetadata['custody'];
}): Promise<AuthResult> {
  const policyResult = policyFrom(input.targetUrl, input.idpOrigins ?? []);
  if (!policyResult.ok) {
    return failure('form', 'target_rejected', { targetOrigin: 'https://invalid.invalid', idpOrigins: [] }, true, policyResult.detail);
  }
  const policy = policyResult.policy;
  const taken = input.provider.takeSecrets();
  if (!taken || 'missing' in taken) {
    const name = taken && 'missing' in taken ? taken.missing : 'the password variable';
    input.provider.release();
    return failure('form', 'not_authorized', policy, true, `Environment variable ${name} is unset. Nothing was typed. Env vars are visible to the shell, CI logs, and process listings.`);
  }
  if (taken.password.length < MIN_PASSWORD) {
    input.provider.release();
    return failure('form', 'not_authorized', policy, true, 'The password must be at least 8 characters. It was not typed and it was not saved.');
  }
  const secrets = [taken.password, taken.username].filter(secret => secret.length >= 8);
  return withLoginCaptureOff(async () => {
    const browser = await chromium.launch({ headless: input.headless !== false });
    let context: BrowserContext | undefined;
    const fence: FenceState = { originRejected: false };
    try {
      context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await installLoginFence(context, policy, fence);
      const page = await context.newPage();
      const timeout = input.timeoutMs ?? 20_000;
      try {
        await page.goto(input.targetUrl, { waitUntil: 'domcontentloaded', timeout });
      } catch (err) {
        if (input.signal?.aborted) return failure('form', 'not_authorized', policy, false, 'Our test couldn\'t complete the run because sign-in was cancelled. The session was not kept. This is not a verified run.');
        if (navigationRejected(err, fence, await onPolicy(page, policy))) return failure('form', 'origin_rejected', policy, false);
        throw redactError(err, secrets);
      }
      if (fence.originRejected || !(await onPolicy(page, policy))) return failure('form', 'origin_rejected', policy, false);
      const before = await classifyPage(page, policy, 'before');
      if (before === 'off') return failure('form', 'origin_rejected', policy, false);
      if (before === 'mfa' || before === 'sso') return failure('form', 'mfa_required', policy, false);
      if (before !== 'login') {
        return failure('form', 'credentials_rejected', policy, false, 'Our test couldn\'t complete the run because the authorized page has no password field. Nothing was typed. This is not a verified run.');
      }
      if (!(await formPostsToPolicy(page, policy))) {
        return failure('form', 'origin_rejected', policy, false, 'Our test couldn\'t complete the run because the sign-in form posts off the authorized origin. The password was not typed. This is not a verified run.');
      }
      try {
        await fillLogin(page, taken.username, taken.password, timeout);
      } catch (err) {
        if (input.signal?.aborted) return failure('form', 'not_authorized', policy, false, 'Our test couldn\'t complete the run because sign-in was cancelled. The session was not kept. This is not a verified run.');
        if (navigationRejected(err, fence, true)) return failure('form', 'origin_rejected', policy, false);
        throw redactError(err, secrets);
      }
      if (fence.originRejected) return failure('form', 'origin_rejected', policy, false);
      const after = await classifyPage(page, policy, 'after');
      if (fence.originRejected || after === 'off') return failure('form', 'origin_rejected', policy, false);
      if (after === 'mfa') return failure('form', 'mfa_required', policy, false);
      if (after === 'login') return failure('form', 'credentials_rejected', policy, false);
      const state = await snapshot(context);
      if (input.signal?.aborted) {
        return failure('form', 'not_authorized', policy, false, 'Our test couldn\'t complete the run because sign-in was cancelled. The session was not kept. This is not a verified run.');
      }
      if (input.expiresAt && Date.parse(input.expiresAt) <= Date.now()) {
        return failure('form', 'expired', policy, false, 'Our test couldn\'t complete the run because the sign-in envelope expired before the browser finished. The session was not kept. This is not a verified run.');
      }
      const material = acceptSessionMaterial(state);
      if (!material.ok) {
        return failure('form', 'credentials_rejected', policy, false, `Our test couldn't complete the run. ${material.detail} This is not a verified run.`);
      }
      if (storageContainsSecret(state, secrets)) return failure('form', 'storage_unsafe', policy, false);
      const bound = assertSessionBound(state, policy);
      if (!bound.ok) return failure('form', 'origin_rejected', policy, false, `Our test couldn't complete the run. ${bound.detail} This is not a verified run.`);
      return success('form', policy, state, input.custody ?? 'customer-local', false, input.expiresAt);
    } finally {
      input.provider.release();
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  });
}

export async function establishManualAuth(input: {
  targetUrl: string;
  idpOrigins?: string[];
  settle?: (page: Page) => Promise<void>;
  headless?: boolean;
  timeoutMs?: number;
}): Promise<AuthResult> {
  const policyResult = policyFrom(input.targetUrl, input.idpOrigins ?? []);
  if (!policyResult.ok) {
    return failure('manual', 'target_rejected', { targetOrigin: 'https://invalid.invalid', idpOrigins: [] }, true, policyResult.detail);
  }
  const policy = policyResult.policy;
  if (!input.settle) {
    return failure('manual', 'not_authorized', policy, true, 'Manual login needs a person at a headed browser. Nothing was typed.');
  }
  return withLoginCaptureOff(async () => {
    const browser = await chromium.launch({ headless: input.headless === true });
    let context: BrowserContext | undefined;
    const fence: FenceState = { originRejected: false };
    try {
      context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      await installLoginFence(context, policy, fence);
      const page = await context.newPage();
      const timeout = input.timeoutMs ?? 20_000;
      try {
        await page.goto(input.targetUrl, { waitUntil: 'domcontentloaded', timeout });
      } catch (err) {
        if (navigationRejected(err, fence, await onPolicy(page, policy))) return failure('manual', 'origin_rejected', policy, false);
        throw redactError(err, []);
      }
      if (fence.originRejected) return failure('manual', 'origin_rejected', policy, false);
      await input.settle!(page);
      await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
      if (fence.originRejected) return failure('manual', 'origin_rejected', policy, false);
      const after = await classifyPage(page, policy, 'after');
      if (after === 'off') return failure('manual', 'origin_rejected', policy, false);
      if (after === 'mfa' || after === 'login') {
        return failure('manual', 'mfa_required', policy, false, 'Our test couldn\'t complete the run because the headed login is still on a password or second-factor screen. The session was not saved. No one-time-code seed was stored. This is not a verified run.');
      }
      const state = await snapshot(context);
      if (!hasSessionMaterial(state)) {
        return failure('manual', 'mfa_required', policy, false, 'Our test couldn\'t complete the run because the headed login did not store a session. Sign in fully, including SSO or a second factor, then confirm. Nothing was saved. This is not a verified run.');
      }
      const bound = assertSessionBound(state, policy);
      if (!bound.ok) return failure('manual', 'origin_rejected', policy, false, `Our test couldn't complete the run. ${bound.detail} This is not a verified run.`);
      return success('manual', policy, state, 'customer-local');
    } finally {
      await context?.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  });
}

/** Accept a session the host already holds. Does not write a file and does not mean hosted sign-in is live. */
export async function establishWithRuntimeProvider(
  provider: RuntimeAuthProvider,
  targetUrl: string,
  idpOrigins: string[] = [],
): Promise<AuthResult> {
  const policyResult = policyFrom(targetUrl, idpOrigins);
  if (!policyResult.ok) {
    return failure('session', 'target_rejected', { targetOrigin: 'https://invalid.invalid', idpOrigins: [] }, true, policyResult.detail, 'in-memory');
  }
  const opened = await provider.open(policyResult.policy);
  if (!opened.ok) {
    return failure('session', opened.outcome, policyResult.policy, opened.outcome === 'not_authorized', undefined, 'in-memory');
  }
  const bound = assertSessionBound(opened.storageState, policyResult.policy);
  if (!bound.ok) {
    return failure('session', 'origin_rejected', policyResult.policy, false, `Our test couldn't complete the run. ${bound.detail} This is not a verified run.`, 'in-memory');
  }
  return success('session', policyResult.policy, opened.storageState, 'in-memory', true);
}

function success(
  mode: AuthPublicMetadata['mode'],
  policy: AuthOriginPolicy,
  storageState: AuthStorageState,
  custody: AuthPublicMetadata['custody'],
  sessionReused = false,
  expiresAt?: string,
): AuthSuccess {
  const metadata = publicMetadata({
    mode,
    outcome: 'authenticated',
    policy,
    custody,
    sessionReused,
    ...(expiresAt ? { expiresAt } : {}),
  });
  assertPublicSafe(metadata, secretValues(storageState));
  return {
    ok: true,
    setup: false,
    metadata,
    storageState,
    authOrigin: policy,
    toJSON: () => ({ ok: true as const, setup: false as const, metadata, storageState: { redacted: true as const } }),
  };
}

function failure(
  mode: AuthPublicMetadata['mode'],
  outcome: Exclude<AuthPublicMetadata['outcome'], 'authenticated'>,
  policy: { targetOrigin: string; idpOrigins: string[] },
  setup: boolean,
  detail?: string,
  custody: AuthPublicMetadata['custody'] = 'customer-local',
): AuthFailure {
  return { ok: false, setup, metadata: publicMetadata({ mode, outcome, policy, custody, detail }) };
}

async function fillLogin(page: Page, username: string, password: string, timeout: number): Promise<void> {
  const user = page.locator('input[type="email"], input[autocomplete="username"], input[name="email" i], input[name="username" i], input[type="text"]').first();
  const pass = page.locator('input[type="password"]').first();
  await user.fill(username, { timeout });
  await pass.fill(password, { timeout });
  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  if (await submit.count()) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {}),
      submit.click({ timeout }),
    ]);
  } else {
    await pass.press('Enter');
  }
  await page.waitForLoadState('domcontentloaded', { timeout }).catch(() => {});
}

async function formPostsToPolicy(page: Page, policy: AuthOriginPolicy): Promise<boolean> {
  const form = page.locator('form').filter({ has: page.locator('input[type="password"]') }).first();
  if (!(await form.count())) return true;
  const action = await form.getAttribute('action');
  if (!action || action === '#') return true;
  try { return originAllowed(new URL(action, page.url()), policy); }
  catch { return false; }
}

async function classifyPage(page: Page, policy: AuthOriginPolicy, phase: 'before' | 'after'): Promise<'off' | 'mfa' | 'sso' | 'login' | 'in'> {
  if (!(await onPolicy(page, policy))) return 'off';
  const otp = await page.locator('input[autocomplete="one-time-code"], input[name*="otp" i], input[name*="totp" i], input[name*="mfa" i]').count();
  const text = await page.locator('body').innerText().catch(() => '');
  if (otp > 0 || /\b(verification code|authenticator app|two-factor|2-step verification|one-time code|enter the code)\b/i.test(text)) return 'mfa';
  if (await page.locator('input[type="password"]').count()) return 'login';
  if (phase === 'before' && /\b(continue with|sign in with|log in with|single sign-on|\bsso\b)\b/i.test(text)) return 'sso';
  return 'in';
}

async function onPolicy(page: Page, policy: AuthOriginPolicy): Promise<boolean> {
  try { return originAllowed(new URL(page.url()), policy); }
  catch { return false; }
}

async function snapshot(context: BrowserContext): Promise<AuthStorageState> {
  const raw = await context.storageState();
  return {
    cookies: raw.cookies.map(cookie => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite === 'Strict' || cookie.sameSite === 'None' ? cookie.sameSite : 'Lax',
    })),
    origins: raw.origins.map(origin => ({
      origin: origin.origin,
      localStorage: origin.localStorage.map(item => ({ name: item.name, value: item.value })),
    })),
  };
}

function hasSessionMaterial(state: AuthStorageState): boolean {
  return state.cookies.length > 0 || state.origins.some(origin => origin.localStorage.length > 0);
}

function secretValues(state: AuthStorageState): string[] {
  return [
    ...state.cookies.map(cookie => cookie.value),
    ...state.origins.flatMap(origin => origin.localStorage.map(item => item.value)),
  ].filter(value => value.length >= 8);
}

function navigationRejected(err: unknown, fence: { originRejected: boolean }, onOrigin: boolean): boolean {
  if (fence.originRejected || !onOrigin) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT|ERR_BLOCKED/.test(message);
}

async function withLoginCaptureOff<T>(fn: () => Promise<T>): Promise<T> {
  const saved = { DEBUG: process.env.DEBUG, PWDEBUG: process.env.PWDEBUG };
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  try { return await fn(); }
  finally {
    if (saved.DEBUG === undefined) delete process.env.DEBUG;
    else process.env.DEBUG = saved.DEBUG;
    if (saved.PWDEBUG === undefined) delete process.env.PWDEBUG;
    else process.env.PWDEBUG = saved.PWDEBUG;
  }
}
