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
import { isOauthControl, isOauthLanding, primarySubmitLabel } from './submit.js';

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
  /** Ordered phases so a report can see where sign-up stopped. */
  phases?: string[];
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

  const phases = ['opened'];
  const before = page.url();
  if (check === 'invalid_email') {
    const filled = await fillNamed(page, probe.email, INVALID_SIGNUP_EMAIL);
    noteSignup(opts.ledger, { started: true, saw: true });
    if (!filled) return fillFailed(opts.ledger, phases);
    phases.push('filled');
  }
  if (check === 'password_mismatch') {
    if (!probe.password || !probe.confirm) {
      return { status: 'skipped', observation: 'The sign-up form has no password confirmation field.', tool: 'noop', phases };
    }
    noteSignup(opts.ledger, { started: true, saw: true });
    const emailOk = await fillNamed(page, probe.email, MISMATCH_SIGNUP_EMAIL);
    const passwordOk = await fillNamed(page, probe.password, MISMATCH_A);
    const confirmOk = await fillNamed(page, probe.confirm, MISMATCH_B);
    if (!emailOk || !passwordOk || !confirmOk) return fillFailed(opts.ledger, phases);
    phases.push('filled');
  }
  const clicked = await clickSubmit(page, opts.submitLabel || primarySubmitLabel(probe.submitLabels));
  if (!clicked.ok) return { status: 'failed', observation: clicked.observation, error: 'no-submit', tool: 'click', phases };
  phases.push('submitted');
  await settle(page);
  if (isOauthLanding(page.url())) {
    return phaseResult({
      status: 'skipped',
      observation: `Sign-up validation navigated to ${page.url()}. That is an OAuth page, not a missing validation message.`,
      tool: 'click',
      target: clicked.target,
      phases,
    });
  }
  const validation = await seesValidation(page);
  const stayed = sameUrl(before, page.url());
  if (!validation) {
    return phaseResult({
      status: 'failed',
      observation: 'Submitting the invalid sign-up form did not show a validation message.',
      error: 'no-validation',
      tool: 'click',
      target: clicked.target,
      phases,
    });
  }
  if (!stayed) {
    return phaseResult({
      status: 'failed',
      observation: `The invalid sign-up form navigated to ${page.url()}.`,
      error: 'navigated',
      tool: 'click',
      target: clicked.target,
      phases,
    });
  }
  if (!opts.inbox) noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'no_inbox' });
  else noteSignup(opts.ledger, { saw: true });
  const detail = check === 'empty_submit'
    ? 'Empty submit showed validation and did not leave the page.'
    : check === 'invalid_email'
      ? 'The invalid email was rejected and the form was not completed.'
      : 'Mismatched passwords were rejected and the form was not completed.';
  phases.push('validation shown');
  return phaseResult({
    status: 'passed',
    observation: detail,
    tool: 'click',
    target: clicked.target,
    phases,
    ...(check === 'invalid_email' ? { value: INVALID_SIGNUP_EMAIL } : {}),
  });
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

  const phases = ['opened'];
  let allocated: { address: string; expiresAt?: string };
  try {
    allocated = await opts.inbox.allocate({ runId: opts.runId, purpose: 'signup' });
    phases.push('inbox allocated');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'timeout' });
    return phaseResult({ status: 'skipped', observation: `The inbox provider did not allocate an address (${message}).`, tool: 'noop', phases });
  }
  if (!syntacticEmail(allocated.address)) {
    noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'timeout' });
    return phaseResult({ status: 'skipped', observation: 'The inbox provider returned an address that is not an email.', tool: 'noop', phases });
  }

  const password = signupPassword();
  opts.ledger.usedLiveSubmit = true;
  const sinceMs = Date.now();
  try {
    if (opts.signal?.aborted) return timedOut(opts, allocated.address, phases);
    noteSignup(opts.ledger, { started: true, saw: true });
    if (probe.name && !await fillNamed(page, probe.name, SIGNUP_IDENTITY_NAME)) return fillFailed(opts.ledger, phases, allocated.address);
    if (probe.email && !await fillNamed(page, probe.email, allocated.address)) return fillFailed(opts.ledger, phases, allocated.address);
    if (probe.password && !await fillNamed(page, probe.password, password)) return fillFailed(opts.ledger, phases, allocated.address);
    if (probe.confirm && !await fillNamed(page, probe.confirm, password)) return fillFailed(opts.ledger, phases, allocated.address);
    phases.push('filled');
    const clicked = await clickSubmit(page, opts.submitLabel || primarySubmitLabel(probe.submitLabels));
    if (!clicked.ok) {
      noteSignup(opts.ledger, { saw: true, attempted: true, status: 'unverified', reason: 'timeout' });
      return phaseResult({ status: 'skipped', observation: 'The sign-up form had no submit control.', tool: 'click', phases, value: allocated.address });
    }
    phases.push('submitted');
    noteSignup(opts.ledger, { saw: true, attempted: true, status: 'unverified', reason: 'timeout' });
    await settle(page);
    if (isOauthLanding(page.url())) {
      return phaseResult({
        status: 'skipped',
        observation: `Sign-up submit navigated to ${page.url()}. That is an OAuth page, not a completed sign-up.`,
        tool: 'click',
        target: clicked.target,
        phases,
        value: allocated.address,
      });
    }
    phases.push('waiting');
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
      if (opts.signal?.aborted) return timedOut(opts, allocated.address, phases);
      const message = err instanceof Error ? err.message : String(err);
      return phaseResult({ status: 'skipped', observation: `The inbox wait failed (${message}).`, tool: 'noop', phases, value: allocated.address });
    }
    if (!mail.received) {
      phases.push('timeout');
      noteSignup(opts.ledger, { saw: true, attempted: true, status: 'unverified', reason: 'timeout' });
      return phaseResult({
        status: 'skipped',
        observation: 'No verification message arrived before the timeout (signup_reason timeout).',
        tool: 'noop',
        phases,
        value: allocated.address,
      });
    }
    phases.push('mail received');
    const link = pickLink(mail);
    if (!link) {
      noteSignup(opts.ledger, { saw: true, attempted: true, status: 'unverified' });
      return phaseResult({ status: 'skipped', observation: 'The verification message had no http(s) link.', tool: 'noop', phases, value: allocated.address });
    }
    await page.goto(link, { waitUntil: 'domcontentloaded', timeout: Math.max(opts.timeoutMs, 10_000) });
    phases.push('link followed');
    await settle(page);
    const confirmed = await page.evaluate(() => /verified|confirmed|welcome|account created|success|you(?:'| a)?re in/i.test((document.body?.innerText || '').slice(0, 4000))).catch(() => false);
    if (!confirmed) {
      noteSignup(opts.ledger, { saw: true, attempted: true, status: 'unverified' });
      return phaseResult({ status: 'failed', observation: 'The verification link opened, but the page did not confirm the address.', error: 'signup-unconfirmed', tool: 'goto', target: link, phases, value: allocated.address });
    }
    noteSignup(opts.ledger, { saw: true, verified: true });
    return phaseResult({ status: 'passed', observation: 'The inbox message was received and the verification link confirmed the address.', tool: 'goto', target: link, phases, value: allocated.address });
  } finally {
    await opts.inbox.release?.({ address: allocated.address }).catch(() => {});
  }
}

function timedOut(
  opts: { ledger: SignupLedger },
  address: string,
  phases: string[],
): SignupStepOutcome {
  phases.push('timeout');
  noteSignup(opts.ledger, { saw: true, attempted: true, status: 'unverified', reason: 'timeout' });
  return phaseResult({
    status: 'skipped',
    observation: 'The sign-up wait was cut off (signup_reason timeout).',
    tool: 'noop',
    phases,
    value: address,
  });
}

function fillFailed(ledger: SignupLedger, phases: string[], value?: string): SignupStepOutcome {
  phases.push('fill failed');
  noteSignup(ledger, { started: true, saw: true, status: 'not_tested', reason: 'automation_error' });
  return phaseResult({
    status: 'skipped',
    observation: 'Our test couldn\'t fill a non-interactable sign-up field before submit. This is not a bug in the site.',
    error: 'automation_error',
    tool: 'fill',
    phases,
    ...(value ? { value } : {}),
  });
}

function phaseResult(outcome: SignupStepOutcome): SignupStepOutcome {
  const phases = outcome.phases ?? [];
  const trace = phases.length ? `Phases: ${phases.join(' → ')}.` : '';
  return {
    ...outcome,
    observation: [outcome.observation, trace].filter(Boolean).join(' '),
  };
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
    const locator = page.locator(selector);
    const count = await locator.count().catch(() => 0);
    for (let i = 0; i < Math.min(count, 4); i++) {
      const candidate = locator.nth(i);
      const ok = await candidate.evaluate(el => {
        const html = el as HTMLInputElement;
        const type = (html.getAttribute('type') || '').toLowerCase();
        if (type === 'hidden' || html.disabled) return false;
        if (html.hidden || html.getAttribute('aria-hidden') === 'true') return false;
        let node: Element | null = html;
        while (node) {
          if (node instanceof HTMLElement && (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert'))) return false;
          node = node.parentElement;
        }
        const style = getComputedStyle(html);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
        const rect = html.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1 || rect.right < 0 || rect.bottom < 0) return false;
        return true;
      }).catch(() => false);
      if (!ok) continue;
      try {
        await candidate.fill(value, { timeout: 1_500 });
        return true;
      } catch {
        continue;
      }
    }
  }
  if (field.label) {
    const byLabel = page.getByLabel(field.label, { exact: false });
    if (await byLabel.count().catch(() => 0) > 0) {
      try {
        await byLabel.first().fill(value, { timeout: 1_500 });
        return true;
      } catch {
        return false;
      }
    }
  }
  return false;
}

async function clickSubmit(page: Page, label: string | undefined): Promise<{ ok: true; target: string } | { ok: false; observation: string }> {
  const wanted = label && !isOauthControl(label) ? label : '';
  const picked = await page.evaluate((name) => {
    function textOf(el: Element): string {
      return ((el as HTMLElement).innerText || el.getAttribute('aria-label') || (el as HTMLInputElement).value || '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    function hrefOf(el: Element): string {
      const own = el.getAttribute('href') || '';
      const parent = el.closest('a');
      return own || parent?.getAttribute('href') || '';
    }
    function oauth(el: Element): boolean {
      const label = `${textOf(el)} ${hrefOf(el)}`;
      if (/\/auth\/(?:google|facebook|github|apple|microsoft|oauth)\b/i.test(label)) return true;
      if (/\b(?:continue with|sign[\s-]*in with|sign[\s-]*up with|log[\s-]*in with|use)\s+(?:google|facebook|github|apple|microsoft)\b/i.test(textOf(el))) return true;
      if (/\b(continue with|sign[\s-]*in with|sign[\s-]*up with|log[\s-]*in with)\b/i.test(label)) return true;
      if (/\b(google|facebook|github|apple|microsoft)\b/i.test(textOf(el)) && /auth/i.test(hrefOf(el) + textOf(el))) return true;
      return false;
    }
    function visible(el: Element): boolean {
      const html = el as HTMLElement;
      const style = getComputedStyle(html);
      const rect = html.getBoundingClientRect();
      if (style.visibility === 'hidden' || style.display === 'none' || html.hidden) return false;
      return rect.width > 1 && rect.height > 1;
    }
    const email = document.querySelector('input[type="email"], input[name*="email" i], input[autocomplete="email"]');
    const form = email?.closest('form') || document.querySelector('form');
    const root: ParentNode = form || document;
    const candidates = Array.from(root.querySelectorAll('button, input[type="submit"], [role="button"]'))
      .filter(el => visible(el) && !oauth(el));
    const named = name
      ? candidates.find(el => textOf(el).toLowerCase() === name.toLowerCase())
      : undefined;
    const typed = candidates.find(el => (el.getAttribute('type') || '').toLowerCase() === 'submit');
    const labelled = candidates.find(el => /\b(create(?:\s+an?)?\s+account|sign[\s-]*up|register)\b/i.test(textOf(el)));
    const primary = named || typed || labelled;
    if (!primary) return '';
    primary.setAttribute('data-monkey-submit', '1');
    return textOf(primary) || 'submit';
  }, wanted).catch(() => '');
  if (!picked) return { ok: false, observation: 'No sign-up submit control was found in the form. OAuth buttons were not clicked.' };
  const button = page.locator('[data-monkey-submit="1"]').first();
  await button.click({ timeout: 5_000 });
  return { ok: true, target: picked.slice(0, 80) };
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
