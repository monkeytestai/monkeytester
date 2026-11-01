/**
 * Heuristics for sign-up / account-creation forms.
 *
 * A login form (one password, "Sign in") is not a sign-up form.
 * Password plus a confirm field, a create-account submit label, or a
 * signup/register URL is.
 */

import type { SiteMapFormInput, SiteMapPage } from '../types.js';

export const SIGNUP_URL = /(?:^|[/?#=&._-])(?:sign[-_]?up|register|create[-_]?account|createaccount)(?=$|[/?#=&._-])/i;
export const SIGNUP_SUBMIT = /\b(create(?:\s+an?)?\s+account|sign[\s-]*up|signup|register)\b/i;
export const LOGIN_SUBMIT = /\b(sign[\s-]*in|log[\s-]*in|login)\b/i;
export const OAUTH_LABEL = /\b(?:continue with|sign[\s-]*in with|sign[\s-]*up with|log[\s-]*in with|use)\s+(?:google|facebook|github|apple|microsoft)\b|\b(?:continue with|sign in with|log in with|sign up with|signup with)\b|\boauth\b|\/auth\/(?:google|facebook|github|apple|microsoft)\b/i;
const CONFIRM = /confirm|repeat|retype|again|password2|password_confirmation|passwd2/;
const CAPTCHA = /captcha|recaptcha|hcaptcha|turnstile/i;
const PHONE = /\b(phone|mobile)\b/i;
const PAYMENT = /card number|credit card|debit card|\bcvv\b|\bcvc\b|payment|billing/i;

export const SIGNUP_IDENTITY_NAME = 'MonkeyTest QA';
export const INVALID_SIGNUP_EMAIL = 'not-an-email';
export const MISMATCH_SIGNUP_EMAIL = 'mismatch@example.com';

export interface SignupField {
  type?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  id?: string;
  required?: boolean;
  value?: string;
  /** Set false by the probe for hidden, disabled, or off-screen controls. */
  interactable?: boolean;
}

export interface SignupSurface {
  url?: string;
  submitLabels: string[];
  email?: SignupField;
  password?: SignupField;
  confirm?: SignupField;
  name?: SignupField;
  blocked?: 'captcha' | 'phone' | 'payment';
}

export interface SignupProbe extends SignupSurface {
  isSignup: boolean;
  /** A complete, syntactically valid account form. Must not be submitted without an inbox. */
  completeValid: boolean;
}

export function fieldBlob(field: SignupField): string {
  return `${field.type || ''} ${field.name || ''} ${field.label || ''} ${field.placeholder || ''} ${field.id || ''}`.toLowerCase();
}

export function isEmailField(field: SignupField): boolean {
  const type = (field.type || '').toLowerCase();
  if (type === 'password' || type === 'hidden') return false;
  return type === 'email' || /\bemail\b/.test(fieldBlob(field));
}

export function isPasswordField(field: SignupField): boolean {
  if (field.interactable === false) return false;
  const type = (field.type || '').toLowerCase();
  if (type === 'hidden') return false;
  return type === 'password' || (field.name || '').toLowerCase() === 'password';
}

export function isConfirmField(field: SignupField): boolean {
  if (field.interactable === false) return false;
  if ((field.type || '').toLowerCase() === 'hidden') return false;
  if (!isPasswordField(field) && !/password/.test(fieldBlob(field))) return false;
  return CONFIRM.test(fieldBlob(field));
}

export function isNameField(field: SignupField): boolean {
  if (isEmailField(field) || isPasswordField(field)) return false;
  return /\b(full name|your name|first name|last name|name)\b/.test(fieldBlob(field));
}

export function isPhoneField(field: SignupField): boolean {
  const type = (field.type || '').toLowerCase();
  return type === 'tel' || PHONE.test(fieldBlob(field));
}

export function isPaymentField(field: SignupField): boolean {
  return PAYMENT.test(fieldBlob(field));
}

export function isCaptchaField(field: SignupField): boolean {
  return CAPTCHA.test(fieldBlob(field));
}

export function syntacticEmail(value: string | undefined): boolean {
  return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()));
}

export function classifySignup(url: string | undefined, fields: SignupField[], submitLabels: string[]): SignupProbe {
  const visibleFields = fields.filter(field => field.interactable !== false && (field.type || '').toLowerCase() !== 'hidden');
  const submits = submitLabels
    .map(label => label.trim())
    .filter(label => label && !OAUTH_LABEL.test(label));
  fields = visibleFields;
  const urlHit = Boolean(url && SIGNUP_URL.test(url));
  const submitHit = submits.some(label => SIGNUP_SUBMIT.test(label) && !OAUTH_LABEL.test(label) && !LOGIN_SUBMIT.test(label));
  const passwords = fields.filter(isPasswordField);
  const confirm = fields.find(isConfirmField) || (passwords.length >= 2 ? passwords[1] : undefined);
  const password = passwords.find(field => field !== confirm) || passwords[0];
  const pair = Boolean(confirm && password && confirm !== password);
  const loginOnly = submits.some(label => LOGIN_SUBMIT.test(label)) && !urlHit && !submitHit && !pair;
  const isSignup = !loginOnly && (urlHit || submitHit || pair);
  const blocked = fields.some(isCaptchaField)
    ? 'captcha' as const
    : fields.some(isPhoneField)
      ? 'phone' as const
      : fields.some(isPaymentField)
        ? 'payment' as const
        : undefined;
  const email = fields.find(isEmailField);
  const name = fields.find(isNameField);
  const emailOk = email ? syntacticEmail(email.value) : true;
  const secretOk = password ? Boolean(password.value && password.value.length > 0) : true;
  const confirmOk = !confirm || confirm.value === password?.value;
  const requiredOk = fields.filter(field => field.required).every(field => Boolean(field.value && field.value.trim()));
  const identityOk = email ? emailOk : secretOk;
  const completeValid = isSignup && !blocked && emailOk && secretOk && confirmOk && requiredOk && identityOk;

  return {
    url,
    submitLabels: submits,
    email,
    password,
    confirm,
    name,
    blocked,
    isSignup,
    completeValid,
  };
}

export function inputsOf(page: Pick<SiteMapPage, 'forms' | 'inputs'>): SiteMapFormInput[] {
  if (page.inputs && page.inputs.length > 0) return page.inputs;
  return (page.forms ?? []).flatMap(form => form.inputs ?? form.fields.map(token => ({ name: token, type: guessType(token) })));
}

function guessType(token: string): string {
  if (/password/i.test(token)) return 'password';
  if (/email/i.test(token)) return 'email';
  return 'text';
}

export function detectSignupPage(page: SiteMapPage): SignupSurface | undefined {
  const labels = [
    ...(page.forms ?? []).map(form => form.submitLabel || ''),
    ...(page.controls ?? []).filter(control => control.kind === 'button').map(control => control.label),
  ];
  const probe = classifySignup(page.url, inputsOf(page), labels);
  if (!probe.isSignup) return undefined;
  return probe;
}

/** A model flow that would submit a completed sign-up, including an invented address. */
export function plansCompleteSignup(flow: { name: string; description: string; steps: Array<{ action: string; value?: string }> }): boolean {
  const text = [flow.name, flow.description, ...flow.steps.map(step => `${step.action} ${step.value || ''}`)].join('\n');
  if (!SIGNUP_SUBMIT.test(text) && !SIGNUP_URL.test(text)) return false;
  if (/without filling|leave .*empty|do not submit|don't submit|invalid|mismatch|not-an-email/i.test(text)) return false;
  const address = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
  const submits = /\b(submit|click|press)\b/i.test(text);
  return address && submits;
}
