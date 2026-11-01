/**
 * Stored-plan replay uses the live outcome rules.
 *
 * A homepage that redirects to sign-in passes, with one auth-redirect note.
 * An auth or sign-up check recorded without a locator is run again by the
 * same check. A locator that no longer matches is inconclusive, not a bug.
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendSuggestions, passSignedOutVisit } from '../src/runner/flowJudge.js';
import { authCheckForFlowId } from '../src/planner/authNegative.js';
import { signupCheckForFlowId } from '../src/signup/plan.js';
import { replayTraces } from '../src/runner/replay.js';
import { runPlan } from '../src/runner/index.js';
import { triage } from '../src/triager/index.js';
import type { LLM } from '../src/llm/index.js';
import type { FlowTrace, TestPlan } from '../src/types.js';

const llm: LLM = {
  providerLabel: 'stub',
  async generateJSON({ label, prompt }) {
    if (label === 'runner.resolveAction') {
      const target = String(prompt).match(/https?:\/\/[^\s"'<>]+/)?.[0];
      return { tool: 'goto', target, rationale: 'Open the page.' };
    }
    throw new Error(`unexpected ${label}`);
  },
};

describe('replay judgement helpers', () => {
  it('keeps one auth-redirect note for the same landing page', () => {
    const list = [{
      pageUrl: 'https://app.example/signin',
      title: 'Signed-out redirect',
      detail: 'Opened https://app.example/ and landed on https://app.example/signin.',
      kind: 'auth-redirect' as const,
      severity: 'info' as const,
    }];
    appendSuggestions(list, [{
      ...list[0],
      detail: 'Opened https://app.example and landed on https://app.example/signin.',
    }]);
    expect(list).toHaveLength(1);
  });

  it('passes a signed-out homepage visit that url_unchanged would fail', () => {
    const suggestions: Parameters<typeof appendSuggestions>[0] = [];
    const verdict = passSignedOutVisit(
      { state: 'failed', observation: 'The URL changed from https://app.example/ to https://app.example/signin.' },
      {
        name: 'Visit Homepage',
        description: 'Open the homepage.',
        startUrl: 'https://app.example/',
        steps: [{ action: 'navigate' }],
      },
      'https://app.example/signin',
      200,
      suggestions,
    );
    expect(verdict.state).toBe('verified');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].kind).toBe('auth-redirect');
  });

  it('maps reserved flow ids back to the live checks', () => {
    expect(authCheckForFlowId('auth-neg-wrong-password')).toBe('wrong_password');
    expect(authCheckForFlowId('auth-neg-forgot-password')).toBe('forgot_link');
    expect(authCheckForFlowId('signup-page-navigation')).toBeUndefined();
    expect(signupCheckForFlowId('signup-val-empty')).toBe('empty_submit');
    expect(signupCheckForFlowId('signup-invalid-email')).toBeUndefined();
  });
});

describe('stored-plan replay', () => {
  let site: { url: string; close: () => Promise<void> };
  const shots = mkdtempSync(join(tmpdir(), 'monkeytest-replay-accuracy-'));

  beforeAll(async () => {
    site = await startSite();
  });

  afterAll(async () => {
    await site.close();
  });

  it('replays a homepage visit that redirects to sign-in, including a beta.4 trace', async () => {
    const plan = visitPlan(site.url);
    const live = await runPlan(plan, llm, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      failOn5xx: true,
      stepTimeoutMs: 8_000,
    });
    expect(live.flows[0].status).toBe('passed');
    expect(live.flows[0].suggestions?.filter(item => item.kind === 'auth-redirect')).toHaveLength(1);

    const replayed = triage(await replayTraces(live.flows.map(flow => flow.trace!), replayOpts(shots)));
    expect(replayed.bugs).toEqual([]);
    expect(replayed.flows[0].status).toBe('passed');
    expect(replayed.flows[0].suggestions?.filter(item => item.kind === 'auth-redirect')).toHaveLength(1);
    expect(replayed.suggestions?.filter(item => item.kind === 'auth-redirect')).toHaveLength(1);

    const stored = triage(await replayTraces([beta4Visit(site.url)], replayOpts(shots)));
    expect(stored.bugs).toEqual([]);
    expect(stored.flows[0].status).toBe('passed');
    expect(stored.flows[0].assertion).toBe('verified');
    expect(stored.suggestions?.filter(item => item.kind === 'auth-redirect')).toHaveLength(1);
  }, 30_000);

  it('re-runs sign-in and sign-up checks that were stored with no locator', async () => {
    const replayed = triage(await replayTraces([
      authTrace(site.url, 'auth-neg-empty-submit', 'Click "Sign In" without filling the form'),
      authTrace(site.url, 'auth-neg-wrong-password', 'Fill the "Email*" field with "monkeytest+replay@example.invalid", fill the password with a synthetic value, and click "Sign In"', 'monkeytest+replay@example.invalid'),
      signupTrace(site.url),
    ], replayOpts(shots)));
    expect(replayed.bugs).toEqual([]);
    expect(replayed.flows.map(flow => flow.status)).toEqual(['passed', 'passed', 'passed']);
  }, 30_000);

  it('leaves a stale locator inconclusive and does not click OAuth or finish a reset', async () => {
    const stale = triage(await replayTraces([staleTrace(site.url)], replayOpts(shots)));
    expect(stale.bugs).toEqual([]);
    expect(stale.flows[0].status).toBe('inconclusive');
    expect(stale.flows[0].outcome_reason).toBe('automation_error');
    expect(stale.flows[0].steps.some(step => step.error === 'locator_mismatch')).toBe(true);
    expect(stale.outcome).not.toBe('bugs_found');

    const refused = triage(await replayTraces([refusedSignupTrace(site.url)], replayOpts(shots)));
    expect(refused.bugs).toEqual([]);
    expect(refused.flows[0].status).not.toBe('failed');
    expect(refused.flows[0].steps.some(step => /validation message/i.test(step.observation || ''))).toBe(false);

    const nav = triage(await replayTraces([signupNavTrace(site.url)], replayOpts(shots)));
    expect(nav.bugs).toEqual([]);
    expect(nav.flows[0].status).not.toBe('passed');

    const oauth = triage(await replayTraces([oauthTrace(site.url)], replayOpts(shots)));
    expect(oauth.bugs).toEqual([]);
    expect(oauth.flows[0].status).not.toBe('passed');
    expect(oauth.flows[0].steps.some(step => step.error === 'oauth-navigation')).toBe(true);

    const reset = triage(await replayTraces([resetTrace(site.url)], replayOpts(shots)));
    expect(reset.bugs).toEqual([]);
    expect(reset.flows[0].status).not.toBe('passed');
    expect(reset.flows[0].steps.some(step => step.error === 'sensitive-submit')).toBe(true);
  }, 30_000);
});

function replayOpts(screenshotsDir: string) {
  return {
    screenshotsDir,
    headless: true,
    recordVideo: false,
    strictOracles: true,
    failOn5xx: true,
    stepTimeoutMs: 8_000,
  };
}

function visitPlan(origin: string): TestPlan {
  const startUrl = `${origin}/`;
  return {
    startUrl,
    siteType: 'app',
    flows: [{
      id: 'visit-homepage',
      name: 'Visit Homepage',
      description: 'Open the homepage.',
      kind: 'happy_path',
      startUrl,
      steps: [{ action: 'Visit the homepage', expectation: 'The homepage stays open.' }],
      expectation: 'The homepage stays open.',
      outcomeCheck: { kind: 'url_unchanged' },
      severityIfFails: 'major',
    }],
  };
}

function beta4Visit(origin: string): FlowTrace {
  const startUrl = `${origin}/`;
  return {
    version: 1,
    flowId: 'visit-homepage',
    name: 'Visit Homepage',
    description: 'Ensure visitors can access the homepage.',
    kind: 'happy_path',
    startUrl,
    expectation: 'The homepage is accessible.',
    outcomeCheck: { kind: 'url_unchanged' },
    severityIfFails: 'major',
    steps: [
      {
        index: 0,
        action: `Open ${startUrl}`,
        tool: 'goto',
        status: 'passed',
        locator: { strategy: 'css', target: startUrl },
        urlAfter: `${origin}/signin`,
      },
      {
        index: 1,
        action: 'navigate',
        tool: 'goto',
        status: 'passed',
        locator: { strategy: 'css', target: startUrl, css: startUrl },
      },
      {
        index: 2,
        action: 'Check the expected outcome',
        tool: 'assert_text',
        status: 'failed',
        observation: `The URL changed from ${startUrl} to ${origin}/signin.`,
        error: `The URL changed from ${startUrl} to ${origin}/signin.`,
      },
    ],
  };
}

function authTrace(origin: string, flowId: string, action: string, value?: string): FlowTrace {
  const startUrl = `${origin}/`;
  return {
    version: 1,
    flowId,
    name: flowId,
    description: action,
    kind: 'edge_case',
    startUrl,
    expectation: 'The sign-in check does not report a site bug when the page behaves.',
    outcomeCheck: flowId === 'auth-neg-wrong-password'
      ? { kind: 'auth_error_visible', also: [{ kind: 'url_unchanged' }] }
      : { kind: 'validation_visible', also: [{ kind: 'url_unchanged' }] },
    severityIfFails: 'major',
    steps: [
      {
        index: 0,
        action: `Open ${startUrl}`,
        tool: 'goto',
        status: 'passed',
        locator: { strategy: 'css', target: startUrl },
      },
      {
        index: 1,
        action,
        tool: 'click',
        status: 'passed',
        ...(value ? { value } : {}),
      },
    ],
  };
}

function signupTrace(origin: string): FlowTrace {
  const startUrl = `${origin}/signup`;
  return {
    version: 1,
    flowId: 'signup-val-empty',
    name: 'Submit the sign-up form empty',
    description: 'Empty sign-up submit.',
    kind: 'edge_case',
    startUrl,
    expectation: 'Empty submit shows validation.',
    outcomeCheck: { kind: 'validation_visible', also: [{ kind: 'url_unchanged' }] },
    severityIfFails: 'major',
    steps: [
      {
        index: 0,
        action: `Open ${startUrl}`,
        tool: 'goto',
        status: 'passed',
        locator: { strategy: 'css', target: startUrl },
      },
      {
        index: 1,
        action: 'Click "Create Account" without filling the sign-up form',
        tool: 'click',
        status: 'passed',
      },
    ],
  };
}

function refusedSignupTrace(origin: string): FlowTrace {
  const startUrl = `${origin}/signup`;
  return {
    version: 1,
    flowId: 'signup-invalid-email',
    name: 'Signup with Invalid Email',
    description: 'Test the signup form with an invalid email to check validation.',
    kind: 'edge_case',
    startUrl,
    expectation: 'Validation error is shown for invalid email submission.',
    outcomeCheck: { kind: 'validation_visible' },
    severityIfFails: 'major',
    steps: [
      {
        index: 0,
        action: `Open ${startUrl}`,
        tool: 'goto',
        status: 'passed',
        locator: { strategy: 'css', target: startUrl },
      },
      {
        index: 1,
        action: 'fill',
        tool: 'fill',
        status: 'passed',
        value: 'qa@example.com',
        locator: { strategy: 'label', target: 'Email*', label: 'Email*', role: 'textbox', name: 'Email*' },
      },
      {
        index: 2,
        action: 'click',
        tool: 'click',
        status: 'skipped',
        observation: 'Refused to submit a completed sign-up form. No inbox provider is configured (signup_reason no_inbox).',
      },
    ],
  };
}

function signupNavTrace(origin: string): FlowTrace {
  const startUrl = `${origin}/`;
  return {
    version: 1,
    flowId: 'signup-page-navigation',
    name: 'Navigate to Signup Page',
    description: 'Ensure users can navigate to the signup page from the homepage.',
    kind: 'happy_path',
    startUrl,
    expectation: 'The signup page loads successfully.',
    outcomeCheck: { kind: 'url_changed', value: '/signup' },
    severityIfFails: 'major',
    steps: [
      {
        index: 0,
        action: `Open ${startUrl}`,
        tool: 'goto',
        status: 'passed',
        locator: { strategy: 'css', target: startUrl },
      },
      {
        index: 1,
        action: 'click',
        tool: 'click',
        status: 'skipped',
        observation: 'No element matched text:link:Sign Up.',
        error: 'locator-unresolved',
        locator: { strategy: 'text', target: 'link:Sign Up', text: 'link:Sign Up' },
      },
    ],
  };
}

function staleTrace(origin: string): FlowTrace {
  const startUrl = `${origin}/signin`;
  return {
    version: 1,
    flowId: 'save-draft',
    name: 'Save the draft',
    description: 'Click a control that used to be on the page.',
    kind: 'happy_path',
    startUrl,
    expectation: 'The control is still there.',
    outcomeCheck: { kind: 'url_unchanged' },
    severityIfFails: 'major',
    steps: [
      {
        index: 0,
        action: `Open ${startUrl}`,
        tool: 'goto',
        status: 'passed',
        locator: { strategy: 'css', target: startUrl },
      },
      {
        index: 1,
        action: 'click',
        tool: 'click',
        status: 'passed',
        locator: { strategy: 'css', target: '#missing-save', css: '#missing-save' },
      },
    ],
  };
}

function oauthTrace(origin: string): FlowTrace {
  const startUrl = `${origin}/signin`;
  return {
    version: 1,
    flowId: 'continue-google',
    name: 'Continue with Google',
    description: 'The OAuth control is not clicked.',
    kind: 'happy_path',
    startUrl,
    expectation: 'OAuth is not opened.',
    steps: [
      {
        index: 0,
        action: `Open ${startUrl}`,
        tool: 'goto',
        status: 'passed',
        locator: { strategy: 'css', target: startUrl },
      },
      {
        index: 1,
        action: 'Click "Continue with Google"',
        tool: 'click',
        status: 'passed',
        locator: {
          strategy: 'role',
          target: 'link:Continue with Google',
          role: 'link',
          name: 'Continue with Google',
        },
      },
    ],
  };
}

function resetTrace(origin: string): FlowTrace {
  const startUrl = `${origin}/forgotpassword`;
  return {
    version: 1,
    flowId: 'password-recovery',
    name: 'Password Recovery',
    description: 'Submit the password reset form.',
    kind: 'happy_path',
    startUrl,
    expectation: 'The reset starts.',
    outcomeCheck: { kind: 'observable_response' },
    severityIfFails: 'critical',
    steps: [
      {
        index: 0,
        action: `Open ${startUrl}`,
        tool: 'goto',
        status: 'passed',
        locator: { strategy: 'css', target: startUrl },
      },
      {
        index: 1,
        action: 'fill',
        tool: 'fill',
        status: 'passed',
        value: 'user@example.com',
        locator: { strategy: 'label', target: 'Email*', label: 'Email*', role: 'textbox', name: 'Email*' },
      },
      {
        index: 2,
        action: 'click',
        tool: 'click',
        status: 'passed',
        locator: { strategy: 'role', target: 'button:Reset password', role: 'button', name: 'Reset password' },
      },
    ],
  };
}

function startSite(): Promise<{ url: string; close: () => Promise<void> }> {
  let server: Server;
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/signin') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html lang="en"><title>Sign in</title><body>
          <h1>Sign in</h1>
          <form id="signin">
            <label>Email*<input type="email" name="email" required></label>
            <label>Password<input type="password" name="password" required></label>
            <button type="submit">Sign In</button>
          </form>
          <a href="/auth/google">Continue with Google</a>
          <script>
            document.getElementById('signin').addEventListener('submit', (event) => {
              const email = document.querySelector('input[type=email]').value;
              const password = document.querySelector('input[type=password]').value;
              if (!email || !password || !email.includes('@')) return;
              event.preventDefault();
              const note = document.createElement('div');
              note.setAttribute('role', 'alert');
              note.textContent = 'Invalid credentials';
              document.body.appendChild(note);
            });
          </script>
        </body></html>`);
        return;
      }
      if (url.pathname === '/signup') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html lang="en"><title>Sign up</title><body>
          <h1>Sign up</h1>
          <form>
            <label>Email*<input type="email" name="email" required></label>
            <label>Password<input type="password" name="password" required></label>
            <label>Confirm password<input type="password" name="confirm" required></label>
            <button type="submit">Create Account</button>
          </form>
        </body></html>`);
        return;
      }
      if (url.pathname === '/forgotpassword') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><html lang="en"><title>Reset</title><body>
          <h1>Reset password</h1>
          <form>
            <label>Email*<input type="email" name="email" required></label>
            <button type="submit">Reset password</button>
          </form>
        </body></html>`);
        return;
      }
      if (url.pathname === '/auth/google') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html lang="en"><title>Google</title><body><h1>Google</h1></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html lang="en"><title>Home</title><body><script>location.replace("/signin")</script></body></html>');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('replay site did not bind'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => server.close(err => err ? fail(err) : done())),
      });
    });
  });
}
