/**
 * Outcome checks.
 *
 * A flow passes only when one of these checks is actually true on the page
 * after the last step. "The steps ran" is not a check. A missing or
 * undecidable check is inconclusive (`no_assertion` / `assertion_unverifiable`).
 */

import type { Page } from 'playwright';
import type { OutcomeCheck, OutcomeCheckKind, TestFlow, TestStep } from '../types.js';

const AUTH_ERROR = /incorrect|not match|wrong password|invalid credentials|invalid (?:email|login|username|user|password)|email or password|couldn'?t (?:sign|log) in|could not (?:sign|log) in|try again|no account|does not exist|doesn't exist|unsuccessful/i;

const KINDS = new Set<OutcomeCheckKind>([
  'text_visible',
  'text_absent',
  'url_changed',
  'url_includes',
  'url_unchanged',
  'element_visible',
  'element_absent',
  'validation_visible',
  'observable_response',
  'auth_error_visible',
  'password_toggle',
  'email_field_present',
  'form_present',
]);

const NEEDS_VALUE = new Set<OutcomeCheckKind>([
  'text_visible',
  'text_absent',
  'url_includes',
  'element_visible',
  'element_absent',
]);

export interface PageSnap {
  url: string;
  /** Visible text plus non-secret field values. Compared, not stored. */
  signal: string;
}

export type CheckVerdict =
  | { state: 'verified'; observation: string }
  | { state: 'failed'; observation: string }
  | { state: 'unverifiable'; observation: string }
  | { state: 'missing'; observation: string };

const VAGUE = /^(the )?(journey|flow|step|page|control|form) (completes|completed|works|worked|succeeds)\.?$/i;

export function isOutcomeCheckKind(value: unknown): value is OutcomeCheckKind {
  return typeof value === 'string' && KINDS.has(value as OutcomeCheckKind);
}

/** True when the runner can decide the check without guessing. */
export function isConcreteOutcomeCheck(check: OutcomeCheck | undefined): check is OutcomeCheck {
  if (!check || !isOutcomeCheckKind(check.kind)) return false;
  if (NEEDS_VALUE.has(check.kind) && !clean(check.value)) return false;
  if (check.also?.some(item => !isConcreteOutcomeCheck(item))) return false;
  return true;
}

export function parseOutcomeCheck(raw: unknown): OutcomeCheck | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const record = raw as Record<string, unknown>;
  if (!isOutcomeCheckKind(record.kind)) return undefined;
  const value = clean(typeof record.value === 'string' ? record.value : undefined);
  const also = Array.isArray(record.also)
    ? record.also.map(parseOutcomeCheck).filter((item): item is OutcomeCheck => Boolean(item))
    : undefined;
  const check: OutcomeCheck = {
    kind: record.kind,
    ...(value ? { value } : {}),
    ...(also && also.length > 0 ? { also } : {}),
  };
  return isConcreteOutcomeCheck(check) ? check : undefined;
}

/**
 * Turn a free-text expectation into a check, or return undefined when the
 * sentence does not name an observable. Callers drop model flows that
 * return undefined so they cannot pass on execution alone.
 */
export function repairOutcomeCheck(flow: {
  expectation?: string;
  outcomeCheck?: OutcomeCheck;
  steps?: Array<Pick<TestStep, 'expectation' | 'action'>>;
}): OutcomeCheck | undefined {
  const explicit = parseOutcomeCheck(flow.outcomeCheck);
  if (explicit) return explicit;
  const text = [
    flow.expectation || '',
    ...(flow.steps ?? []).map(step => `${step.expectation || ''}\n${step.action || ''}`),
  ].join('\n');
  if (!text.trim() || VAGUE.test(text.trim())) return undefined;

  const quoted = [...text.matchAll(/["“]([^"”]{2,80})["”]/g)].map(match => match[1].trim()).filter(Boolean);
  if (quoted[0] && /disappear|no longer|hidden|gone|not (be )?visible/i.test(text)) {
    return { kind: 'text_absent', value: quoted[0] };
  }
  if (quoted[0] && /see|show|visible|appear|display|message|text|reads/i.test(text)) {
    return { kind: 'text_visible', value: quoted[0] };
  }
  const includes = text.match(/\b(?:url|path)\s+(?:includes|contains)\s+["']?([^\s"']+)/i);
  if (includes?.[1]) return { kind: 'url_includes', value: includes[1] };
  if (/validation|invalid email|error message|required field|shows an error|in-page error/i.test(text)) {
    return /stay|does not navigate|remains on|url stays/i.test(text)
      ? { kind: 'validation_visible', also: [{ kind: 'url_unchanged' }] }
      : { kind: 'validation_visible' };
  }
  if (/stay|does not navigate|remains on|url stays/i.test(text)) return { kind: 'url_unchanged' };
  if (/navigat|redirect|url (?:changes|changed|updates)|opens (a|the) page/i.test(text)) return { kind: 'url_changed' };
  if (/\b(loads?|updates?|opens?|submits?|runs?|sent|added|created|entered|accepts?|readable|success|toggles?|checked|browse|without a (?:server |page )?error)\b/i.test(text)) {
    return { kind: 'observable_response' };
  }
  return undefined;
}

/** Attach a repaired check, or undefined when the flow must be dropped. */
export function withRepairedCheck(flow: TestFlow): TestFlow | undefined {
  const outcomeCheck = repairOutcomeCheck(flow);
  if (!outcomeCheck) return undefined;
  return outcomeCheck === flow.outcomeCheck ? flow : { ...flow, outcomeCheck };
}

export async function snapPage(page: Page): Promise<PageSnap> {
  const signal = await page.evaluate(() => {
    const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const fields = Array.from(document.querySelectorAll('input, textarea, select')).map(node => {
      const el = node as HTMLInputElement;
      const type = (el.type || '').toLowerCase();
      const secret = type === 'password' || type === 'hidden';
      const value = secret ? String(el.value || '').length : (el.value || '');
      return `${el.name || el.id || type}:${secret ? 'secret' : 'v'}:${value}`;
    });
    return `${text}\n${fields.join('|')}`;
  }).catch(() => '');
  let url = '';
  try { url = page.url(); } catch { /* page closing */ }
  return { url, signal };
}

export async function evaluateOutcomeCheck(
  page: Page,
  check: OutcomeCheck | undefined,
  ctx: { startUrl: string; before?: PageSnap },
): Promise<CheckVerdict> {
  if (!check) {
    return { state: 'missing', observation: 'This flow has no outcome check, so it cannot pass.' };
  }
  if (!isConcreteOutcomeCheck(check)) {
    return { state: 'unverifiable', observation: 'The outcome check is missing a value, so it was not treated as a pass.' };
  }
  const own = await evaluateOne(page, check, ctx);
  if (own.state !== 'verified') return own;
  for (const extra of check.also ?? []) {
    const next = await evaluateOutcomeCheck(page, extra, ctx);
    if (next.state !== 'verified') return next;
  }
  return own;
}

async function evaluateOne(
  page: Page,
  check: OutcomeCheck,
  ctx: { startUrl: string; before?: PageSnap },
): Promise<CheckVerdict> {
  const now = await snapPage(page);
  switch (check.kind) {
    case 'text_visible':
      return includesText(now.signal, check.value || '')
        ? { state: 'verified', observation: `Saw "${check.value}".` }
        : { state: 'failed', observation: `Expected visible text "${check.value}" and did not see it.` };
    case 'text_absent':
      return includesText(now.signal, check.value || '')
        ? { state: 'failed', observation: `Text "${check.value}" is still visible.` }
        : { state: 'verified', observation: `Text "${check.value}" is not visible.` };
    case 'url_changed':
      return sameUrl(now.url, ctx.startUrl)
        ? { state: 'failed', observation: `The URL stayed ${now.url}.` }
        : { state: 'verified', observation: `The URL changed to ${now.url}.` };
    case 'url_unchanged':
      return sameUrl(now.url, ctx.startUrl)
        ? { state: 'verified', observation: 'The URL stayed on the starting page.' }
        : { state: 'failed', observation: `The URL changed from ${ctx.startUrl} to ${now.url}.` };
    case 'url_includes':
      return now.url.toLowerCase().includes((check.value || '').toLowerCase())
        ? { state: 'verified', observation: `The URL includes "${check.value}".` }
        : { state: 'failed', observation: `The URL ${now.url} does not include "${check.value}".` };
    case 'element_visible':
      return (await countNamed(page, check.value || '')) > 0
        ? { state: 'verified', observation: `"${check.value}" is visible.` }
        : { state: 'failed', observation: `"${check.value}" is not visible.` };
    case 'element_absent':
      return (await countNamed(page, check.value || '')) > 0
        ? { state: 'failed', observation: `"${check.value}" is still on the page.` }
        : { state: 'verified', observation: `"${check.value}" is not on the page.` };
    case 'validation_visible':
      return (await seesValidation(page))
        ? { state: 'verified', observation: 'A validation message is visible.' }
        : { state: 'failed', observation: 'No validation message was shown.' };
    case 'auth_error_visible':
      return AUTH_ERROR.test(now.signal)
        ? { state: 'verified', observation: 'An in-page sign-in error is visible.' }
        : { state: 'failed', observation: 'No in-page sign-in error was shown.' };
    case 'email_field_present':
      return (await page.locator('input[type="email"], input[name*="email" i], input[autocomplete="email"]').count()) > 0
        ? { state: 'verified', observation: 'The page has an email field.' }
        : { state: 'failed', observation: 'The page has no email field.' };
    case 'form_present':
      return (await page.locator('form').count()) > 0
        ? { state: 'verified', observation: 'The page has a form.' }
        : { state: 'failed', observation: 'The page has no form.' };
    case 'password_toggle':
      return passwordToggle(page);
    case 'observable_response':
      return observable(ctx.before, now);
    default:
      return { state: 'unverifiable', observation: 'The outcome check kind is not one this engine evaluates.' };
  }
}

function observable(before: PageSnap | undefined, now: PageSnap): CheckVerdict {
  if (!before) {
    return { state: 'unverifiable', observation: 'There was no before-snapshot, so a change could not be verified.' };
  }
  if (!sameUrl(before.url, now.url)) {
    return { state: 'verified', observation: `The URL changed to ${now.url}.` };
  }
  if (normalise(before.signal) !== normalise(now.signal)) {
    return { state: 'verified', observation: 'The page changed after the last step.' };
  }
  return {
    state: 'unverifiable',
    observation: 'The last step left the URL and the page text unchanged, so the outcome was not verified.',
  };
}

async function passwordToggle(page: Page): Promise<CheckVerdict> {
  const field = page.locator('input[type="password"], input[type="text"][name="password" i], input[autocomplete="current-password"]').first();
  if (await field.count() === 0) {
    return { state: 'verified', observation: 'No password field was on the page. Recorded as info, not a bug.' };
  }
  const toggle = page.locator([
    'button',
    '[role="button"]',
  ].join(', ')).filter({ hasText: /show password|hide password|reveal password|password visibility/i });
  const labelled = page.locator([
    '[aria-label*="password" i]',
    '[data-testid*="password-toggle" i]',
    '[data-testid*="show-password" i]',
  ].join(', '));
  if (await toggle.count() === 0 && await labelled.count() === 0) {
    return { state: 'verified', observation: 'No password visibility toggle was found. Recorded as info, not a bug.' };
  }
  const type = await field.getAttribute('type');
  if (type === 'text') {
    return { state: 'verified', observation: 'The password field is revealed.' };
  }
  return { state: 'failed', observation: 'The password visibility toggle did not reveal the field.' };
}

async function seesValidation(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const controls = Array.from(document.querySelectorAll('input, textarea, select'));
    if (controls.some(el => el.matches(':invalid') || el.getAttribute('aria-invalid') === 'true')) return true;
    const text = (document.body?.innerText || '').slice(0, 4000);
    return /required|invalid|valid email|enter (your |an |a )?email|please (enter|fill|provide)|must not be empty|can(?:not|'t) be empty|this field|do not match|doesn't match|mismatch/i.test(text);
  }).catch(() => false);
}

async function countNamed(page: Page, name: string): Promise<number> {
  const exact = page.getByText(name, { exact: false });
  return exact.count().catch(() => 0);
}

function includesText(signal: string, value: string): boolean {
  return normalise(signal).includes(normalise(value));
}

function normalise(value: string): string {
  return value.replace(/\s+/g, ' ').trim().toLowerCase();
}

function sameUrl(a: string, b: string): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    let path = url.pathname;
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    return `${url.origin}${path}${url.search}`;
  } catch {
    return value;
  }
}

function clean(value: string | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}
