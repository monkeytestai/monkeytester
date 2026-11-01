/**
 * Hard guard. The runner calls this before a click or Enter that would
 * submit a sign-up form. A prompt is not enough: a completed, valid form
 * is not submitted unless this call is the one inbox sign-up.
 */

import type { Page } from 'playwright';
import type { InboxProvider } from '../types.js';
import type { ResolvedAction } from '../runner/actions.js';
import { classifySignup, syntacticEmail, type SignupField, type SignupProbe } from './detect.js';
import { noteSignup, type SignupLedger } from './ledger.js';

export interface SignupBlock {
  observation: string;
  halt: boolean;
}

export async function probeSignup(page: Page): Promise<SignupProbe> {
  const raw = await page.evaluate(() => {
    function interactable(el: Element): boolean {
      const html = el as HTMLInputElement;
      const type = (html.getAttribute('type') || '').toLowerCase();
      if (type === 'hidden' || html.disabled) return false;
      if (html.hidden || html.getAttribute('aria-hidden') === 'true') return false;
      let node: Element | null = html;
      while (node) {
        if (node instanceof HTMLElement) {
          if (node.hidden || node.getAttribute('aria-hidden') === 'true' || node.hasAttribute('inert')) return false;
        }
        node = node.parentElement;
      }
      const style = getComputedStyle(html);
      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      const rect = html.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      if (rect.right < 0 || rect.bottom < 0) return false;
      const docW = Math.max(document.documentElement.scrollWidth, window.innerWidth);
      const docH = Math.max(document.documentElement.scrollHeight, window.innerHeight);
      if (rect.left > docW || rect.top > docH) return false;
      if (html.getAttribute('tabindex') === '-1' && !html.getAttribute('aria-label') && !html.getAttribute('aria-labelledby')) {
        const labelled = html.id && document.querySelector(`label[for="${CSS.escape(html.id)}"]`);
        if (!labelled) return false;
      }
      return true;
    }
    function oauthLabel(text: string, href: string): boolean {
      const blob = `${text} ${href}`;
      if (/\/auth\/(?:google|facebook|github|apple|microsoft)\b/i.test(blob)) return true;
      if (/\b(?:continue with|sign[\s-]*in with|sign[\s-]*up with|log[\s-]*in with|use)\s+(?:google|facebook|github|apple|microsoft)\b/i.test(text)) return true;
      if (/\b(?:continue with|sign in with|log in with|sign up with)\b/i.test(text)) return true;
      return false;
    }
    const fields = Array.from(document.querySelectorAll('input, textarea, select')).filter(interactable).map(node => {
      const el = node as HTMLInputElement;
      const label = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute('aria-label') || '';
      return {
        type: el.type || el.tagName.toLowerCase(),
        name: el.getAttribute('name') || '',
        label: label.trim(),
        placeholder: el.getAttribute('placeholder') || '',
        id: el.id || '',
        required: el.required,
        value: el.value || '',
        interactable: true,
      };
    });
    const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], [role="button"], a[href]'))
      .filter(interactable)
      .map(node => {
        const text = ((node as HTMLElement).innerText || (node as HTMLInputElement).value || node.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        const href = node.getAttribute('href') || '';
        return oauthLabel(text, href) ? '' : text;
      })
      .filter(Boolean);
    const captcha = Boolean(document.querySelector('iframe[src*="captcha" i], iframe[src*="recaptcha" i], iframe[src*="hcaptcha" i], iframe[src*="turnstile" i], [name*="captcha" i]'));
    return { url: location.href, fields, buttons, captcha };
  }).catch(() => ({ url: '', fields: [] as SignupField[], buttons: [] as string[], captcha: false }));

  const fields: SignupField[] = raw.captcha
    ? [...raw.fields, { type: 'text', name: 'captcha', label: 'captcha' }]
    : raw.fields;
  return classifySignup(raw.url || safeUrl(page), fields, raw.buttons);
}

export async function signupSubmitBlock(
  page: Page,
  action: Pick<ResolvedAction, 'tool' | 'target' | 'value'>,
  opts: { inbox?: InboxProvider; ledger: SignupLedger; allowLiveSubmit?: boolean },
): Promise<SignupBlock | undefined> {
  if (!submits(action)) return undefined;
  const probe = await probeSignup(page);
  if (!probe.isSignup) return undefined;
  opts.ledger.sawForm = true;

  if (probe.blocked) {
    noteSignup(opts.ledger, { saw: true, status: 'blocked', reason: probe.blocked });
    return {
      halt: true,
      observation: `Sign-up was not submitted because the form asks for ${probe.blocked}. This is not a bug in the site.`,
    };
  }

  if (!wouldSubmitRealAddress(probe)) return undefined;

  if (opts.allowLiveSubmit && opts.inbox && !opts.ledger.usedLiveSubmit) return undefined;

  if (!opts.inbox) {
    noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'no_inbox' });
    return {
      halt: true,
      observation: 'Refused to submit a completed sign-up form. No inbox provider is configured (signup_reason no_inbox).',
    };
  }

  noteSignup(opts.ledger, { saw: true, status: 'not_tested', reason: 'cap_reached' });
  return {
    halt: true,
    observation: 'Refused to submit another completed sign-up form. A run creates at most one account (signup_reason cap_reached).',
  };
}

/**
 * A sign-up submit that already contains a real-looking email address.
 * Empty and invalid-email submits are allowed. A password mismatch is
 * allowed. Everything else is a completed (or completable) account and is
 * refused unless this is the one inbox submit.
 */
function wouldSubmitRealAddress(probe: SignupProbe): boolean {
  if (probe.completeValid) return true;
  const email = probe.email?.value?.trim();
  if (!syntacticEmail(email)) return false;
  const password = probe.password?.value || '';
  const confirm = probe.confirm?.value || '';
  if (password && confirm && password !== confirm) return false;
  return true;
}

function submits(action: Pick<ResolvedAction, 'tool' | 'target' | 'value'>): boolean {
  if (action.tool === 'press' && /enter/i.test(action.value || '')) return true;
  if (action.tool !== 'click') return false;
  const target = `${action.target || ''}`.toLowerCase();
  if (/type=["']?submit|\[type=.?submit/.test(target)) return true;
  return /\b(create(?:\s+an?)?\s+account|sign[\s-]*up|signup|register|submit|join)\b/i.test(target);
}

function safeUrl(page: Page): string {
  try { return page.url(); } catch { return ''; }
}
