/**
 * A logged-out redirect to sign-in is a pass. Cross-origin, error pages,
 * loops, and 4xx/5xx stay failures.
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { classifyDocumentRedirect, isPageVisitFlow } from '../src/explorer/authRedirect.js';
import { countPublicScreens } from '../src/outcome.js';
import { explore } from '../src/explorer/index.js';
import { runPlan } from '../src/runner/index.js';
import { triage } from '../src/triager/index.js';
import type { LLM } from '../src/llm/index.js';
import type { TestFlow, TestPlan } from '../src/types.js';

const llm: LLM = {
  providerLabel: 'stub',
  async generateJSON({ label, prompt }) {
    if (label === 'runner.resolveAction') {
      const target = String(prompt).match(/https?:\/\/[^\s"'<>]+/)?.[0];
      return { tool: 'goto', target, rationale: 'Open the page.' };
    }
    if (label === 'explorer.summarisePage') return { summary: 'Sign in', authGated: true, interactive: [] };
    if (label === 'explorer.summariseSite') {
      return { siteType: 'app', summary: 'Sign-in wall.', productName: 'App', publicJourneys: [], authSurfaces: [] };
    }
    throw new Error(`unexpected ${label}`);
  },
};

describe('document redirect classification', () => {
  it('treats same-origin sign-in, sign-up, and client redirects as expected', () => {
    expect(classifyDocumentRedirect({
      requestedUrl: 'https://app.example/',
      landedUrl: 'https://app.example/signin',
      statuses: [200],
    })).toBe('expected-auth');
    expect(classifyDocumentRedirect({
      requestedUrl: 'http://app.example/',
      landedUrl: 'https://www.app.example/login',
    })).toBe('expected-auth');
    expect(classifyDocumentRedirect({
      requestedUrl: 'https://app.example/',
      landedUrl: 'https://app.example/?mode=signup',
    })).toBe('expected-auth');
    expect(isPageVisitFlow({
      name: 'Visit Homepage',
      steps: [{ action: 'Visit the homepage' }],
    })).toBe(true);
    expect(isPageVisitFlow({
      name: 'Submit the order',
      steps: [{ action: 'Click Submit' }],
    })).toBe(false);
  });

  it('does not treat cross-origin, error pages, loops, or HTTP errors as a pass', () => {
    expect(classifyDocumentRedirect({
      requestedUrl: 'https://app.example/',
      landedUrl: 'https://accounts.google.com/signin',
    })).toBe('cross-origin');
    expect(classifyDocumentRedirect({
      requestedUrl: 'https://app.example/',
      landedUrl: 'https://app.example/notfound',
      statuses: [200],
    })).toBe('error-page');
    expect(classifyDocumentRedirect({
      requestedUrl: 'https://app.example/',
      landedUrl: 'https://app.example/missing',
      statuses: [404],
    })).toBe('http-error');
    expect(classifyDocumentRedirect({
      requestedUrl: 'https://app.example/a',
      landedUrl: 'https://app.example/a',
      statuses: [500],
      chain: ['https://app.example/a', 'https://app.example/b', 'https://app.example/a'],
    })).toBe('loop');
    expect(classifyDocumentRedirect({
      requestedUrl: 'https://app.example/',
      landedUrl: 'https://www.app.example/',
    })).toBe('not-redirect');
  });
});

describe('Visit Homepage redirect', () => {
  it('passes a same-origin client redirect to /signin and counts that page as public', async () => {
    const site = await startRedirectSite();
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-auth-redirect-'));
    try {
      const siteMap = await explore(site.url, llm, { maxPages: 1, headless: true });
      expect(siteMap.pages.map(page => page.url).some(url => url.includes('/signin'))).toBe(true);
      expect(siteMap.pages.every(page => page.authGated === false)).toBe(true);
      expect(countPublicScreens(siteMap.pages)).toBe(siteMap.pages.length);

      const plan = visitPlan(site.url);
      const raw = await runPlan(plan, llm, {
        screenshotsDir: shots,
        headless: true,
        recordVideo: false,
        strictOracles: true,
        failOn5xx: true,
        stepTimeoutMs: 8_000,
      });
      const run = triage(raw);
      expect(run.bugs).toEqual([]);
      expect(run.flows[0].status).toBe('passed');
      expect(run.suggestions?.some(item => item.kind === 'auth-redirect')).toBe(true);
    } finally {
      await site.close();
    }
  }, 30_000);

  it('still fails a visit that lands on a cross-origin login or an error page', async () => {
    const site = await startRedirectSite();
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-auth-redirect-bad-'));
    try {
      const away = visitPlan(`${site.url}/away`, 'visit-away');
      const missing = visitPlan(`${site.url}/missing`, 'visit-missing');
      const raw = await runPlan({ ...away, flows: [...away.flows, ...missing.flows] }, llm, {
        screenshotsDir: shots,
        headless: true,
        recordVideo: false,
        strictOracles: true,
        failOn5xx: true,
        stepTimeoutMs: 8_000,
      });
      const run = triage(raw);
      expect(run.flows.every(flow => flow.status !== 'passed')).toBe(true);
      expect(run.bugs.length).toBeGreaterThan(0);
      expect(run.suggestions?.some(item => item.kind === 'auth-redirect')).toBeFalsy();
    } finally {
      await site.close();
    }
  }, 30_000);
});

function visitPlan(startUrl: string, id = 'visit-homepage'): TestPlan {
  const flow: TestFlow = {
    id,
    name: 'Visit Homepage',
    description: 'Open the homepage.',
    kind: 'happy_path',
    startUrl,
    steps: [{ action: 'Visit the homepage', expectation: 'The homepage stays open.' }],
    expectation: 'The homepage stays open.',
    outcomeCheck: { kind: 'url_unchanged' },
    severityIfFails: 'major',
  };
  return { startUrl, siteType: 'app', flows: [flow] };
}

function startRedirectSite(): Promise<{ url: string; close: () => Promise<void> }> {
  let server: Server;
  const pending = new Promise<{ url: string; close: () => Promise<void> }>((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const port = (server.address() && typeof server.address() === 'object') ? server.address()!.port : 0;
      if (url.pathname === '/away') {
        res.writeHead(302, { location: `http://127.0.0.1:${port + 1}/login` });
        res.end();
        return;
      }
      if (url.pathname === '/missing') {
        res.writeHead(302, { location: '/notfound' });
        res.end();
        return;
      }
      if (url.pathname === '/notfound') {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<!doctype html><html lang="en"><title>Not found</title><body><h1>Not found</h1></body></html>');
        return;
      }
      if (url.pathname === '/signin') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><html lang="en"><title>Sign in</title><body><h1>Sign in</h1><form><label>Email<input type="email"></label><label>Password<input type="password"></label><button>Sign in</button></form></body></html>');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><html lang="en"><title>Home</title><body><script>location.replace("/signin")</script></body></html>');
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('redirect site did not bind'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done, fail) => server.close(err => err ? fail(err) : done())),
      });
    });
  });
  return pending;
}
