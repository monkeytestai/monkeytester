/**
 * app.monkeytest.ai: a hidden #confirm_password honeypot was treated as the
 * confirm box and the filler waited 30s. The probe must ignore it. A fill
 * that fails before submit is an automation error, not a site bug.
 */

import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { isOwnAutomationBug } from '../src/automation/signatures.js';
import { OAUTH_LABEL, classifySignup } from '../src/signup/detect.js';
import { probeSignup } from '../src/signup/guard.js';
import { emptySignupLedger, noteSignup, signupFields } from '../src/signup/ledger.js';
import { runSignupCheck } from '../src/signup/run.js';
import { isOauthControl } from '../src/signup/submit.js';

const HTML = `<!doctype html><html><body>
  <form id="signup">
    <label for="email">Email</label>
    <input id="email" name="email" type="email">
    <label for="password">Password</label>
    <input id="password" name="password" type="password">
    <input id="confirm_password" name="confirm_password" type="password" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px;width:1px;height:1px" aria-hidden="true">
    <label for="password_confirmation">Confirm password</label>
    <input id="password_confirmation" name="password_confirmation" type="password">
    <button type="button">Use Facebook</button>
    <a href="/auth/google">Continue with Google</a>
    <button type="submit" id="create">Create account</button>
  </form>
  <script>
    document.getElementById('create').addEventListener('click', () => { window.__clicked = 'create'; });
    document.getElementById('signup').addEventListener('submit', (event) => {
      event.preventDefault();
      const left = document.getElementById('password').value;
      const right = document.getElementById('password_confirmation').value;
      if (left && right && left !== right) {
        document.body.insertAdjacentHTML('beforeend', '<p role="alert">Passwords do not match</p>');
      }
    });
  </script>
</body></html>`;

describe('sign-up honeypot and social buttons', () => {
  it('ignores the hidden confirm box and does not treat Use Facebook as the submit', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(HTML);
      const probe = await probeSignup(page);
      expect(probe.confirm?.id).toBe('password_confirmation');
      expect(probe.confirm?.id).not.toBe('confirm_password');
      expect(probe.submitLabels.join(' ')).not.toMatch(/facebook|google/i);
      expect(probe.submitLabels).toContain('Create account');
    } finally {
      await browser.close();
    }
  });

  it('does not hang when a fill is pointed at the honeypot', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(HTML);
      const ledger = emptySignupLedger();
      const started = Date.now();
      const outcome = await runSignupCheck(page, 'password_mismatch', {
        ledger,
        timeoutMs: 30_000,
        runId: 'honeypot',
      });
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(await page.evaluate(() => (window as unknown as { __clicked?: string }).__clicked)).toBe('create');
      expect(outcome.error).not.toBe('no-validation');
      expect(outcome.phases?.join(' ')).toMatch(/opened/);
      if (outcome.error === 'automation_error') {
        expect(isOwnAutomationBug({ title: outcome.observation, observed: outcome.observation, error: outcome.error })).toBe(true);
        expect(signupFields(ledger)).toMatchObject({
          signup_attempted: false,
          signup_status: 'not_tested',
          signup_reason: 'automation_error',
          signup_started: true,
        });
      }
    } finally {
      await browser.close();
    }
  });

  it('recognises Use Facebook and Continue with Google', () => {
    expect(isOauthControl('Use Facebook')).toBe(true);
    expect(isOauthControl('Continue with Google')).toBe(true);
    expect(isOauthControl('Sign up with Apple')).toBe(true);
    expect(isOauthControl('Log in with Microsoft')).toBe(true);
    expect(OAUTH_LABEL.test('Use Facebook')).toBe(true);
    expect(isOauthControl('Create account')).toBe(false);
    const hidden = classifySignup('https://app.example/signup', [
      { id: 'confirm_password', name: 'confirm_password', type: 'password', interactable: false },
      { id: 'password_confirmation', name: 'password_confirmation', type: 'password', interactable: true },
      { id: 'password', name: 'password', type: 'password', interactable: true },
    ], ['Use Facebook', 'Create account']);
    expect(hidden.confirm?.id).toBe('password_confirmation');
    expect(hidden.submitLabels).toEqual(['Create account']);
  });
});

describe('signup ledger', () => {
  it('reports no_signup_form when nothing was seen, and automation_error after a fill starts', () => {
    expect(signupFields(emptySignupLedger())).toEqual({
      signup_attempted: false,
      signup_status: 'not_tested',
      signup_reason: 'no_signup_form',
    });
    const ledger = emptySignupLedger();
    noteSignup(ledger, { started: true, saw: true, status: 'not_tested', reason: 'automation_error' });
    expect(signupFields(ledger)).toMatchObject({
      signup_attempted: false,
      signup_status: 'not_tested',
      signup_reason: 'automation_error',
      signup_started: true,
    });
  });
});
