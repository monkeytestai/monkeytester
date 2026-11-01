/**
 * Sensitive submits, OAuth navigation, weak text checks, sourceless page
 * errors, and public sign-in screens.
 */

import { createServer } from 'node:http';
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
  isAnalyticsBeaconUrl,
  isUserFormSubmission,
  plansDisallowedSensitiveSubmit,
  refreshFormActions,
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

  it('aborts a same-origin password-reset POST that carries an email, and lets an empty POST through', async () => {
    const site = await startGuardSite();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await installSubmissionGuards(page, {});
      await page.goto(`${site.url}/home`);
      const filled = await page.evaluate(async (origin) => {
        try {
          const response = await fetch(`${origin}/forgot-password`, { method: 'POST', body: 'email=you@example.com' });
          return response.status;
        } catch {
          return 0;
        }
      }, site.url);
      expect(filled).toBe(0);
      expect(submissionPolicy(page)?.blocked).toMatch(/reset/);

      const policy = submissionPolicy(page);
      if (policy) policy.blocked = undefined;
      const empty = await page.evaluate(async (origin) => {
        const response = await fetch(`${origin}/forgot-password`, { method: 'POST', body: 'email=' });
        return response.status;
      }, site.url);
      expect(empty).toBe(204);
      expect(submissionPolicy(page)?.blocked).toBeUndefined();
    } finally {
      await browser.close();
      await site.close();
    }
  });

  it('still blocks OTP, newsletter, payment, deletion, and a form-action host', async () => {
    const site = await startGuardSite();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await installSubmissionGuards(page, {});
      await page.goto(`${site.url}/home`);
      await refreshFormActions(page);
      const cases = [
        { method: 'POST', url: `${site.url}/send-otp`, body: 'email=you@example.com', kind: /otp/ },
        { method: 'PUT', url: `${site.url}/newsletter`, body: 'email=you@example.com', kind: /newsletter/ },
        { method: 'POST', url: `${site.url}/checkout`, body: 'card=4242424242424242', kind: /payment/ },
        { method: 'PATCH', url: `${site.url}/account`, body: 'confirm=delete account', kind: /deletion/ },
        { method: 'POST', url: 'https://payments.example/charge', body: 'payment=1', kind: /payment/ },
      ];
      for (const item of cases) {
        const policy = submissionPolicy(page);
        if (policy) policy.blocked = undefined;
        const status = await page.evaluate(async (send) => {
          try {
            const response = await fetch(send.url, { method: send.method, body: send.body });
            return response.status;
          } catch {
            return 0;
          }
        }, item);
        expect(status).toBe(0);
        expect(submissionPolicy(page)?.blocked).toMatch(item.kind);
      }
    } finally {
      await browser.close();
      await site.close();
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

describe('analytics beacons', () => {
  it('does not classify known collectors or sendBeacon as a sensitive submit', () => {
    const urls = [
      'https://clarity.ms/collect',
      'https://www.clarity.ms/collect',
      'https://www.google-analytics.com/g/collect',
      'https://www.googletagmanager.com/g/collect',
      'https://shop.example/cdn-cgi/rum?x=1',
      'https://api.segment.io/v1/track',
      'https://api.mixpanel.com/track',
      'https://in.hotjar.com/api/v2/client',
      'https://plausible.io/api/event',
      'https://us.i.posthog.com/e/',
      'https://o123.ingest.sentry.io/api/456/envelope/',
      'https://o123.ingest.us.sentry.io/api/456/envelope/',
    ];
    for (const url of urls) {
      expect(isAnalyticsBeaconUrl(url)).toBe(true);
      expect(isUserFormSubmission({
        url,
        method: 'POST',
        pageUrl: 'https://shop.example/',
        resourceType: 'fetch',
      })).toBe(false);
    }
    expect(isUserFormSubmission({
      url: 'https://collector.example/beacon',
      method: 'POST',
      pageUrl: 'https://shop.example/',
      resourceType: 'ping',
    })).toBe(false);
    expect(isUserFormSubmission({
      url: 'https://shop.example/rum',
      method: 'POST',
      pageUrl: 'https://shop.example/',
      resourceType: 'fetch',
      headers: { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' },
    })).toBe(false);
    expect(isUserFormSubmission({
      url: 'https://example.test/forgot-password',
      method: 'POST',
      pageUrl: 'https://shop.example/forgot-password',
      resourceType: 'fetch',
    })).toBe(false);
  });

  it('still classifies same-origin and form-action writes', () => {
    expect(isUserFormSubmission({
      url: 'https://shop.example/forgot-password',
      method: 'POST',
      pageUrl: 'https://shop.example/account',
      resourceType: 'fetch',
    })).toBe(true);
    expect(isUserFormSubmission({
      url: 'https://shop.example/api/subscribe',
      method: 'PUT',
      pageUrl: 'https://shop.example/',
      resourceType: 'xhr',
    })).toBe(true);
    expect(isUserFormSubmission({
      url: 'https://shop.example/account',
      method: 'PATCH',
      pageUrl: 'https://shop.example/account',
      resourceType: 'fetch',
    })).toBe(true);
    expect(isUserFormSubmission({
      url: 'https://payments.example/charge',
      method: 'POST',
      pageUrl: 'https://shop.example/checkout',
      resourceType: 'document',
      formActionUrls: ['https://payments.example/charge'],
    })).toBe(true);
    expect(isUserFormSubmission({
      url: 'https://shop.example/forgot-password',
      method: 'GET',
      pageUrl: 'https://shop.example/',
      resourceType: 'document',
    })).toBe(false);
  });

  it('does not make a homepage visit or a forgot-password link inconclusive', async () => {
    const site = await startGuardSite();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await installSubmissionGuards(page, {});
      const opened = await executeAction(page, { tool: 'goto', target: `${site.url}/home` }, 5_000);
      expect(opened.status).toBe('passed');
      expect(opened.error).toBeUndefined();
      expect(submissionPolicy(page)?.blocked).toBeUndefined();
      const clicked = await executeAction(page, { tool: 'click', locator: 'text', target: 'Forgot your password?' }, 5_000);
      expect(clicked.status).toBe('passed');
      expect(clicked.error).not.toBe('sensitive-submit');
      expect(submissionPolicy(page)?.blocked).toBeUndefined();
      expect(page.url()).toContain('/next');
    } finally {
      await browser.close();
      await site.close();
    }
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

function startGuardSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (url.pathname === '/next') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Next</title><p>Account</p>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Home</title>
      <a id="forgot" href="/next">Forgot your password?</a>
      <form method="post" action="https://payments.example/charge"><button type="submit">Pay</button></form>
      <script>
        navigator.sendBeacon('https://clarity.ms/collect', 'event=payment&page=reset password');
        fetch('/cdn-cgi/rum', { method: 'POST', body: 'payment reset', keepalive: true }).catch(() => {});
        document.getElementById('forgot').addEventListener('click', () => {
          navigator.sendBeacon('https://collector.example/beacon', JSON.stringify({ payment: true, action: 'reset password' }));
        });
      </script>`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('guard site did not bind'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => server.close(err => err ? fail(err) : done())),
      });
    });
  });
}
