/**
 * Hard stop for final submits the host did not allow.
 *
 * Sign-up, password reset, OTP / magic-link, newsletter subscribe,
 * checkout/payment, and account deletion are not completed unless the host
 * opts in. An inbox allows OTP, reset, and the one sign-up. Empty
 * validation submits (no value in the email field) still run.
 * Contact, enquiry, feedback, support, quote, and get-in-touch message
 * forms are never submitted. There is no allow flag for them. An empty
 * click can still show client-side validation, but the POST is aborted.
 * Same-origin (or form-action) POST/PUT/PATCH submits are aborted before
 * they leave the browser. Analytics beacons are not submits.
 */

import type { Locator, Page, Route } from 'playwright';

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
  /**
   * The click we are about to run is a contact submit with no user-filled
   * values. Hidden fields do not count. Cleared after the action.
   */
  contactEmpty?: boolean;
}

const policies = new WeakMap<Page, SubmissionPolicy>();
const formActions = new WeakMap<Page, string[]>();
/** Action URLs of forms classified as contact, enquiry, feedback, or quote. */
const contactActions = new WeakMap<Page, string[]>();

/**
 * Machine code for a flow that would have sent a contact, enquiry, feedback,
 * support, quote, or get-in-touch message. Additive. Never a pass, never a bug.
 */
export const CONTACT_SUBMIT_BLOCKED = 'contact_submit_blocked';

const CONTACT_FIELD = /(?:^|[^a-z0-9])(messages?|enquiries|enquiry|inquiries|inquiry|subjects?|comments?|feedback)(?:[^a-z0-9]|$)/i;
const CONTACT_BUTTON = /\b(send(?:\s+us)?(?:\s+an?)?\s+message|submit(?:\s+an?)?\s+enquir(?:y|ies)|submit(?:\s+an?)?\s+inquir(?:y|ies)|contact\s+us|get\s+in\s+touch|request(?:\s+a)?\s+quote|get(?:\s+a)?\s+quote|submit\s+feedback|send\s+feedback|leave(?:\s+an?)?\s+(?:message|feedback|comment)|write\s+to\s+us)\b/i;
const CONTACT_INTENT = /\b(contact(?:\s+us|\s+form)|enquir(?:y|ies)|inquir(?:y|ies)|feedback|get\s+in\s+touch|request(?:\s+a)?\s+quote|quotes?\s+form|send(?:\s+us)?(?:\s+a)?\s+message|support\s+form|leave(?:\s+a)?\s+(?:message|feedback)|write\s+to\s+us)\b/i;
const CONTACT_SEGMENT = /(?:^|\/)(contact(?:[-_]us)?|contacts|enquiries|enquiry|inquiries|inquiry|feedback|quotes?|get-in-touch|getintouch|support)(?:\/|$)/i;
const VALIDATION_PLAN = /without filling|leave .{0,60}empty|do not submit|don't submit|invalid|empty submit|validation only|do not send|don't send/i;

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/** Hosts and paths that carry analytics, RUM, and keepalive beacons. */
const ANALYTICS_HOST_SUFFIXES = [
  'clarity.ms',
  'google-analytics.com',
  'analytics.google.com',
  'googletagmanager.com',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'hotjar.com',
  'hotjar.io',
  'plausible.io',
  'posthog.com',
  'doubleclick.net',
  'googleadservices.com',
  'googlesyndication.com',
  'fullstory.com',
  'amplitude.com',
  'heapanalytics.com',
  'nr-data.net',
  'mouseflow.com',
  'contentsquare.net',
  'omtrdc.net',
  '2o7.net',
  'demdex.net',
];

const BEACON_RESOURCE = new Set(['ping', 'beacon', 'image', 'script', 'stylesheet', 'font', 'media', 'manifest', 'texttrack', 'eventsource', 'websocket', 'other']);

export interface SubmissionScan {
  url: string;
  method: string;
  resourceType?: string;
  pageUrl?: string;
  formActionUrls?: string[];
  headers?: Record<string, string>;
}

function hostIs(hostname: string, suffix: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const needle = suffix.toLowerCase();
  return host === needle || host.endsWith(`.${needle}`);
}

/** True for known analytics, RUM, and ingest URLs, including `/cdn-cgi/rum`. */
export function isAnalyticsBeaconUrl(url: string): boolean {
  let parsed: URL;
  try { parsed = new URL(url); }
  catch { return /clarity\.ms|google-analytics|googletagmanager|cdn-cgi\/rum|segment\.(io|com)|mixpanel|hotjar|plausible\.io|posthog|ingest(?:\.[a-z0-9-]+)?\.sentry\.io|\/__l5e\/trackevents/i.test(url); }
  const host = parsed.hostname;
  const path = parsed.pathname.toLowerCase();
  if (path.includes('/cdn-cgi/rum') || path.includes('/cdn-cgi/beacon')) return true;
  if (/^\/__l5e\/trackevents\/?$/.test(path)) return true;
  if (/(^|\.)ingest(?:\.[a-z0-9-]+)?\.sentry\.io$/i.test(host)) return true;
  return ANALYTICS_HOST_SUFFIXES.some(suffix => hostIs(host, suffix));
}

function header(headers: Record<string, string> | undefined, name: string): string {
  if (!headers) return '';
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value.toLowerCase();
  }
  return '';
}

function isSendBeaconOrKeepalive(scan: SubmissionScan): boolean {
  const type = (scan.resourceType || '').toLowerCase();
  if (type === 'ping' || type === 'beacon') return true;
  const mode = header(scan.headers, 'sec-fetch-mode');
  const dest = header(scan.headers, 'sec-fetch-dest');
  return mode === 'no-cors' && (dest === 'empty' || dest === '');
}

function sameOrigin(url: string, pageUrl: string | undefined): boolean {
  if (!pageUrl) return false;
  try { return new URL(url).origin === new URL(pageUrl).origin; }
  catch { return false; }
}

function normalisePath(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

export interface ContactSignals {
  actionUrl?: string;
  pageUrl?: string;
  button?: string;
  /** Field names, labels, placeholders, and types joined together. */
  fields?: string;
  /** Planner step text and the click instruction. */
  intent?: string;
  method?: string;
  inForm?: boolean;
  tag?: string;
}

interface DomForm {
  action: string;
  method: string;
  fields: string;
  button: string;
  pageUrl: string;
  inForm: boolean;
  tag: string;
}

/** Pathname of a contact, enquiry, feedback, support, quote, or get-in-touch URL. */
export function contactActionPath(url: string | undefined): boolean {
  if (!url) return false;
  let path = url;
  try { path = new URL(url, 'https://form.invalid').pathname; }
  catch { /* keep the raw text so a path fragment in a plan still matches */ }
  if (/\/search(?:\/|$)/i.test(path)) return false;
  return CONTACT_SEGMENT.test(path);
}

function isSearchSignals(signals: ContactSignals): boolean {
  const fields = signals.fields || '';
  const button = signals.button || '';
  const action = signals.actionUrl || '';
  if (CONTACT_FIELD.test(fields) || CONTACT_BUTTON.test(button)) return false;
  if (/\/search(?:\/|$)/i.test(action)) return true;
  if (/(?:^|[^a-z0-9])(q|query|search)(?:[^a-z0-9]|$)/i.test(fields)) return true;
  if (/\btype(?:=|\s)\s*search\b/i.test(fields)) return true;
  if (/^search$/i.test(button.trim())) return true;
  return false;
}

function hasPasswordField(fields: string | undefined): boolean {
  const value = fields || '';
  return /(?:^|[^a-z0-9])password(?:[^a-z0-9]|$)/i.test(value) || /\btype(?:=|\s)\s*password\b/i.test(value);
}

function isNewsletterOnly(signals: ContactSignals): boolean {
  const blob = `${signals.button || ''}\n${signals.fields || ''}\n${signals.actionUrl || ''}`;
  if (!/\b(newsletter|subscribe)\b/i.test(blob)) return false;
  if (CONTACT_FIELD.test(signals.fields || '') || CONTACT_BUTTON.test(signals.button || '')) return false;
  if (contactActionPath(signals.actionUrl)) return false;
  return true;
}

/**
 * A contact, enquiry, feedback, support, quote, or get-in-touch form.
 * Search boxes, password forms, and newsletter-only forms are not contact forms.
 * A link that only opens the page is not a submit.
 */
export function isContactSubmit(signals: ContactSignals): boolean {
  if (hasPasswordField(signals.fields)) return false;
  if (isSearchSignals(signals)) return false;
  if (isNewsletterOnly(signals)) return false;
  if (signals.inForm === false) return false;
  const fields = signals.fields || '';
  const button = signals.button || '';
  const intent = signals.intent || '';
  if (CONTACT_FIELD.test(fields)) return true;
  if (contactActionPath(signals.actionUrl)) return true;
  if (CONTACT_BUTTON.test(button)) return true;
  if (signals.inForm && contactActionPath(signals.pageUrl)) return true;
  if (signals.inForm && CONTACT_INTENT.test(intent) && /\b(submit|send)\b/i.test(intent)) return true;
  return false;
}

function fieldNamesFromBody(body: string | null | undefined): string {
  if (!body) return '';
  let source = body;
  try { source = decodeURIComponent(body.replace(/\+/g, ' ')); }
  catch { source = body; }
  const names: string[] = [];
  const trimmed = source.trim();
  if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && /"([^"\\]{1,80})"\s*:/.test(source)) {
    for (const match of source.matchAll(/"([^"\\]{1,80})"\s*:/g)) names.push(match[1]);
  } else if (source.includes('=')) {
    for (const part of source.split('&')) {
      const eq = part.indexOf('=');
      const key = (eq >= 0 ? part.slice(0, eq) : '').trim();
      if (key) names.push(key);
    }
  }
  for (const match of source.matchAll(/\bname="([^"]{1,80})"/gi)) names.push(match[1]);
  return names.join('\n');
}

/**
 * A user-form POST that would deliver a contact message.
 * Analytics URLs are ignored. Search field names are ignored.
 * Known contact form actions are included even when the path is generic.
 */
export function isContactRequest(input: {
  url: string;
  body?: string | null;
  contactActionUrls?: string[];
}): boolean {
  if (isAnalyticsBeaconUrl(input.url)) return false;
  if (/\/search(?:\/|$)/i.test(input.url)) return false;
  if (contactActionPath(input.url)) return true;
  const names = fieldNamesFromBody(input.body).split('\n').map(name => name.trim()).filter(Boolean);
  const contactName = names.some(name => CONTACT_FIELD.test(name) && !/^(q|query|search)$/i.test(name));
  if (contactName) return true;
  if (matchesFormAction(input.url, input.contactActionUrls)) return true;
  return false;
}

export function contactBlockObservation(detail: string): string {
  return `${detail} The message was not sent. The outcome is inconclusive (${CONTACT_SUBMIT_BLOCKED}).`;
}

/**
 * Evidence for an empty contact submit that produced no client-side
 * validation. The request was aborted, so this is a site bug, not a block.
 */
export const EMPTY_CONTACT_VALIDATION =
  'Empty contact form was submitted with no client-side validation (request blocked by monkeytester; nothing sent).';

/** The flow or step is checking that an empty submit shows a validation message. */
export function expectsValidationMessage(text: string | undefined): boolean {
  const value = text || '';
  if (/\bvalidation_visible\b/.test(value)) return true;
  return /\b(validation(?:\s+message|\s+error)?|required(?:\s+field)?|client-side validation|shows an error|error message)\b/i.test(value);
}

export interface ContactAbortOutcome {
  status: 'failed' | 'skipped';
  observation: string;
  error: 'missing-validation' | 'sensitive-submit';
}

/**
 * Turn a contact abort into a step outcome.
 * An empty submit that expected a validation message is a failure: the
 * request leaving the browser means the page did not validate first.
 * Any other contact abort stays inconclusive.
 */
export function contactAbortOutcome(page: Page, prior?: string): ContactAbortOutcome | undefined {
  const policy = policies.get(page);
  const fresh = policy?.blocked && policy.blocked !== prior ? policy.blocked : undefined;
  if (policy) policy.contactEmpty = undefined;
  if (!fresh) return undefined;
  if (fresh.startsWith('contact-empty ')) {
    if (expectsValidationMessage(intents.get(page))) {
      return {
        status: 'failed',
        observation: EMPTY_CONTACT_VALIDATION,
        error: 'missing-validation',
      };
    }
    return {
      status: 'skipped',
      observation: contactBlockObservation(`Blocked ${fresh}.`),
      error: 'sensitive-submit',
    };
  }
  if (fresh.startsWith('contact ')) {
    return {
      status: 'skipped',
      observation: contactBlockObservation(`Blocked ${fresh}.`),
      error: 'sensitive-submit',
    };
  }
  return undefined;
}

/** A step the runner skipped because a contact message would have been sent. */
export function isContactSubmitBlock(step: { error?: string; observation?: string }): boolean {
  if (step.error !== 'sensitive-submit') return false;
  const text = step.observation || '';
  return text.includes(CONTACT_SUBMIT_BLOCKED)
    || /refused to submit a contact form/i.test(text)
    || /\bblocked contact\b/i.test(text);
}

function plansContactMessage(text: string): boolean {
  if (VALIDATION_PLAN.test(text)) return false;
  const send = /\b(submit|send)\b/i.test(text);
  if (!send) return false;
  if (/\bsearch\b/i.test(text) && !CONTACT_FIELD.test(text) && !CONTACT_BUTTON.test(text) && !contactActionPath(text)) {
    return false;
  }
  return CONTACT_FIELD.test(text) || CONTACT_BUTTON.test(text) || contactActionPath(text) || CONTACT_INTENT.test(text);
}

function matchesFormAction(url: string, actions: string[] | undefined): boolean {
  if (!actions?.length) return false;
  let target: URL;
  try { target = new URL(url); }
  catch { return false; }
  for (const action of actions) {
    let parsed: URL;
    try { parsed = new URL(action); }
    catch { continue; }
    if (parsed.origin !== target.origin) continue;
    if (normalisePath(parsed.pathname) !== normalisePath(target.pathname)) continue;
    if (parsed.search && parsed.search !== target.search) continue;
    return true;
  }
  return false;
}

/**
 * Sensitive classification applies only to a form or user submit:
 * POST, PUT, or PATCH, same-origin or the form's action URL.
 * sendBeacon, keepalive, and analytics hosts are ignored.
 */
export function isUserFormSubmission(scan: SubmissionScan): boolean {
  const method = (scan.method || '').toUpperCase();
  if (!WRITE_METHODS.has(method)) return false;
  if (isAnalyticsBeaconUrl(scan.url)) return false;
  if (isSendBeaconOrKeepalive(scan)) return false;
  if (matchesFormAction(scan.url, scan.formActionUrls)) return true;
  if (!sameOrigin(scan.url, scan.pageUrl)) return false;
  const type = (scan.resourceType || '').toLowerCase();
  if (type && BEACON_RESOURCE.has(type)) return false;
  return true;
}

/** Read form actions outside a route handler. `page.evaluate` inside a route can deadlock. */
export async function refreshFormActions(page: Page): Promise<void> {
  const forms = await page.evaluate(() => {
    return Array.from(document.forms).map(form => {
      const fields = Array.from(form.querySelectorAll('input, textarea, select')).map(input => {
        const control = input as HTMLInputElement;
        const labelled = control.labels && control.labels[0] ? control.labels[0].innerText : '';
        return [
          input.getAttribute('name') || '',
          input.id || '',
          input.getAttribute('type') || input.tagName,
          labelled,
          input.getAttribute('placeholder') || '',
          input.getAttribute('aria-label') || '',
        ].join(' ');
      }).join('\n');
      const button = Array.from(form.querySelectorAll('button, input[type="submit"], [role="button"]')).map(control => (
        (control as HTMLElement).innerText || (control as HTMLInputElement).value || control.getAttribute('aria-label') || ''
      )).join('\n');
      return {
        action: form.action || '',
        method: form.method || 'get',
        fields,
        button,
        pageUrl: location.href,
      };
    });
  }).catch(() => [] as Array<{ action: string; method: string; fields: string; button: string; pageUrl: string }>);
  formActions.set(page, forms.map(form => form.action).filter(action => /^https?:/i.test(action)));
  contactActions.set(page, forms.filter(form => isContactSubmit({
    actionUrl: form.action,
    pageUrl: form.pageUrl,
    button: form.button,
    fields: form.fields,
    method: form.method,
    inForm: true,
  })).map(form => form.action).filter(action => /^https?:/i.test(action)));
}

function pageUrlOf(page: Page): string {
  try { return page.url(); }
  catch { return ''; }
}

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

const submissionInstalled = new WeakSet<Page>();

/**
 * Abort this request when it is an OAuth navigation or a disallowed submit.
 * Returns true when the route was aborted. The caller keeps every other
 * request inside the auth fence. Do not `continue()` past that fence.
 */
export async function blockSensitiveRequest(route: Route, page: Page): Promise<boolean> {
  const policy = policies.get(page);
  if (!policy) return false;
  const request = route.request();
  const url = request.url();
  if (request.isNavigationRequest() && isOauthNavigation(url)) {
    policy.blocked = `oauth ${url}`;
    await route.abort('blockedbyclient').catch(() => {});
    return true;
  }
  const scan: SubmissionScan = {
    url,
    method: request.method(),
    resourceType: request.resourceType(),
    pageUrl: pageUrlOf(page),
    formActionUrls: formActions.get(page),
    headers: request.headers(),
  };
  if (!isUserFormSubmission(scan)) return false;
  const body = request.postData();
  if (isContactRequest({
    url,
    body,
    contactActionUrls: contactActions.get(page),
  })) {
    const empty = policy.contactEmpty === true || !submissionHasPayload(body);
    policy.blocked = empty ? `contact-empty ${url}` : `contact ${url}`;
    await route.abort('blockedbyclient').catch(() => {});
    return true;
  }
  const kind = sensitiveKindFromText(`${url}\n${body || ''}`);
  const validation = kind ? isValidationPayload(body || '', kind) : false;
  const payload = kind === 'payment' || kind === 'deletion' || (Boolean(kind) && submissionHasPayload(body) && !validation);
  if (kind && payload && !allowsSensitiveSubmit(kind, policy)) {
    policy.blocked = `${kind} ${url}`;
    await route.abort('blockedbyclient').catch(() => {});
    return true;
  }
  return false;
}

/** Abort sensitive form writes and navigations to an OAuth provider. */
export async function installSubmissionGuards(page: Page, policy: SubmissionPolicy): Promise<void> {
  policies.set(page, policy);
  if (submissionInstalled.has(page)) return;
  submissionInstalled.add(page);
  page.on('domcontentloaded', () => { void refreshFormActions(page); });
  await page.route('**/*', async (route: Route) => {
    if (await blockSensitiveRequest(route, page)) return;
    // fallback() reaches the context fence when one is installed. On a
    // signed-in page the fence replaces fallback/continue so this cannot
    // send an off-origin request.
    await route.fallback().catch(async () => {
      await route.abort('blockedbyclient').catch(() => {});
    });
  });
}

/**
 * Refuse a click that would finish a sensitive form. Empty validation
 * (no email value yet) is allowed. Returns an observation when blocked.
 */
export async function blockSensitiveClick(
  page: Page,
  actionText: string,
  control?: { tag?: string; inForm?: boolean; text?: string; locator?: Locator },
): Promise<string | undefined> {
  const contact = await contactClickRefusal(page, actionText, control);
  if (contact) return contact;
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

async function contactClickRefusal(
  page: Page,
  actionText: string,
  control?: { tag?: string; inForm?: boolean; text?: string; locator?: Locator },
): Promise<string | undefined> {
  const signals = await contactSignalsFor(page, actionText, control);
  if (!isContactSubmit(signals)) return undefined;
  const filled = await controlFormFilled(page, control?.locator);
  if (!filled) {
    const policy = policies.get(page);
    if (policy) policy.contactEmpty = true;
    return undefined;
  }
  return contactBlockObservation('Refused to submit a contact form.');
}

async function contactSignalsFor(
  page: Page,
  actionText: string,
  control?: { tag?: string; inForm?: boolean; text?: string; locator?: Locator },
): Promise<ContactSignals> {
  const intent = `${intents.get(page) || ''}\n${actionText}`;
  const dom = await readControlForm(page, control?.locator);
  return {
    actionUrl: dom?.action,
    pageUrl: dom?.pageUrl || pageUrlOf(page),
    button: [dom?.button, control?.text, actionText].filter(Boolean).join('\n'),
    fields: dom?.fields,
    intent,
    method: dom?.method,
    inForm: dom ? dom.inForm : control?.inForm,
    tag: dom?.tag || control?.tag,
  };
}

async function readControlForm(page: Page, locator?: Locator): Promise<DomForm | undefined> {
  const read = (el: Element | null) => {
    const node = el as (Element & { closest?: (selector: string) => Element | null }) | null;
    const form = node && typeof node.closest === 'function' ? node.closest('form') : null;
    const tag = node && node.tagName ? node.tagName.toLowerCase() : '';
    const pageUrl = location.href;
    if (!form) {
      return { action: '', method: '', fields: '', button: '', pageUrl, inForm: false, tag };
    }
    const fields = Array.from(form.querySelectorAll('input, textarea, select')).map(input => {
      const labelled = (input as HTMLInputElement).labels && (input as HTMLInputElement).labels?.[0]
        ? ((input as HTMLInputElement).labels?.[0]?.innerText || '')
        : '';
      return [
        input.getAttribute('name') || '',
        input.id || '',
        input.getAttribute('type') || input.tagName,
        labelled,
        input.getAttribute('placeholder') || '',
        input.getAttribute('aria-label') || '',
      ].join(' ');
    }).join('\n');
    const button = Array.from(form.querySelectorAll('button, input[type="submit"], [role="button"]')).map(control => (
      (control as HTMLElement).innerText || (control as HTMLInputElement).value || control.getAttribute('aria-label') || ''
    )).join('\n');
    return {
      action: (form as HTMLFormElement).action || '',
      method: (form as HTMLFormElement).method || 'get',
      fields,
      button,
      pageUrl,
      inForm: true,
      tag,
    };
  };
  if (locator) return locator.evaluate(read).catch(() => undefined);
  return page.evaluate(() => {
    const active = document.activeElement;
    const node = active as Element | null;
    const form = node && typeof node.closest === 'function' ? node.closest('form') : null;
    const tag = node && node.tagName ? node.tagName.toLowerCase() : '';
    const pageUrl = location.href;
    if (!form) return { action: '', method: '', fields: '', button: '', pageUrl, inForm: false, tag };
    const fields = Array.from(form.querySelectorAll('input, textarea, select')).map(input => {
      const labelled = (input as HTMLInputElement).labels && (input as HTMLInputElement).labels?.[0]
        ? ((input as HTMLInputElement).labels?.[0]?.innerText || '')
        : '';
      return [
        input.getAttribute('name') || '',
        input.id || '',
        input.getAttribute('type') || input.tagName,
        labelled,
        input.getAttribute('placeholder') || '',
        input.getAttribute('aria-label') || '',
      ].join(' ');
    }).join('\n');
    const button = Array.from(form.querySelectorAll('button, input[type="submit"], [role="button"]')).map(control => (
      (control as HTMLElement).innerText || (control as HTMLInputElement).value || control.getAttribute('aria-label') || ''
    )).join('\n');
    return {
      action: (form as HTMLFormElement).action || '',
      method: (form as HTMLFormElement).method || 'get',
      fields,
      button,
      pageUrl,
      inForm: true,
      tag,
    };
  }).catch(() => undefined);
}

async function controlFormFilled(page: Page, locator?: Locator): Promise<boolean> {
  const read = (el: Element | null) => {
    const node = el as Element | null;
    const form = node && typeof node.closest === 'function' ? node.closest('form') : null;
    const root: ParentNode = form || document;
    const fields = Array.from(root.querySelectorAll('input, textarea, select')) as HTMLInputElement[];
    const values = fields.filter(input => {
      const type = (input.type || '').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return false;
      return Boolean((input.value || '').trim());
    });
    if (values.some(input => /not-an-email/i.test(input.value || ''))) return false;
    const passwords = values.filter(input => (input.type || '').toLowerCase() === 'password').map(input => input.value);
    if (passwords.length >= 2 && new Set(passwords).size > 1) return false;
    return values.some(input => (input.type || '').toLowerCase() !== 'password');
  };
  if (locator) return locator.evaluate(read).catch(() => false);
  return page.evaluate(() => {
    const active = document.activeElement;
    const form = active && typeof (active as Element).closest === 'function' ? (active as Element).closest('form') : null;
    const root: ParentNode = form || document;
    const fields = Array.from(root.querySelectorAll('input, textarea, select')) as HTMLInputElement[];
    const values = fields.filter(input => {
      const type = (input.type || '').toLowerCase();
      if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'image' || type === 'reset') return false;
      return Boolean((input.value || '').trim());
    });
    if (values.some(input => /not-an-email/i.test(input.value || ''))) return false;
    const passwords = values.filter(input => (input.type || '').toLowerCase() === 'password').map(input => input.value);
    if (passwords.length >= 2 && new Set(passwords).size > 1) return false;
    return values.some(input => (input.type || '').toLowerCase() !== 'password');
  }).catch(() => false);
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
  if (plansContactMessage(text)) return true;
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
