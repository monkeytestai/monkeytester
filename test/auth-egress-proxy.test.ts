/**
 * Hosted signed-in traffic must use an explicit Playwright proxy.
 * route.fetch and context.request ignore HTTPS_PROXY. Owned fixtures only.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { createServer as createNet, type Server as NetServer, connect as netConnect } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createAuthProvider, runPlan } from '../src/index.js';
import { launchFencedBrowser, proxyForBrowser, setEgressLookupForTests } from '../src/auth/egress.js';
import { openFencedContext } from '../src/auth/browser.js';
import { describeEgressProxy, EGRESS_PROXY_BYPASS, resolveEgressProxy } from '../src/auth/proxy.js';
import type { AuthStorageState } from '../src/auth/contract.js';
import type { LLM } from '../src/llm/index.js';
import type { TestPlan } from '../src/types.js';

const USER = 'proxy-user-canary';
const SECRET = 'proxy-secret-canary-9f3a';
const HOST = 'mtai-egress-canary.test';
const CANARY_IP = '10.254.254.1';
const PUBLIC_PIN = '93.184.216.34';
const HOSTS_MARK = 'mtai-egress-proxy-test';

const savedEnv = process.env.MTAI_EGRESS_PROXY;
const savedDebug = process.env.DEBUG;
const savedPw = process.env.PWDEBUG;

afterEach(() => {
  if (savedEnv === undefined) delete process.env.MTAI_EGRESS_PROXY;
  else process.env.MTAI_EGRESS_PROXY = savedEnv;
  if (savedDebug === undefined) delete process.env.DEBUG;
  else process.env.DEBUG = savedDebug;
  if (savedPw === undefined) delete process.env.PWDEBUG;
  else process.env.PWDEBUG = savedPw;
  setEgressLookupForTests(undefined);
});

function silenceDebug(): void {
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
}

function listen(server: NetServer, host: string, port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('no port'));
        return;
      }
      resolve(address.port);
    });
  });
}

describe('egress proxy configuration', () => {
  it('lets the option win and keeps credentials out of errors', () => {
    process.env.MTAI_EGRESS_PROXY = `http://env-user:env-${SECRET}@127.0.0.1:1`;
    const chosen = resolveEgressProxy(`http://${USER}:${SECRET}@127.0.0.1:9`);
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    expect(chosen.proxy?.server).toBe('http://127.0.0.1:9');
    expect(chosen.proxy?.bypass).toBe(EGRESS_PROXY_BYPASS);
    expect(chosen.proxy?.bypass.startsWith('<-loopback>')).toBe(true);
    expect(chosen.proxy?.username).toBe(USER);
    expect(chosen.proxy?.password).toBe(SECRET);
    expect(describeEgressProxy(chosen.proxy!)).toBe('http://127.0.0.1:9');
    expect(describeEgressProxy(chosen.proxy!)).not.toContain(SECRET);
    expect(describeEgressProxy(chosen.proxy!)).not.toContain(USER);

    const cleared = resolveEgressProxy('');
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.proxy).toBeUndefined();

    const invalid = resolveEgressProxy(`http://${USER}:${SECRET}@127.0.0.1:9/extra`);
    expect(invalid.ok).toBe(false);
    const rendered = JSON.stringify(invalid);
    expect(rendered).not.toContain(SECRET);
    expect(rendered).not.toContain(USER);
    expect(rendered).not.toContain('127.0.0.1:9/extra');

    const provider = createAuthProvider({
      mode: 'hosted_credentials',
      targetOrigin: 'https://example.com',
      username: 'person@example.com',
      password: SECRET,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      postLoginUrl: '/home',
      egressProxy: `http://${USER}:${SECRET}@127.0.0.1:9`,
    });
    expect(JSON.stringify(provider)).not.toContain(SECRET);
    expect(JSON.stringify(provider)).not.toContain(USER);
    provider.release();
  });

  it('fails a hosted run closed before navigation when no proxy is configured', async () => {
    const trapHits: string[] = [];
    const trap = createHttp((req, res) => {
      trapHits.push(req.url || '');
      res.writeHead(500);
      res.end();
    });
    const trapPort = await listen(trap, '127.0.0.1');
    const logs: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logs.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return stdout(chunk as never, ...(rest as never[]));
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logs.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return stderr(chunk as never, ...(rest as never[]));
    }) as typeof process.stderr.write;
    process.env.MTAI_EGRESS_PROXY = `http://${USER}:${SECRET}@127.0.0.1:${trapPort}`;
    silenceDebug();
    try {
      const launch = await launchFencedBrowser({
        policy: { targetOrigin: `https://${PUBLIC_PIN}`, idpOrigins: [] },
        egressProxy: '',
      });
      expect(launch.ok).toBe(false);
      if (launch.ok) return;
      expect(launch.outcome).toBe('egress_proxy_required');
      expect(launch.detail).not.toContain(SECRET);
      expect(launch.detail).not.toContain(USER);

      const plan: TestPlan = {
        startUrl: `https://${PUBLIC_PIN}/`,
        siteType: 'app',
        flows: [{
          id: 'visit',
          name: 'Visit',
          description: 'open',
          kind: 'happy_path',
          startUrl: `https://${PUBLIC_PIN}/`,
          steps: [{ action: 'Look at the page' }],
          expectation: 'The page is visible',
          severityIfFails: 'minor',
        }],
      };
      const result = await runPlan(plan, { providerLabel: 'stub', async generateJSON() { return {}; } } as LLM, {
        screenshotsDir: mkdtempSync(join(tmpdir(), 'mt-proxy-required-')),
        egressProxy: '',
        authOrigin: { targetOrigin: `https://${PUBLIC_PIN}`, idpOrigins: [] },
        storageState: {
          cookies: [{
            name: 'session', value: 'fixture-session', domain: PUBLIC_PIN, path: '/',
            expires: -1, httpOnly: true, secure: true, sameSite: 'Lax',
          }],
          origins: [],
        },
      });
      expect(result.outcome).toBe('could_not_test');
      expect(result.outcome_reason).toBe('auth_egress_proxy_required');
      expect(result.auth?.outcome).toBe('egress_proxy_required');
      expect(result.auth?.status).toBe('egress_proxy_required');
      expect(result.flows).toEqual([]);
      expect(trapHits).toEqual([]);
      const blob = `${logs.join('\n')}\n${JSON.stringify(result)}`;
      expect(blob).not.toContain(SECRET);
      expect(blob).not.toContain(USER);
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      await new Promise<void>(resolve => trap.close(() => resolve()));
    }
  });
});

describe('proxied hosted egress', () => {
  it('sends fence fetch, page fetch, and page websocket through the proxy and not to the private canary', async () => {
    silenceDebug();
    const logs: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    const wrap = (original: typeof process.stdout.write) => ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logs.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return original(chunk as never, ...(rest as never[]));
    }) as typeof process.stdout.write;
    process.stdout.write = wrap(stdout);
    process.stderr.write = wrap(stderr);
    const consoleMethods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const savedConsole = Object.fromEntries(consoleMethods.map(name => [name, console[name].bind(console)]));
    for (const name of consoleMethods) {
      console[name] = (...args: unknown[]) => {
        logs.push(args.map(item => String(item)).join(' '));
        savedConsole[name](...args);
      };
    }

    let removeAddress = () => {};
    let restoreHosts = () => {};
    const closers: Array<() => Promise<void>> = [];
    const close = (server: { close: (cb: () => void) => void; closeAllConnections?: () => void }) => {
      closers.push(() => new Promise(resolve => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }));
    };
    const ip = ['/usr/sbin/ip', '/sbin/ip'].find(candidate => existsSync(candidate)) ?? 'ip';
    const root = process.getuid?.() === 0;
    const run = (bin: string, args: string[]) => {
      const opts = { stdio: 'ignore' as const };
      if (root) execFileSync(bin, args, opts);
      else execFileSync('sudo', ['-n', bin, ...args], opts);
    };
    try {
      try {
        run(ip, ['link', 'add', 'mtai-canary', 'type', 'dummy']);
        run(ip, ['addr', 'add', `${CANARY_IP}/32`, 'dev', 'mtai-canary']);
        run(ip, ['link', 'set', 'mtai-canary', 'up']);
        removeAddress = () => { try { run(ip, ['link', 'del', 'mtai-canary']); } catch { /* already gone */ } };
      } catch {
        run(ip, ['addr', 'replace', `${CANARY_IP}/32`, 'dev', 'lo']);
        removeAddress = () => { try { run(ip, ['addr', 'del', `${CANARY_IP}/32`, 'dev', 'lo']); } catch { /* already gone */ } };
      }

      const hostsPath = '/etc/hosts';
      const originalHosts = readFileSync(hostsPath, 'utf8');
      const hostsFile = join(tmpdir(), `mtai-hosts-${process.pid}`);
      const line = `${CANARY_IP} ${HOST} # ${HOSTS_MARK}`;
      writeFileSync(hostsFile, originalHosts.endsWith('\n') ? `${originalHosts}${line}\n` : `${originalHosts}\n${line}\n`);
      run('/bin/cp', [hostsFile, hostsPath]);
      restoreHosts = () => {
        writeFileSync(hostsFile, originalHosts);
        run('/bin/cp', [hostsFile, hostsPath]);
      };
      const records = await lookup(HOST, { all: true, verbatim: true });
      expect(records.map(record => record.address)).toContain(CANARY_IP);

      let canaryHits = 0;
      const canary = createNet(socket => {
        canaryHits += 1;
        socket.destroy();
      });
      const port = await listen(canary, CANARY_IP);
      close(canary);

      const dir = mkdtempSync(join(tmpdir(), 'mt-egress-proxy-'));
      const keyPath = join(dir, 'key.pem');
      const certPath = join(dir, 'cert.pem');
      execFileSync('openssl', [
        'req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath,
        '-days', '1', '-nodes', '-subj', `/CN=${HOST}`,
      ], { stdio: 'ignore' });
      const appPaths: string[] = [];
      const tls = createHttps({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
        appPaths.push(req.url || '');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><p id="ready">Ready</p>');
      });
      tls.on('upgrade', (req, socket) => {
        appPaths.push(`upgrade ${req.url || ''}`);
        const key = String(req.headers['sec-websocket-key'] || '');
        const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n'));
        socket.end();
      });
      await listen(tls, '127.0.0.1', port);
      close(tls);

      const seen: string[] = [];
      const proxy = createHttp((req: IncomingMessage, res: ServerResponse) => {
        seen.push(`${req.method || 'GET'} ${req.url || ''}`);
        res.writeHead(403);
        res.end();
      });
      proxy.on('connect', (req: IncomingMessage, socket, head) => {
        const target = req.url || '';
        seen.push(`CONNECT ${target}`);
        const host = target.split(':')[0];
        if (host !== HOST) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.end();
          return;
        }
        const upstream = netConnect(port, '127.0.0.1', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head?.length) upstream.write(head);
          socket.pipe(upstream);
          upstream.pipe(socket);
        });
        upstream.on('error', () => socket.end());
        socket.on('error', () => upstream.destroy());
      });
      const proxyPort = await listen(proxy, '127.0.0.1');
      close(proxy);

      setEgressLookupForTests(async () => [PUBLIC_PIN]);
      const origin = `https://${HOST}:${port}`;
      const jar: AuthStorageState = {
        cookies: [{
          name: 'session', value: 'fixture-session', domain: HOST, path: '/',
          expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: true, sameSite: 'Lax',
        }],
        origins: [],
      };
      const launched = await launchFencedBrowser({
        headless: true,
        policy: { targetOrigin: origin, idpOrigins: [] },
        egressProxy: `http://${USER}:${encodeURIComponent(SECRET)}@127.0.0.1:${proxyPort}`,
      });
      expect(launched.ok).toBe(true);
      if (!launched.ok) return;
      expect(launched.proxy?.server).toBe(`http://127.0.0.1:${proxyPort}`);
      expect(launched.proxy?.bypass).toBe(EGRESS_PROXY_BYPASS);
      expect(proxyForBrowser(launched.browser)?.server).not.toContain(SECRET);
      const context = await openFencedContext(launched.browser, {
        storageState: jar,
        authOrigin: { targetOrigin: origin, idpOrigins: [] },
        egressPin: launched.pin,
        ignoreHTTPSErrors: true,
        viewport: { width: 1280, height: 800 },
      });
      try {
        const page = await context.newPage();
        page.setDefaultTimeout(8_000);
        const response = await page.goto(origin + '/', { waitUntil: 'domcontentloaded', timeout: 15_000 });
        expect(response?.status()).toBe(200);
        const probed: Record<string, string> = {};
        probed.pageFetch = await page.evaluate(async () => {
          try {
            const res = await fetch(`${location.origin}/via-page-fetch`);
            return String(res.status);
          } catch { return 'error'; }
        });
        probed.privateFetch = await page.evaluate(async (privateOrigin) => {
          try {
            const res = await fetch(`${privateOrigin}/direct`);
            return String(res.status);
          } catch { return 'denied'; }
        }, `https://${CANARY_IP}:${port}`);
        probed.privateWs = await page.evaluate(async (privateOrigin) => {
          return await new Promise(resolve => {
            let settled = false;
            const finish = (value: string) => { if (!settled) { settled = true; resolve(value); } };
            try {
              const ws = new WebSocket(`${privateOrigin.replace(/^https/, 'wss')}/ws`);
              ws.addEventListener('open', () => finish('open'));
              ws.addEventListener('error', () => finish('denied'));
              ws.addEventListener('close', () => finish('closed'));
              setTimeout(() => finish('timeout'), 1500);
            } catch { finish('denied'); }
          });
        }, `https://${CANARY_IP}:${port}`);
        probed.sameWs = await page.evaluate(async (sameWs) => {
          return await new Promise(resolve => {
            let settled = false;
            const finish = (value: string) => { if (!settled) { settled = true; resolve(value); } };
            try {
              const ws = new WebSocket(sameWs);
              ws.addEventListener('open', () => finish('open'));
              ws.addEventListener('error', () => finish('error'));
              ws.addEventListener('close', () => finish('closed'));
              setTimeout(() => finish('timeout'), 2000);
            } catch { finish('error'); }
          });
        }, `wss://${HOST}:${port}/ws`);
        const api = await context.request.get(`${origin}/via-context-request`, { timeout: 8_000 });
        expect(api.status()).toBe(200);
        expect(probed.pageFetch).toBe('200');
        expect(probed.privateFetch).toBe('denied');
        expect(['closed', 'denied', 'error', 'timeout']).toContain(probed.privateWs);
        expect(appPaths).toContain('/');
        expect(appPaths).toContain('/via-page-fetch');
        expect(appPaths).toContain('/via-context-request');
        expect(seen.some(line => line.startsWith(`CONNECT ${HOST}:${port}`))).toBe(true);
        expect(seen.some(line => line.includes(CANARY_IP))).toBe(false);
        expect(canaryHits).toBe(0);
        expect(probed.sameWs === 'open' || probed.sameWs === 'error' || probed.sameWs === 'closed' || probed.sameWs === 'timeout').toBe(true);
      } finally {
        // close() waits on open proxy tunnels and does not return.
        void context.close().catch(() => {});
        void launched.browser.close().catch(() => {});
      }
      const blob = `${logs.join('\n')}\n${seen.join('\n')}\n${appPaths.join('\n')}`;
      expect(blob).not.toContain(SECRET);
      expect(blob).not.toContain(USER);
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
      for (const name of consoleMethods) console[name] = savedConsole[name] as typeof console.log;
      setEgressLookupForTests(undefined);
      for (const closer of closers.reverse()) {
        await Promise.race([
          closer().catch(() => {}),
          new Promise(resolve => setTimeout(resolve, 250)),
        ]);
      }
      restoreHosts();
      removeAddress();
    }
  }, 30_000);

  it('keeps a loopback target off the proxy', async () => {
    silenceDebug();
    let proxyHits = 0;
    const proxy = createHttp((_req, res) => {
      proxyHits += 1;
      res.writeHead(403);
      res.end();
    });
    proxy.on('connect', (_req, socket) => {
      proxyHits += 1;
      socket.end();
    });
    const proxyPort = await listen(proxy, '127.0.0.1');
    const app = createHttp((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><p>Local</p>');
    });
    const appPort = await listen(app, '127.0.0.1');
    const logs: string[] = [];
    const stderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
      logs.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      return stderr(chunk as never, ...(rest as never[]));
    }) as typeof process.stderr.write;
    try {
      const launched = await launchFencedBrowser({
        egressProxy: `http://${USER}:${SECRET}@127.0.0.1:${proxyPort}`,
      });
      expect(launched.ok).toBe(true);
      if (!launched.ok) return;
      const context = await openFencedContext(launched.browser, {});
      try {
        const page = await context.newPage();
        const response = await page.goto(`http://127.0.0.1:${appPort}/`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
        expect(response?.status()).toBe(200);
        expect(proxyHits).toBe(0);
        expect(logs.join('\n')).not.toContain(SECRET);
      } finally {
        await context.close().catch(() => {});
        await launched.browser.close().catch(() => {});
      }
    } finally {
      process.stderr.write = stderr;
      await new Promise<void>(resolve => proxy.close(() => resolve()));
      await new Promise<void>(resolve => app.close(() => resolve()));
    }
  }, 30_000);
});
