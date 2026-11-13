/**
 * AbortSignal on executeAndTriage closes the browser and stops navigation.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Monkey } from '../src/monkey.js';
import { runPlan } from '../src/runner/index.js';
import type { LLM } from '../src/llm/index.js';
import type { TestPlan } from '../src/types.js';

function listen(handler: (url: string, close: Promise<void>) => void) {
  const server = createServer((req, res) => {
    const closed = new Promise<void>(resolve => {
      req.on('close', () => resolve());
    });
    handler(req.url || '/', closed);
    if (req.url === '/slow') return;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><p>Ready</p><a href="/slow">slow</a><a href="/later">later</a>');
  });
  return new Promise<{ origin: string; close: () => Promise<void> }>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        close: () => new Promise(done => {
          server.closeAllConnections();
          server.close(() => done());
        }),
      });
    });
  });
}

describe('cancelled runs', () => {
  it('closes the browser and stops further navigation when the signal aborts', async () => {
    const hits: string[] = [];
    let slowClosed = false;
    const app = await listen((url, closed) => {
      hits.push(url);
      if (url === '/slow') {
        void closed.then(() => { slowClosed = true; });
      }
    });
    const ac = new AbortController();
    const monkey = new Monkey({
      llm: {
        explorer: { provider: 'openai', apiKey: 'test-key-not-used', model: 'gpt-4o-mini' },
        planner: { provider: 'openai', apiKey: 'test-key-not-used', model: 'gpt-4o-mini' },
      },
    });
    const pending = monkey.executeAndTriage(`${app.origin}/slow`, {
      signal: ac.signal,
      explore: { maxPages: 3, pageTimeoutMs: 20_000 },
      run: { screenshotsDir: mkdtempSync(join(tmpdir(), 'mt-cancel-')) },
    });
    const started = Date.now();
    while (!hits.includes('/slow') && Date.now() - started < 10_000) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(hits).toContain('/slow');
    ac.abort();
    const result = await pending;
    expect(result.siteMap.cancelled).toBe(true);
    expect(result.run.outcome).toBe('could_not_test');
    expect(result.run.outcome_reason).toBe('cancelled');
    expect(result.run.outcome_detail).toMatch(/cancelled/i);
    expect(result.plan.flows).toEqual([]);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(slowClosed).toBe(true);
    expect(hits.filter(url => url.startsWith('/later'))).toEqual([]);
    await app.close();
  }, 20_000);

  it('does not start a later flow after runPlan is aborted', async () => {
    const hits: string[] = [];
    const app = await listen(url => { hits.push(url); });
    const ac = new AbortController();
    const plan: TestPlan = {
      startUrl: `${app.origin}/slow`,
      siteType: 'app',
      flows: [
        {
          id: 'first',
          name: 'First',
          description: 'hang',
          kind: 'happy_path',
          startUrl: `${app.origin}/slow`,
          steps: [{ action: 'Look at the page' }],
          expectation: 'The page is visible',
          severityIfFails: 'minor',
        },
        {
          id: 'second',
          name: 'Second',
          description: 'must not run',
          kind: 'happy_path',
          startUrl: `${app.origin}/later`,
          steps: [{ action: 'Look at the next page' }],
          expectation: 'The next page is visible',
          severityIfFails: 'minor',
        },
      ],
    };
    const pending = runPlan(plan, { providerLabel: 'stub', async generateJSON() { return {}; } } as LLM, {
      screenshotsDir: mkdtempSync(join(tmpdir(), 'mt-cancel-run-')),
      signal: ac.signal,
      stepTimeoutMs: 20_000,
    });
    const started = Date.now();
    while (!hits.includes('/slow') && Date.now() - started < 10_000) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    ac.abort();
    const result = await pending;
    expect(result.outcome).toBe('could_not_test');
    expect(result.outcome_reason).toBe('cancelled');
    expect(hits.filter(url => url.startsWith('/later'))).toEqual([]);
    await app.close();
  }, 20_000);
});
