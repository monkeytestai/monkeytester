/**
 * Hard stop for final submits the host did not allow.
 *
 * Sign-up, password reset, OTP / magic-link, newsletter subscribe,
 * checkout/payment, and account deletion are not completed unless the host
 * opts in. An inbox allows OTP, reset, and the one sign-up. Empty
 * validation submits (no value in the email field) still run.
 * Matching POSTs are aborted before they leave the browser.
 */

import type { Page, Route } from 'playwright';

export type SensitiveKind = 'signup' | 'reset' | 'otp' | 'newsletter' | 'payment' | 'deletion';

const RULES: { kind: SensitiveKind; pattern: RegExp }[] = [
  { kind: 'otp', pattern: /\b(send (?:an? )?otp|send code|magic[- ]?link|one[- ]time (?:code|password)|\botp\b)\b/i },
  { kind: 'reset', pattern: /\b(forgot[- ]?password|reset[- ]?password|password reset)\b/i },
  { kind: 'newsletter', pattern: /\b(newsletter|subscribe)\b/i },
  { kind: 'payment', pattern: /\b(checkout|place order|pay now|payment|purchase|add card)\b/i },
  { kind: 'deletion', pattern: /\b(delete account|close account|deactivate account)\b/i },
  { kind: 'signup', pattern: /\b(create(?:\s+an?)?\s+account|sign[\s-]*up|register)\b/i },
];

const OAUTH_HOST = /(?:^|\.)(?:accounts\.google\.com|facebook\.com|github\.com|appleid\.apple\.com|login\.microsoftonline\.com)$/i;

export interface SubmissionPolicy {
  inbox?: boolean;
  /** Kinds the host explicitly allowed, besides what an inbox unlocks. */
  allow?: SensitiveKind[];
  blocked?: string;
}

const policies = new WeakMap<Page, SubmissionPolicy>();

export function sensitiveKindFromText(text: string | undefined): SensitiveKind | undefined {
  const value = text || '';
  for (const rule of RULES) {
    if (rule.pattern.test(value)) return rule.kind;
  }
  return undefined;
}

export function allowsSensitiveSubmit(kind: SensitiveKind, policy: SubmissionPolicy | undefined): boolean {
  if (policy?.allow?.includes(kind)) return true;
  if (policy?.inbox && (kind === 'otp' || kind === 'reset' || kind === 'signup')) return true;
  return false;
}

export function isOauthNavigation(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    if (/\/auth\/(?:google|facebook|github|apple|microsoft|oauth)\b/i.test(`${parsed.pathname}${parsed.search}`)) return true;
    return OAUTH_HOST.test(parsed.hostname);
  } catch {
    return /\/auth\/(?:google|facebook|github|apple|microsoft|oauth)\b/i.test(url);
  }
}

export function submissionPolicy(page: Page): SubmissionPolicy | undefined {
  return policies.get(page);
}

/** Abort sensitive POSTs and navigations to an OAuth provider. */
export async function installSubmissionGuards(page: Page, policy: SubmissionPolicy): Promise<void> {
  policies.set(page, policy);
  await page.route('**/*', async (route: Route) => {
    const request = route.request();
    const url = request.url();
    if (request.isNavigationRequest() && isOauthNavigation(url)) {
      policy.blocked = `oauth ${url}`;
      await route.abort('blockedbyclient').catch(() => {});
      return;
    }
    if (request.method() === 'POST') {
      const body = request.postData();
      const kind = sensitiveKindFromText(`${url}\n${body || ''}`);
      const validation = kind ? isValidationPayload(body || '', kind) : false;
      const payload = kind === 'payment' || kind === 'deletion' || (Boolean(kind) && submissionHasPayload(body) && !validation);
      if (kind && payload && !allowsSensitiveSubmit(kind, policy)) {
        policy.blocked = `${kind} ${url}`;
        await route.abort('blockedbyclient').catch(() => {});
        return;
      }
    }
    await route.continue().catch(() => {});
  });
}

/**
 * Refuse a click that would finish a sensitive form. Empty validation
 * (no email value yet) is allowed. Returns an observation when blocked.
 */
export async function blockSensitiveClick(
  page: Page,
  actionText: string,
  control?: { tag?: string; inForm?: boolean },
): Promise<string | undefined> {
  const kind = sensitiveKindFromText(actionText);
  if (!kind) return undefined;
  const policy = policies.get(page);
  if (allowsSensitiveSubmit(kind, policy)) return undefined;
  // A link to the checkout page is not the payment submit.
  if ((kind === 'payment' || kind === 'deletion') && control?.tag === 'a' && !control.inForm) return undefined;
  if (kind !== 'payment' && kind !== 'deletion') {
    const filled = await page.evaluate(() => {
      const fields = Array.from(document.querySelectorAll('input, textarea')) as HTMLInputElement[];
      const values = fields.filter(el => {
        const type = (el.type || '').toLowerCase();
        if (type === 'hidden' || type === 'submit' || type === 'button') return false;
        return Boolean((el.value || '').trim());
      });
      if (values.some(el => /not-an-email/i.test(el.value || ''))) return false;
      const passwords = values.filter(el => (el.type || '').toLowerCase() === 'password').map(el => el.value);
      if (passwords.length >= 2 && new Set(passwords).size > 1) return false;
      return values.some(el => (el.type || '').toLowerCase() !== 'password');
    }).catch(() => false);
    if (!filled) return undefined;
  }
  return `Refused to submit a ${kind} form. Without an explicit allow (an inbox for OTP or password reset), only validation is run.`;
}

/**
 * Invalid-email and password-mismatch bodies are validation, not a completed
 * account, reset, or OTP. Payment and deletion are never validation.
 */
function isValidationPayload(body: string, kind: SensitiveKind): boolean {
  if (kind === 'payment' || kind === 'deletion') return false;
  if (/not-an-email/i.test(body)) return true;
  if (/not-a-real-password/.test(body) && /different-password/.test(body)) return true;
  return false;
}

/** True when a POST body carries a filled value, not an empty validation submit. */
export function submissionHasPayload(body: string | null | undefined): boolean {
  if (!body || !body.trim()) return false;
  let text = body;
  try { text = decodeURIComponent(body.replace(/\+/g, ' ')); } catch { /* keep the raw body */ }
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return true;
  if (/\b(?:\d[ -]?){13,19}\b/.test(text)) return true;
  const values: string[] = [];
  for (const part of text.split('&')) {
    const eq = part.indexOf('=');
    if (eq >= 0) values.push(part.slice(eq + 1).trim());
  }
  for (const match of text.matchAll(/:\s*"([^"]*)"/g)) values.push(match[1].trim());
  return values.some(value => value.length > 0 && !/^(on|true|false|0|1|yes|no)$/i.test(value));
}

/**
 * A model flow that would finish a sensitive form. Empty and invalid
 * validation stays. Sign-up is handled by `plansCompleteSignup`.
 */
export function plansDisallowedSensitiveSubmit(
  flow: { name: string; description: string; steps: Array<{ action: string; value?: string }> },
  policy?: SubmissionPolicy,
): boolean {
  const text = [flow.name, flow.description, ...flow.steps.map(step => `${step.action} ${step.value || ''}`)].join('\n');
  const kind = sensitiveKindFromText(text);
  if (!kind || kind === 'signup') return false;
  if (allowsSensitiveSubmit(kind, policy)) return false;
  const submits = /\b(submit|click|press|send)\b/i.test(text);
  if (!submits) return false;
  if (kind === 'payment' || kind === 'deletion') return true;
  if (/without filling|leave .{0,40}empty|do not submit|don't submit|invalid|not-an-email|empty submit/i.test(text)
    && !/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) {
    return false;
  }
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
}

const intents = new WeakMap<Page, string>();
const CONFIRM_INTENT = /\b(confirm|yes|okay|\bok\b|accept|proceed|agree|delete)\b/i;

/** Remaining step text, so a confirm the flow asked for is accepted. */
export function setStepIntent(page: Page, text: string): void {
  intents.set(page, text);
}

/**
 * Accept a confirm only when the current steps ask for it. Anything else is
 * dismissed, and a dialog the flow named is not dismissed.
 */
export function installDialogPolicy(page: Page): void {
  page.on('dialog', async dialog => {
    const intent = intents.get(page) || '';
    const message = (dialog.message() || '').trim();
    const named = message.length > 0 && intent.toLowerCase().includes(message.toLowerCase().slice(0, 40));
    if (CONFIRM_INTENT.test(intent) || named) {
      await dialog.accept().catch(() => {});
      return;
    }
    await dialog.dismiss().catch(() => {});
  });
}
