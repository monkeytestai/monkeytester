/**
 * Sensitive submits, OAuth navigation, weak text checks, sourceless page
 * errors, and public sign-in screens.
 */

import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { judgeConsole } from '../src/checks/console.js';
import { decideAuthGated, isPublicAuthScreen, screenFingerprint } from '../src/explorer/screens.js';
import { evaluateOutcomeCheck } from '../src/outcome/check.js';
import { executeAction } from '../src/runner/actions.js';
import { isThirdPartyPageError, oracleFromEvidence } from '../src/runner/evidence.js';
import {
  installDialogPolicy,
  installSubmissionGuards,
  plansDisallowedSensitiveSubmit,
  setStepIntent,
  submissionPolicy,
} from '../src/runner/sensitive.js';
import { OAUTH_LABEL } from '../src/signup/detect.js';
import { runSignupCheck } from '../src/signup/run.js';
import { emptySignupLedger } from '../src/signup/ledger.js';

describe('sensitive submit guard', () => {
  it('blocks a filled OTP or reset submit and still allows an empty validation click', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await installSubmissionGuards(page, {});
      await page.setContent(`<!doctype html><form>
        <input id="email" name="email" type="email">
        <button type="submit" id="send">Send OTP</button>
      </form>
      <script>document.querySelector('form').addEventListener('submit', (event) => { event.preventDefault(); window.__sent = (window.__sent || 0) + 1; });</script>`);
      await page.fill('#email', 'you@example.com');
      const blocked = await executeAction(page, { tool: 'click', locator: 'text', target: 'Send OTP' }, 5_000);
      expect(blocked.status).toBe('skipped');
      expect(blocked.error).toBe('sensitive-submit');
      expect(await page.evaluate(() => (window as unknown as { __sent?: number }).__sent || 0)).toBe(0);

      await page.fill('#email', '');
      const empty = await executeAction(page, { tool: 'click', locator: 'text', target: 'Send OTP' }, 5_000);
      expect(empty.error).not.toBe('sensitive-submit');
      expect(await page.evaluate(() => (window as unknown as { __sent?: number }).__sent || 0)).toBe(1);
    } finally {
      await browser.close();
    }
  });

  it('aborts a password-reset POST that carries an email, and lets an empty POST through', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<p>ready</p>');
      await installSubmissionGuards(page, {});
      const filled = await page.evaluate(async () => {
        try {
          await fetch('https://example.test/forgot-password', { method: 'POST', body: 'email=you@example.com' });
          return 'sent';
        } catch {
          return 'blocked';
        }
      });
      expect(filled).toBe('blocked');
      expect(submissionPolicy(page)?.blocked).toMatch(/reset/);

      const policy = submissionPolicy(page);
      if (policy) policy.blocked = undefined;
      await page.evaluate(async () => {
        try {
          await fetch('https://example.test/forgot-password', { method: 'POST', body: 'email=' });
        } catch { /* continued requests can still fail DNS */ }
      });
      expect(submissionPolicy(page)?.blocked).toBeUndefined();
    } finally {
      await browser.close();
    }
  });

  it('lets an inbox submit OTP and reset, and still blocks checkout', async () => {
    expect(plansDisallowedSensitiveSubmit({
      name: 'Send the code',
      description: 'Forgot password',
      steps: [{ action: 'Fill email', value: 'you@example.com' }, { action: 'Click Send OTP' }],
    }, {})).toBe(true);
    expect(plansDisallowedSensitiveSubmit({
      name: 'Send the code',
      description: 'Forgot password',
      steps: [{ action: 'Fill email', value: 'you@example.com' }, { action: 'Click Send OTP' }],
    }, { inbox: true })).toBe(false);
    expect(plansDisallowedSensitiveSubmit({
      name: 'Empty reset',
      description: 'Submit the empty forgot-password form',
      steps: [{ action: 'Click Send OTP without filling' }],
    }, {})).toBe(false);
    expect(plansDisallowedSensitiveSubmit({
      name: 'Checkout',
      description: 'Place the order',
      steps: [{ action: 'Click Pay now' }],
    }, { inbox: true })).toBe(true);
    expect(plansDisallowedSensitiveSubmit({
      name: 'Checkout',
      description: 'Place the order',
      steps: [{ action: 'Click Pay now' }],
    }, { allow: ['payment'] })).toBe(false);
  });
});

describe('OAuth clicks', () => {
  it('matches Use Facebook and does not click the first button', async () => {
    expect(OAUTH_LABEL.test('Use Facebook')).toBe(true);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><form>
        <input id="email" type="email" name="email">
        <input id="password" type="password" name="password">
        <button id="fb">Use Facebook</button>
        <button id="cancel">Cancel</button>
        <button type="submit" id="create">Create account</button>
      </form>
      <script>
        for (const id of ['fb', 'cancel', 'create']) {
          document.getElementById(id).addEventListener('click', () => { window.__clicked = id; });
        }
        document.querySelector('form').addEventListener('submit', (event) => event.preventDefault());
      </script>`);
      const outcome = await runSignupCheck(page, 'empty_submit', {
        ledger: emptySignupLedger(),
        timeoutMs: 5_000,
        runId: 'oauth',
      });
      expect(await page.evaluate(() => (window as unknown as { __clicked?: string }).__clicked)).toBe('create');
      expect(outcome.observation).not.toMatch(/facebook/i);
    } finally {
      await browser.close();
    }
  });

  it('aborts navigation to an OAuth host and to /auth/facebook', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await installSubmissionGuards(page, {});
      await page.setContent('<a href="https://accounts.google.com/o/oauth2/v2/auth">Use Google</a>');
      const google = await executeAction(page, { tool: 'click', locator: 'text', target: 'Use Google' }, 5_000);
      expect(google.status).toBe('skipped');
      expect(google.error).toBe('oauth-navigation');
      expect(page.url()).not.toMatch(/accounts\.google\.com/);
      await page.setContent('<a href="https://app.example/auth/facebook">Use Facebook</a>');
      const facebook = await executeAction(page, { tool: 'click', locator: 'text', target: 'Use Facebook' }, 5_000);
      expect(facebook.status).toBe('skipped');
      expect(facebook.error).toBe('oauth-navigation');
      expect(page.url()).not.toMatch(/\/auth\/facebook/);
    } finally {
      await browser.close();
    }
  });
});

describe('weak outcome text and placeholders', () => {
  it('does not fail a flow when invented success text is missing, and ignores placeholders', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<input placeholder="Success"><p>Hello</p>');
      const missing = await evaluateOutcomeCheck(page, { kind: 'text_visible', value: 'Thanks for subscribing' }, { startUrl: page.url() });
      expect(missing.state).toBe('unverifiable');
      const placeholder = await evaluateOutcomeCheck(page, { kind: 'text_visible', value: 'Success' }, { startUrl: page.url() });
      expect(placeholder.state).not.toBe('verified');
      const visible = await evaluateOutcomeCheck(page, { kind: 'text_visible', value: 'Hello' }, { startUrl: page.url() });
      expect(visible.state).toBe('verified');
    } finally {
      await browser.close();
    }
  });

  it('treats an empty field after fill as an automation error', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent('<input id="email" aria-label="Email" oninput="this.value=\'\'">');
      const outcome = await executeAction(page, {
        tool: 'fill',
        locator: 'label',
        target: 'Email',
        value: 'you@example.com',
      }, 5_000);
      expect(outcome.status).toBe('skipped');
      expect(outcome.error).toBe('automation_error');
      expect(await page.inputValue('#email')).toBe('');
    } finally {
      await browser.close();
    }
  });

  it('accepts a confirm the flow asked for and dismisses one it did not', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      installDialogPolicy(page);
      await page.setContent(`<button id="go">Go</button><script>
        document.getElementById('go').onclick = () => { window.__answer = confirm('Delete this account?'); };
      </script>`);
      setStepIntent(page, 'Click confirm to delete the account');
      await page.click('#go');
      expect(await page.evaluate(() => (window as unknown as { __answer?: boolean }).__answer)).toBe(true);
      setStepIntent(page, 'Open the catalogue');
      await page.click('#go');
      expect(await page.evaluate(() => (window as unknown as { __answer?: boolean }).__answer)).toBe(false);
    } finally {
      await browser.close();
    }
  });
});

describe('page errors without a script URL', () => {
  it('keeps a known first-party script as a bug and turns a sourceless error into a suggestion', () => {
    const page = 'https://demoqa.com/elements';
    expect(oracleFromEvidence([{ message: 'checkout exploded' }], [], page)).toBeNull();
    expect(oracleFromEvidence(
      [{ message: 'ads failed', sourceUrl: 'https://pagead2.googlesyndication.com/ads.js' }],
      [],
      page,
    )).toBeNull();
    expect(isThirdPartyPageError(
      { message: 'Failed to load https://pagead2.googlesyndication.com/ads.js' },
      page,
    )).toBe(true);
    expect(oracleFromEvidence(
      [{ message: 'checkout exploded', sourceUrl: 'https://demoqa.com/app.js' }],
      [],
      page,
    )?.error).toBe('pageerror');
    const judged = judgeConsole([{ kind: 'pageerror', message: 'Script error.' }], page);
    expect(judged.bugs).toEqual([]);
    expect(judged.unattributed.map(hit => hit.message)).toEqual(['Script error.']);
  });
});

describe('public sign-in screens', () => {
  it('does not mark sign-in or sign-up as auth-gated, and dedupes the same rendered screen', () => {
    expect(isPublicAuthScreen('https://app.monkeytest.ai/signup')).toBe(true);
    expect(isPublicAuthScreen('https://app.monkeytest.ai/signin')).toBe(true);
    expect(decideAuthGated('https://app.monkeytest.ai/signup', true, true)).toBe(false);
    expect(decideAuthGated('https://app.monkeytest.ai/signin', true, true)).toBe(false);
    expect(decideAuthGated('https://app.monkeytest.ai/dashboard', true, false)).toBe(true);
    const home = screenFingerprint({
      title: 'MonkeyTest',
      heading: 'Sign in',
      fields: ['email:email::Email', 'password:password::Password'],
    });
    const signin = screenFingerprint({
      title: 'MonkeyTest',
      heading: 'Sign in',
      fields: ['password:password::Password', 'email:email::Email'],
    });
    expect(home).toBe(signin);
    expect(screenFingerprint({ title: 'Shop', heading: 'Hats', fields: ['search:q::'] }))
      .not.toBe(screenFingerprint({ title: 'Shop', heading: 'Shoes', fields: ['search:q::'] }));
  });
});
