/**
 * Saved sessions need a live post-login check. Signed-in link probes do not
 * GET /logout. Loopback only. Synthetic values.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { bindAuthProvider } from '../src/index.js';
import { executePageChecks } from '../src/checks/execute.js';
import { runPlan } from '../src/runner/index.js';
import { triage } from '../src/triager/index.js';
import type { LLM } from '../src/llm/index.js';
import type { AuthStorageState } from '../src/auth/contract.js';
import type { TestPlan } from '../src/types.js';

const COOKIE = 'proof-cookie-4c5d6e7f8a9b';

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>) {
  const server = createServer((req, res) => { void handler(req, res); });
  return new Promise<{ origin: string; close: () => Promise<void> }>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(done => server.close(() => done())),
      });
    });
  });
}

const llm = {
  providerLabel: 'stub',
  async generateJSON() {
    return { tool: 'noop', target: 'page', rationale: 'stay', siteType: 'app', summary: 'Synthetic page.' };
  },
} as LLM;

function jar(): AuthStorageState {
  return {
    cookies: [{
      name: 'session',
      value: COOKIE,
      domain: '127.0.0.1',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    }],
    origins: [],
  };
}

describe('saved session proof and signed-in probes', () => {
  let origin = '';
  let close: () => Promise<void> = async () => {};
  const hits: Record<string, number> = {};

  beforeAll(async () => {
    const app = await listen(async (req, res) => {
      const url = new URL(req.url || '/', origin || 'http://127.0.0.1');
      hits[`${req.method} ${url.pathname}`] = (hits[`${req.method} ${url.pathname}`] || 0) + 1;
      if (url.pathname === '/slow') {
        await new Promise(resolve => setTimeout(resolve, 1200));
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p id="ready">Ready</p>');
        return;
      }
      if (url.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<form><input type="password"><p>Sign in</p></form>');
        return;
      }
      if (url.pathname === '/home' || url.pathname === '/dashboard') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p id="ready">Ready</p><a href="/logout">Log out</a><a href="/keep">Keep</a>');
        return;
      }
      if (url.pathname === '/settings') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p id="ready">Settings page</p>');
        return;
      }
      if (url.pathname === '/billing') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<p id="ready">Billing page</p>');
        return;
      }
      res.writeHead(204);
      res.end();
    });
    origin = app.origin;
    close = app.close;
  });

  afterAll(async () => { await close(); });

  it('refuses a jar with no post-login check and accepts one the page shows', async () => {
    const missing = await bindAuthProvider({
      targetOrigin: `${origin}/home`,
      storageState: jar(),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.metadata.status).toBe('auth_required');
    expect(JSON.stringify(missing)).not.toContain(COOKIE);

    const wrong = await bindAuthProvider({
      targetOrigin: `${origin}/home`,
      storageState: jar(),
      postLoginSelector: '#missing',
    });
    expect(wrong.ok).toBe(false);
    expect(JSON.stringify(wrong)).not.toContain(COOKIE);

    const proved = await bindAuthProvider({
      targetOrigin: `${origin}/home`,
      storageState: jar(),
      postLoginSelector: '#ready',
    });
    expect(proved.ok).toBe(true);
    if (proved.ok) expect(proved.metadata.status).toBe('authenticated');
    expect(JSON.stringify(proved)).not.toContain(COOKIE);
  });

  it('does not fail a signed-in run whose flows leave the post-login path', async () => {
    const proved = await bindAuthProvider({
      targetOrigin: origin,
      storageState: jar(),
      postLoginUrl: '/dashboard',
    });
    expect(proved.ok).toBe(true);
    expect(hits['GET /dashboard'] || 0).toBeGreaterThan(0);
    hits['GET /settings'] = 0;
    hits['GET /billing'] = 0;
    const plan: TestPlan = {
      startUrl: `${origin}/settings`,
      siteType: 'app',
      flows: [
        {
          id: 'settings',
          name: 'Settings',
          description: 'open settings',
          kind: 'happy_path',
          startUrl: `${origin}/settings`,
          steps: [{ action: 'Look at settings' }],
          expectation: 'Settings is visible',
          outcomeCheck: { kind: 'text_visible', value: 'Settings page' },
          severityIfFails: 'minor',
        },
        {
          id: 'billing',
          name: 'Billing',
          description: 'open billing',
          kind: 'happy_path',
          startUrl: `${origin}/billing`,
          steps: [{ action: 'Look at billing' }],
          expectation: 'Billing is visible',
          outcomeCheck: { kind: 'text_visible', value: 'Billing page' },
          severityIfFails: 'minor',
        },
      ],
    };
    const run = triage(await runPlan(plan, llm, {
      screenshotsDir: mkdtempSync(join(tmpdir(), 'mt-paths-')),
      headless: true,
      recordVideo: false,
      storageState: jar(),
      authOrigin: { targetOrigin: origin, idpOrigins: [] },
      postLoginUrl: '/dashboard',
    }), {});
    expect(run.outcome).not.toBe('could_not_test');
    expect(run.auth?.outcome).toBe('authenticated');
    expect(hits['GET /settings'] || 0).toBeGreaterThan(0);
    expect(hits['GET /billing'] || 0).toBeGreaterThan(0);
    expect(JSON.stringify(run)).not.toContain(COOKIE);
  });

  it('does not GET logout while signed in, and does when anonymous', async () => {
    const browser = await chromium.launch({ headless: true });
    const dir = mkdtempSync(join(tmpdir(), 'mt-probe-'));
    const flow = {
      id: 'check-http',
      name: 'HTTP',
      description: 'links',
      kind: 'visual' as const,
      startUrl: `${origin}/home`,
      expectation: 'The page loads.',
      severityIfFails: 'minor' as const,
      steps: [{ action: 'Check links', pageCheck: 'http' as const, url: `${origin}/home` }],
    };
    try {
      hits['GET /logout'] = 0;
      await executePageChecks(browser, [flow], {
        screenshotsDir: dir,
        stepTimeoutMs: 8_000,
        storageState: jar(),
        authOrigin: { targetOrigin: origin, idpOrigins: [] },
      });
      expect(hits['GET /logout'] || 0).toBe(0);
      hits['GET /logout'] = 0;
      await executePageChecks(browser, [flow], {
        screenshotsDir: dir,
        stepTimeoutMs: 8_000,
      });
      expect(hits['GET /logout'] || 0).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  it('treats a password field after the session as could_not_test', async () => {
    const plan: TestPlan = {
      startUrl: `${origin}/login`,
      siteType: 'app',
      flows: [{
        id: 'visit',
        name: 'Visit',
        description: 'open',
        kind: 'happy_path',
        startUrl: `${origin}/login`,
        steps: [{ action: 'Look at the page' }],
        expectation: 'Sign in is visible',
        outcomeCheck: { kind: 'text_visible', value: 'Sign in' },
        severityIfFails: 'minor',
      }],
    };
    const run = triage(await runPlan(plan, llm, {
      screenshotsDir: mkdtempSync(join(tmpdir(), 'mt-lost-')),
      headless: true,
      recordVideo: false,
      storageState: jar(),
      authOrigin: { targetOrigin: origin, idpOrigins: [] },
    }), {});
    expect(run.outcome).toBe('could_not_test');
    expect(run.auth?.outcome).not.toBe('authenticated');
    expect(JSON.stringify(run)).not.toContain(COOKIE);
  });

  it('stops a later flow when the envelope expires during the run', async () => {
    hits['GET /keep'] = 0;
    const plan: TestPlan = {
      startUrl: `${origin}/slow`,
      siteType: 'app',
      flows: [
        {
          id: 'slow',
          name: 'Slow',
          description: 'wait',
          kind: 'happy_path',
          startUrl: `${origin}/slow`,
          steps: [{ action: 'Look at the slow page' }],
          expectation: 'Ready is visible',
          outcomeCheck: { kind: 'text_visible', value: 'Ready' },
          severityIfFails: 'minor',
        },
        {
          id: 'later',
          name: 'Later',
          description: 'next',
          kind: 'happy_path',
          startUrl: `${origin}/keep`,
          steps: [{ action: 'Open the next page' }],
          expectation: 'Still ready',
          outcomeCheck: { kind: 'text_visible', value: 'Ready' },
          severityIfFails: 'minor',
        },
      ],
    };
    const run = triage(await runPlan(plan, llm, {
      screenshotsDir: mkdtempSync(join(tmpdir(), 'mt-exp-')),
      headless: true,
      recordVideo: false,
      storageState: jar(),
      authOrigin: { targetOrigin: origin, idpOrigins: [] },
      sessionExpiresAt: new Date(Date.now() + 400).toISOString(),
    }), {});
    expect(run.outcome).toBe('could_not_test');
    expect(run.outcome_reason).toBe('auth_expired');
    expect(hits['GET /keep'] || 0).toBe(0);
    expect(JSON.stringify(run)).not.toContain(COOKIE);
  });
});
