/**
 * A button click that resolves to a search field submits with Enter.
 * The same field with no form is an automation miss, not a site bug.
 * A real button is still clicked. Enter on a contact form stays blocked.
 *
 * The bananabeings false positive was a passed click on the text field,
 * then the planner's url_changed check. The URL stayed and the snapshot
 * did not change, so 0.7.1 filed a bug. That check must not run on a
 * button miss.
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LLM } from '../src/llm/index.js';
import { clickAsksForButton } from '../src/runner/actions.js';
import { judgeUnchangedUrlEvidence } from '../src/outcome/check.js';
import { replayTraces } from '../src/runner/replay.js';
import { runPlan } from '../src/runner/index.js';
import { triage } from '../src/triager/index.js';
import type { TestPlan } from '../src/types.js';

const llm: LLM = {
  providerLabel: 'stub',
  async generateJSON({ prompt }) {
    const text = String(prompt);
    if (/submit/i.test(text)) {
      return { tool: 'click', locator: 'role', target: 'button:Submit', rationale: 'Submit the form.' };
    }
    return { tool: 'click', locator: 'role', target: 'button:Search', rationale: 'Search.' };
  },
};

describe('button intent on a text field', () => {
  it('recognises a button or Search/Submit/Go click', () => {
    expect(clickAsksForButton('Click button Search')).toBe(true);
    expect(clickAsksForButton('Click "Submit"')).toBe(true);
    expect(clickAsksForButton('Click "Go"')).toBe(true);
    expect(clickAsksForButton('Fill the "Search" field')).toBe(false);
    expect(clickAsksForButton('Click "Email"')).toBe(false);
  });

  it('keeps an unchanged URL inconclusive when the page changed, and a bug when it did not', () => {
    const stayed = judgeUnchangedUrlEvidence({
      startUrl: 'https://shop.example/search',
      url: 'https://shop.example/search',
      beforeSignal: 'Search',
      afterSignal: 'Search results',
      visibleError: false,
    });
    expect(stayed.kind).toBe('inconclusive');
    const frozen = judgeUnchangedUrlEvidence({
      startUrl: 'https://shop.example/search',
      url: 'https://shop.example/search',
      beforeSignal: 'Advisory board',
      afterSignal: 'Advisory board',
      visibleError: false,
    });
    expect(frozen.kind).toBe('failed');
  });

  it('submits a search field with Enter and passes the URL check, live and on replay', async () => {
    const site = await startSite();
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-search-enter-'));
    try {
      const live = triage(await runPlan(plan(site.url, '/form', 'search-enter', 'Click button Search'), llm, opts(shots)));
      expect(live.bugs).toEqual([]);
      expect(live.flows[0].status).toBe('passed');
      const click = live.flows[0].steps.find(step => /search/i.test(step.action));
      expect(click?.status).toBe('passed');
      expect(click?.observation).toMatch(/button was absent/i);
      expect(click?.observation).toMatch(/submitted via Enter/i);
      expect(live.flows[0].trace?.steps.some(step => step.urlAfter?.includes('/search?q=hats'))).toBe(true);

      const replayed = triage(await replayTraces(live.flows.map(flow => flow.trace!), opts(shots)));
      expect(replayed.bugs).toEqual([]);
      expect(replayed.flows[0].status).toBe('passed');
      expect(replayed.flows[0].steps.some(step => /submitted via Enter/i.test(step.observation))).toBe(true);
    } finally {
      await site.close();
    }
  }, 30_000);

  it('is inconclusive when the search field is not in a form, and url_changed does not file a bug', async () => {
    const site = await startSite();
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-search-loose-'));
    try {
      const live = triage(await runPlan(plan(site.url, '/loose', 'search-loose', 'Click button Search'), llm, opts(shots)));
      expect(live.bugs).toEqual([]);
      expect(live.flows[0].status).toBe('inconclusive');
      expect(live.flows[0].outcome_reason).toBe('automation_error');
      expect(live.flows[0].steps.some(step => step.error === 'locator_mismatch')).toBe(true);
      expect(live.outcome).not.toBe('bugs_found');

      const replayed = triage(await replayTraces(live.flows.map(flow => flow.trace!), opts(shots)));
      expect(replayed.bugs).toEqual([]);
      expect(replayed.flows[0].status).toBe('inconclusive');
      expect(replayed.flows[0].outcome_reason).toBe('automation_error');
    } finally {
      await site.close();
    }
  }, 30_000);

  it('clicks a real Search button and does not press Enter on the field', async () => {
    const site = await startSite();
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-search-button-'));
    try {
      const live = triage(await runPlan(plan(site.url, '/button', 'search-button', 'Click "Search"'), llm, opts(shots)));
      expect(live.bugs).toEqual([]);
      const click = live.flows[0].steps.find(step => /search/i.test(step.action));
      expect(click?.status).toBe('passed');
      expect(click?.observation || '').not.toMatch(/submitted via Enter/i);
      expect(click?.observation).toMatch(/button:Search/i);
      expect(live.flows[0].status).toBe('inconclusive');
      const outcome = live.flows[0].steps.find(step => /expected outcome/i.test(step.action));
      expect(outcome?.observation).toMatch(/page changed/i);
      expect(outcome?.observation).not.toMatch(/did not change/i);
    } finally {
      await site.close();
    }
  }, 30_000);

  it('blocks a contact form when the button click becomes Enter', async () => {
    const site = await startSite();
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-search-contact-'));
    try {
      const live = triage(await runPlan(plan(site.url, '/contact', 'contact-enter', 'Click button Submit'), llm, {
        ...opts(shots),
        allowSensitive: ['signup', 'reset', 'otp', 'newsletter', 'payment', 'deletion'],
      }));
      expect(site.posts['/api/contact'] || []).toEqual([]);
      expect(live.bugs).toEqual([]);
      expect(live.flows[0].status).toBe('inconclusive');
      expect(live.flows[0].status).not.toBe('passed');
      expect(live.flows[0].outcome_reason).toBe('contact_submit_blocked');
      expect(live.flows[0].steps.some(step => step.error === 'sensitive-submit')).toBe(true);

      const replayed = triage(await replayTraces(live.flows.map(flow => flow.trace!), {
        ...opts(shots),
        allowSensitive: ['signup', 'reset', 'otp', 'newsletter', 'payment', 'deletion'],
      }));
      expect(site.posts['/api/contact'] || []).toEqual([]);
      expect(replayed.bugs).toEqual([]);
      expect(replayed.flows[0].status).toBe('inconclusive');
      expect(replayed.flows[0].outcome_reason).toBe('contact_submit_blocked');
    } finally {
      await site.close();
    }
  }, 30_000);
});

function plan(origin: string, path: string, id: string, action: string): TestPlan {
  const startUrl = `${origin}${path}`;
  return {
    startUrl,
    siteType: 'fixture',
    flows: [{
      id,
      name: id,
      description: action,
      kind: 'happy_path',
      startUrl,
      steps: [{ action, expectation: 'The page responds.' }],
      expectation: 'The URL changes.',
      outcomeCheck: { kind: 'url_changed' },
      severityIfFails: 'major',
    }],
  };
}

function opts(screenshotsDir: string) {
  return {
    screenshotsDir,
    headless: true,
    recordVideo: false,
    strictOracles: true,
    failOn5xx: true,
    stepTimeoutMs: 8_000,
  };
}

function startSite(): Promise<{ url: string; posts: Record<string, string[]>; close: () => Promise<void> }> {
  const posts: Record<string, string[]> = {};
  let server: Server;
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        req.on('data', chunk => chunks.push(Buffer.from(chunk)));
        req.on('end', () => {
          const list = posts[url.pathname] || [];
          list.push(Buffer.concat(chunks).toString('utf8'));
          posts[url.pathname] = list;
          res.writeHead(204);
          res.end();
        });
        return;
      }
      const page = pages[url.pathname] || pages['/missing'];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(page);
    });
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fixture did not bind'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        posts,
        close: () => new Promise((done, fail) => server.close(err => err ? fail(err) : done())),
      });
    });
  });
}

const pages: Record<string, string> = {
  '/form': `<!doctype html><html lang="en"><body>
    <form action="/search" method="get">
      <input type="search" name="q" value="hats" aria-label="Search">
    </form>
  </body></html>`,
  '/search': `<!doctype html><html lang="en"><body><h1>Results for hats</h1></body></html>`,
  '/loose': `<!doctype html><html lang="en"><body>
    <input type="search" aria-label="Search" value="hats">
  </body></html>`,
  '/button': `<!doctype html><html lang="en"><body>
    <form>
      <input type="search" aria-label="Query" value="hats">
      <button type="button" id="go">Search</button>
    </form>
    <div id="out"></div>
    <script>
      document.getElementById('go').onclick = () => { document.getElementById('out').textContent = '3 homes'; };
    </script>
  </body></html>`,
  '/contact': `<!doctype html><html lang="en"><body>
    <form method="post" action="/api/contact">
      <label for="email">Submit</label>
      <input id="email" name="email" type="email" value="person@example.com">
      <textarea name="message">Hello from the form</textarea>
    </form>
  </body></html>`,
  '/missing': `<!doctype html><html lang="en"><body><h1>Missing</h1></body></html>`,
};
