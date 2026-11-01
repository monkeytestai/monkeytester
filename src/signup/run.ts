/**
 * Deterministic sign-up steps.
 *
 * Validation steps submit an incomplete or invalid form only.
 * `inbox_verify` is the one live submit: MonkeyTest QA, the allocated
 * address, an in-memory password, then the verification link.
 */

import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import type { InboxProvider, SignupCheck, StepStatus } from '../types.js';
import {
  INVALID_SIGNUP_EMAIL,
  MISMATCH_SIGNUP_EMAIL,
  SIGNUP_IDENTITY_NAME,
  syntacticEmail,
} from './detect.js';
import { probeSignup } from './guard.js';
import { noteSignup, type SignupLedger } from './ledger.js';

const WAIT_MS = 60_000;
const MISMATCH_A = 'not-a-real-password';
const MISMATCH_B = 'different-password';

export interface SignupStepOutcome {
  status: StepStatus;
  observation: string;
  error?: string;
  tool: 'click' | 'fill' | 'goto' | 'noop';
  target?: string;
  value?: string;
}

export async function runSignupCheck(
  page: Page,
  check: SignupCheck,
  opts: {
    ledger: SignupLedger;
    inbox?: InboxProvider;
    runId: string;
    timeoutMs: number;
    signal?: AbortSignal;
    submitLabel?: string;
  },
): Promise<SignupStepOutcome> {
  const probe = await probeSignup(page);
  opts.ledger.sawForm = true;
  if (!opts.inbox) noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'no_inbox' });
  if (!probe.isSignup) {
    noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'no_signup_form' });
    return { status: 'skipped', observation: 'No sign-up form was on the page.', tool: 'noop' };
  }
  if (probe.blocked) {
    noteSignup(opts.ledger, { saw: true, status: 'blocked', reason: probe.blocked });
    return {
      status: 'skipped',
      observation: `The sign-up form asks for ${probe.blocked}. It was not submitted.`,
      tool: 'noop',
    };
  }

  if (check === 'inbox_verify') return runInboxSignup(page, probe, opts);

  const before = page.url();
  if (check === 'invalid_email') {
    const filled = await fillNamed(page, probe.email, INVALID_SIGNUP_EMAIL);
    if (!filled) return { status: 'failed', observation: 'No email field was found on the sign-up form.', error: 'no-email-field', tool: 'fill' };
  }
  if (check === 'password_mismatch') {
    if (!probe.password || !probe.confirm) {
      return { status: 'skipped', observation: 'The sign-up form has no password confirmation field.', tool: 'noop' };
    }
    await fillNamed(page, probe.email, MISMATCH_SIGNUP_EMAIL);
    await fillNamed(page, probe.password, MISMATCH_A);
    await fillNamed(page, probe.confirm, MISMATCH_B);
  }
  const clicked = await clickSubmit(page, opts.submitLabel || probe.submitLabels[0]);
  if (!clicked.ok) return { status: 'failed', observation: clicked.observation, error: 'no-submit', tool: 'click' };
  await settle(page);
  const validation = await seesValidation(page);
  const stayed = sameUrl(before, page.url());
  if (!validation) {
    return { status: 'failed', observation: 'Submitting the invalid sign-up form did not show a validation message.', error: 'no-validation', tool: 'click', target: clicked.target };
  }
  if (!stayed) {
    return { status: 'failed', observation: `The invalid sign-up form navigated to ${page.url()}.`, error: 'navigated', tool: 'click', target: clicked.target };
  }
  if (!opts.inbox) noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'no_inbox' });
  else noteSignup(opts.ledger, { saw: true });
  const detail = check === 'empty_submit'
    ? 'Empty submit showed validation and did not leave the page.'
    : check === 'invalid_email'
      ? 'The invalid email was rejected and the form was not completed.'
      : 'Mismatched passwords were rejected and the form was not completed.';
  return { status: 'passed', observation: detail, tool: 'click', target: clicked.target, ...(check === 'invalid_email' ? { value: INVALID_SIGNUP_EMAIL } : {}) };
}

async function runInboxSignup(
  page: Page,
  probe: Awaited<ReturnType<typeof probeSignup>>,
  opts: {
    ledger: SignupLedger;
    inbox?: InboxProvider;
    runId: string;
    timeoutMs: number;
    signal?: AbortSignal;
    submitLabel?: string;
  },
): Promise<SignupStepOutcome> {
  if (!opts.inbox) {
    noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'no_inbox' });
    return { status: 'skipped', observation: 'Sign-up was not attempted because no inbox provider is configured.', tool: 'noop' };
  }
  if (opts.ledger.usedLiveSubmit) {
    noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'cap_reached' });
    return { status: 'skipped', observation: 'Sign-up was not attempted because this run already used its one account.', tool: 'noop' };
  }
  if (opts.signal?.aborted) {
    noteSignup(opts.ledger, { saw: true, attempted: true, status: 'unverified', reason: 'timeout' });
    return { status: 'skipped', observation: 'Sign-up was not attempted because the flow was already out of time.', tool: 'noop' };
  }

  let allocated: { address: string; expiresAt?: string };
  try {
    allocated = await opts.inbox.allocate({ runId: opts.runId, purpose: 'signup' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'timeout' });
    return { status: 'skipped', observation: `The inbox provider did not allocate an address (${message}).`, tool: 'noop' };
  }
  if (!syntacticEmail(allocated.address)) {
    noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'timeout' });
    return { status: 'skipped', observation: 'The inbox provider returned an address that is not an email.', tool: 'noop' };
  }

  const password = signupPassword();
  opts.ledger.usedLiveSubmit = true;
  const sinceMs = Date.now();
  try {
    if (probe.name) await fillNamed(page, probe.name, SIGNUP_IDENTITY_NAME);
    if (probe.email) await fillNamed(page, probe.email, allocated.address);
    if (probe.password) await fillNamed(page, probe.password, password);
    if (probe.confirm) await fillNamed(page, probe.confirm, password);
    const clicked = await clickSubmit(page, opts.submitLabel || probe.submitLabels[0]);
    if (!clicked.ok) {
      noteSignup(opts.ledger, { saw: true, attempted: true, status: 'unverified', reason: 'timeout' });
      return { status: 'skipped', observation: 'The sign-up form had no submit control.', tool: 'click' };
    }
    noteSignup(opts.ledger, { saw: true, attempted: true, status: 'unverified', reason: 'timeout' });
    await settle(page);
    let mail: Awaited<ReturnType<InboxProvider['waitFor']>>;
    try {
      mail = await opts.inbox.waitFor({
        address: allocated.address,
        sinceMs,
        timeoutMs: WAIT_MS,
        kind: 'link',
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) {
        return { status: 'skipped', observation: 'Stopped waiting for the verification message because the run was cancelled.', tool: 'noop', value: allocated.address };
      }
      const message = err instanceof Error ? err.message : String(err);
      return { status: 'skipped', observation: `The inbox wait failed (${message}).`, tool: 'noop', value: allocated.address };
    }
    if (!mail.received) {
      return { status: 'skipped', observation: 'No verification message arrived before the timeout.', tool: 'noop', value: allocated.address };
    }
    const link = pickLink(mail);
    if (!link) {
      noteSignup(opts.ledger, { saw: true, attempted: true, status: 'unverified' });
      return { status: 'skipped', observation: 'The verification message had no http(s) link.', tool: 'noop', value: allocated.address };
    }
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: opts.timeoutMs });
    await settle(page);
    const confirmed = await page.evaluate(() => /verified|confirmed|welcome|account created|success|you(?:'| a)?re in/i.test((document.body?.innerText || '').slice(0, 4000))).catch(() => false);
    if (!confirmed) {
      noteSignup(opts.ledger, { saw: true, attempted: true, status: 'unverified' });
      return { status: 'failed', observation: 'The verification link opened, but the page did not confirm the address.', error: 'signup-unconfirmed', tool: 'goto', target: link, value: allocated.address };
    }
    noteSignup(opts.ledger, { saw: true, verified: true });
    return { status: 'passed', observation: 'The inbox message was received and the verification link confirmed the address.', tool: 'goto', target: link, value: allocated.address };
  } finally {
    await opts.inbox.release?.({ address: allocated.address }).catch(() => {});
  }
}

export function signupPassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const bytes = randomBytes(18);
  let body = '';
  for (const byte of bytes) body += alphabet[byte % alphabet.length];
  return `Aa1!${body}`;
}

function pickLink(mail: { links?: string[]; text?: string; html?: string }): string | undefined {
  const fromBody = extractLinks(`${mail.text || ''}\n${mail.html || ''}`);
  const links = [...(mail.links ?? []), ...fromBody].filter(link => /^https?:\/\//i.test(link));
  const ranked = [...links].sort((a, b) => linkScore(b) - linkScore(a));
  return ranked[0];
}

function extractLinks(body: string): string[] {
  return body.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
}

function linkScore(link: string): number {
  return /verify|confirm|activate|validation|token/i.test(link) ? 2 : 1;
}

async function fillNamed(page: Page, field: { name?: string; label?: string; id?: string; type?: string } | undefined, value: string): Promise<boolean> {
  if (!field) return false;
  const selectors = [
    field.id ? `#${cssEscape(field.id)}` : '',
    field.name ? `[name="${field.name.replace(/"/g, '\\"')}"]` : '',
    field.type ? `input[type="${field.type}"]` : '',
  ].filter(Boolean);
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count() === 0) continue;
    await locator.fill(value);
    return true;
  }
  if (field.label) {
    const byLabel = page.getByLabel(field.label, { exact: false }).first();
    if (await byLabel.count() > 0) {
      await byLabel.fill(value);
      return true;
    }
  }
  return false;
}

async function clickSubmit(page: Page, label: string | undefined): Promise<{ ok: true; target: string } | { ok: false; observation: string }> {
  if (label) {
    const named = page.getByRole('button', { name: label }).first();
    if (await named.count() > 0) {
      await named.click({ timeout: 5_000 });
      return { ok: true, target: label };
    }
  }
  const button = page.locator('form button[type="submit"], form input[type="submit"], form button:not([type]), button').first();
  if (await button.count() === 0) return { ok: false, observation: 'No sign-up submit control was found.' };
  const target = ((await button.innerText().catch(() => '')) || 'submit').trim().slice(0, 80);
  await button.click({ timeout: 5_000 });
  return { ok: true, target };
}

async function seesValidation(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('input, textarea, select'));
    if (controls.some(el => el.matches(':invalid') || el.getAttribute('aria-invalid') === 'true')) return true;
    const text = (document.body?.innerText || '').slice(0, 4000);
    return /required|invalid|valid email|enter (your |an |a )?email|please (enter|fill|provide)|do not match|doesn't match|mismatch|must match/i.test(text);
  }).catch(() => false);
}

function sameUrl(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    left.hash = '';
    right.hash = '';
    return left.href === right.href;
  } catch {
    return a === b;
  }
}

function cssEscape(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 1_500 }).catch(() => {});
}
