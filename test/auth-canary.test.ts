/**
 * Canary credentials must not appear in prompts, events, stdout, stderr,
 * or files written by a signed-in local run. The values are synthetic.
 */

import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventBus } from '../src/events.js';
import { explore } from '../src/explorer/index.js';
import type { LLM } from '../src/llm/index.js';
import { saveRun } from '../src/persistence/index.js';
import { runPlan } from '../src/runner/index.js';
import { createMemorySecretProvider, establishFormAuth } from '../src/index.js';
import type { TestPlan } from '../src/types.js';

const USER = 'canary-user-9f3a7c2e1b@example.test';
const PASSWORD = 'canary-pass-6d4e8a1c0f';
const COOKIE = 'canary-cookie-5b7e9d3a2c';
const ROTATED = 'canary-rotated-8c1d4e7a6b';

function forms(secret: string): string[] {
  const encoded = encodeURIComponent(secret);
  const b64 = Buffer.from(secret, 'utf8').toString('base64');
  const b64url = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return [...new Set([secret, encoded, encodeURIComponent(encoded), b64, b64url])];
}

function leakKind(text: string): string | undefined {
  for (const secret of [USER, PASSWORD, COOKIE, ROTATED]) {
    if (forms(secret).some(form => form.length >= 4 && text.includes(form))) return 'canary';
  }
  return undefined;
}

function listen(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void) {
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

describe('canary credentials stay out of sinks', () => {
  let origin = '';
  let close: () => Promise<void> = async () => {};

  beforeAll(async () => {
    const app = await listen(async (req, res) => {
      const url = new URL(req.url || '/', origin);
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      if (req.method === 'POST' && url.pathname === '/login') {
        res.writeHead(302, {
          location: '/app',
          'set-cookie': `session=${COOKIE}; HttpOnly; Path=/`,
        });
        res.end();
        return;
      }
      if (url.pathname === '/login') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><form method="post" action="/login"><input name="email" type="email"><input name="password" type="password"><button type="submit">Sign in</button></form>');
        return;
      }
      if (url.pathname === '/app') {
        res.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': `rotated=${ROTATED}; Path=/`,
        });
        res.end(`<!doctype html><title>Signed in ${Buffer.from(PASSWORD).toString('base64')}</title><h1>Signed in ${encodeURIComponent(PASSWORD)}</h1><p id="ready">Signed in ${USER} ${COOKIE} ${ROTATED}</p>`);
        return;
      }
      res.writeHead(404);
      res.end();
    });
    origin = app.origin;
    close = app.close;
  });

  afterAll(async () => { await close(); });

  it('scrubs raw and encoded canaries from the local signed-in flow', async () => {
    const prompts: string[] = [];
    const events: string[] = [];
    const output: string[] = [];
    const stdout = process.stdout.write.bind(process.stdout);
    const stderr = process.stderr.write.bind(process.stderr);
    const push = (chunk: string | Uint8Array) => {
      output.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    };
    process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error | null) => void) => {
      push(chunk);
      return stdout(chunk, encoding as BufferEncoding, cb);
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error | null) => void) => {
      push(chunk);
      return stderr(chunk, encoding as BufferEncoding, cb);
    }) as typeof process.stderr.write;
    const bus = new EventBus();
    bus.on(event => {
      events.push(JSON.stringify(event));
    });
    const llm = {
      providerLabel: 'stub',
      async generateJSON(opts: { prompt: string; system?: string; cacheable?: string }) {
        prompts.push(`${opts.system || ''}\n${opts.cacheable || ''}\n${opts.prompt}`);
        return {
          tool: 'noop',
          target: 'page',
          rationale: 'stay',
          siteType: 'app',
          summary: 'Synthetic page.',
          authGated: false,
          interactive: [],
        };
      },
    } as LLM;
    const dir = mkdtempSync(join(tmpdir(), 'mt-canary-'));
    try {
      const auth = await establishFormAuth({
        targetUrl: `${origin}/login`,
        provider: createMemorySecretProvider({ username: USER, password: PASSWORD }),
        headless: true,
        postLoginSelector: '#ready',
      });
      expect(auth.ok).toBe(true);
      if (!auth.ok) return;
      expect(leakKind(JSON.stringify(auth.metadata))).toBeUndefined();
      const plan: TestPlan = {
        startUrl: `${origin}/app`,
        siteType: 'app',
        flows: [{
          id: 'visit',
          name: 'Visit',
          description: 'open',
          kind: 'happy_path',
          startUrl: `${origin}/app`,
          steps: [{ action: 'Look at the signed-in page' }],
          expectation: 'The ready marker is visible',
          outcomeCheck: { kind: 'text_visible', value: 'Signed in' },
          severityIfFails: 'minor',
        }],
      };
      const explored = await explore(`${origin}/app`, llm, {
        maxPages: 1,
        headless: true,
        pageTimeoutMs: 8_000,
        storageState: auth.storageState,
        authOrigin: auth.authOrigin,
        events: bus,
      });
      const run = await runPlan(plan, llm, {
        screenshotsDir: join(dir, 'shots'),
        headless: true,
        recordVideo: false,
        storageState: auth.storageState,
        authOrigin: auth.authOrigin,
        events: bus,
      });
      saveRun(run, { dir, engine: 'canary-test' });
      const files = readdirSync(dir, { recursive: true }).flatMap(entry => {
        const path = join(dir, String(entry));
        return statSync(path).isFile() ? [readFileSync(path, 'utf8')] : [];
      });
      const blob = [
        JSON.stringify(explored),
        JSON.stringify(run),
        prompts.join('\n'),
        events.join('\n'),
        output.join('\n'),
        files.join('\n'),
      ].join('\n');
      expect(leakKind(blob)).toBeUndefined();
      expect(prompts.some(prompt => prompt.includes('Signed in'))).toBe(true);
      expect(prompts.some(prompt => prompt.includes('[redacted]'))).toBe(true);
      expect(run.auth?.outcome).toBe('authenticated');
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
  });
});
