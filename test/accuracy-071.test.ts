/**
 * 0.7.1-beta.1 false-positive fixes from prod runs.
 *
 * Non-HTML documents skip axe and metadata. An unchanged URL is inconclusive
 * unless something else shows the action failed. A sitemap-only 404 is minor.
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { shouldRunPageLevelChecks, urlLooksNonHtml } from '../src/checks/html.js';
import { sitemapDocumentSeverity } from '../src/checks/http.js';
import { buildPageCheckFlows } from '../src/checks/plan.js';
import { enqueueLinks } from '../src/explorer/queue.js';
import { judgeUnchangedUrlEvidence } from '../src/outcome/check.js';
import { replayTraces } from '../src/runner/replay.js';
import { runPlan } from '../src/runner/index.js';
import { triage } from '../src/triager/index.js';
import type { LLM } from '../src/llm/index.js';
import type { SiteMap, SiteMapPage, TestFlow, TestPlan } from '../src/types.js';

const llm: LLM = {
  providerLabel: 'stub',
  async generateJSON() {
    throw new Error('these flows must not call a model');
  },
};

describe('non-HTML page checks', () => {
  it('runs axe and metadata only for HTML content types', () => {
    expect(shouldRunPageLevelChecks('text/html', 'https://shop.example/sitemaps/static.xml')).toBe(true);
    expect(shouldRunPageLevelChecks('text/html; charset=utf-8', 'https://shop.example/')).toBe(true);
    expect(shouldRunPageLevelChecks('application/xhtml+xml', 'https://shop.example/page')).toBe(true);
    expect(shouldRunPageLevelChecks('application/xml', 'https://shop.example/sitemaps/static.xml')).toBe(false);
    expect(shouldRunPageLevelChecks('text/xml; charset=utf-8', 'https://shop.example/feed')).toBe(false);
    expect(shouldRunPageLevelChecks('application/json', 'https://shop.example/data.json')).toBe(false);
    expect(shouldRunPageLevelChecks('text/plain', 'https://shop.example/notes.txt')).toBe(false);
    expect(shouldRunPageLevelChecks('image/png', 'https://shop.example/a.png')).toBe(false);
    expect(shouldRunPageLevelChecks('application/pdf', 'https://shop.example/file.pdf')).toBe(false);
    expect(shouldRunPageLevelChecks('application/rss+xml', 'https://shop.example/feed.rss')).toBe(false);
  });

  it('falls back to the URL when the response has no content-type', () => {
    const skip = [
      'https://shop.example/sitemaps/static.xml',
      'https://shop.example/sitemap',
      'https://shop.example/sitemap_index.xml',
      'https://shop.example/sitemaps/pages',
      'https://shop.example/data.json',
      'https://shop.example/notes.txt',
      'https://shop.example/feed.rss',
      'https://shop.example/feed.atom',
      'https://shop.example/file.pdf',
      'https://shop.example/a.png',
      'https://shop.example/a.jpg',
      'https://shop.example/a.jpeg',
      'https://shop.example/a.gif',
      'https://shop.example/a.webp',
      'https://shop.example/a.svg',
    ];
    for (const url of skip) {
      expect(urlLooksNonHtml(url)).toBe(true);
      expect(shouldRunPageLevelChecks(undefined, url)).toBe(false);
      expect(shouldRunPageLevelChecks('', url)).toBe(false);
    }
    expect(shouldRunPageLevelChecks(undefined, 'https://shop.example/housing')).toBe(true);
    expect(shouldRunPageLevelChecks(undefined, 'https://shop.example/about')).toBe(true);
  });
});

describe('unchanged URL', () => {
  const base = {
    startUrl: 'https://kiraayasense.com/search',
    url: 'https://kiraayasense.com/search',
    afterSignal: 'Search housing\n3 homes',
    visibleError: false,
  };

  it('is inconclusive when the page changed and nothing else failed', () => {
    const judged = judgeUnchangedUrlEvidence({ ...base, beforeSignal: 'Search housing' });
    expect(judged.kind).toBe('inconclusive');
    if (judged.kind === 'inconclusive') expect(judged.observation).toMatch(/inconclusive/);
  });

  it('is a failure when the DOM and field state did not change', () => {
    const judged = judgeUnchangedUrlEvidence({
      ...base,
      beforeSignal: 'Advisory board',
      afterSignal: 'Advisory board',
    });
    expect(judged.kind).toBe('failed');
    if (judged.kind === 'failed') expect(judged.observation).toMatch(/did not change/);
  });

  it('is a failure when an error, a console error, or a failed request corroborates it', () => {
    expect(judgeUnchangedUrlEvidence({ ...base, beforeSignal: 'Search', visibleError: true }).kind).toBe('failed');
    expect(judgeUnchangedUrlEvidence({
      ...base,
      beforeSignal: 'Search',
      consoleErrors: [{ message: 'search failed', level: 'error', url: 'https://kiraayasense.com/app.js' }],
    }).kind).toBe('failed');
    expect(judgeUnchangedUrlEvidence({
      ...base,
      beforeSignal: 'Search',
      networkFailures: [{ url: 'https://kiraayasense.com/api/search', method: 'GET', status: 500, resourceType: 'fetch' }],
    }).kind).toBe('failed');
  });

  it('ignores a third-party console error and an analytics beacon', () => {
    const judged = judgeUnchangedUrlEvidence({
      ...base,
      beforeSignal: 'Search housing',
      consoleErrors: [{ message: 'ads blew up', level: 'error', url: 'https://ads.example/tag.js' }],
      networkFailures: [{ url: 'https://kiraayasense.com/__l5e/trackevents', method: 'POST', status: 404, resourceType: 'fetch' }],
    });
    expect(judged.kind).toBe('inconclusive');
  });

  it('does not treat a URL that changed as an unchanged-URL miss', () => {
    expect(judgeUnchangedUrlEvidence({
      ...base,
      url: 'https://kiraayasense.com/search?q=house',
      beforeSignal: 'Search',
    }).kind).toBe('changed');
  });
});

describe('sitemap-only 404 severity', () => {
  const sitemap = ['https://temple.com/old-board'];

  it('caps a document 404 that was discovered only from a sitemap', () => {
    expect(sitemapDocumentSeverity(
      [{ url: 'https://temple.com/old-board', status: 404, resourceType: 'document' }],
      [],
      sitemap,
    )).toBe('minor');
    expect(sitemapDocumentSeverity(
      [
        { url: 'https://temple.com/old-board', status: 404, resourceType: 'document' },
        { url: 'https://temple.com/old-board/app.js', status: 404, resourceType: 'script' },
      ],
      [],
      sitemap,
    )).toBe('minor');
  });

  it('keeps a DOM link 404 at the check severity', () => {
    expect(sitemapDocumentSeverity(
      [],
      [{ url: 'https://temple.com/missing-from-nav' }],
      sitemap,
    )).toBeUndefined();
    expect(sitemapDocumentSeverity(
      [{ url: 'https://temple.com/old-board', status: 404, resourceType: 'document' }],
      [{ url: 'https://temple.com/missing-from-nav' }],
      sitemap,
    )).toBeUndefined();
    expect(sitemapDocumentSeverity(
      [{ url: 'https://temple.com/missing-from-nav', status: 404, resourceType: 'document' }],
      [],
      sitemap,
    )).toBeUndefined();
  });

  it('marks a queued sitemap URL as a page link once the DOM names it', () => {
    const queue = [{ url: 'https://shop.example/old', surface: false, fromSitemap: true }];
    enqueueLinks(queue, new Set(), [{ url: 'https://shop.example/old', text: 'Old' }], 0);
    expect(queue[0].fromSitemap).toBe(false);
    const fresh: typeof queue = [];
    enqueueLinks(fresh, new Set(), [{ url: 'https://shop.example/only-sitemap', fromSitemap: true }], 0);
    expect(fresh[0].fromSitemap).toBe(true);
  });

  it('copies sitemapOnly onto the HTTP check only', () => {
    const flows = buildPageCheckFlows(siteMap([
      page('https://shop.example/'),
      page('https://shop.example/old', { sitemapOnly: true }),
    ])).flows;
    const http = flows.find(flow => flow.id === 'check-http');
    const axe = flows.find(flow => flow.id === 'check-axe');
    expect(http?.steps.find(step => step.url?.endsWith('/old'))?.sitemapOnly).toBe(true);
    expect(http?.steps.find(step => step.url === 'https://shop.example/')?.sitemapOnly).toBeUndefined();
    expect(axe?.steps.every(step => step.sitemapOnly === undefined)).toBe(true);
  });
});

describe('prod false positives on a fixture', () => {
  let site: { url: string; close: () => Promise<void> };
  const shots = mkdtempSync(join(tmpdir(), 'monkeytest-071-'));

  beforeAll(async () => {
    site = await startSite();
  });

  afterAll(async () => {
    await site.close();
  });

  it('does not file axe or metadata bugs for a sitemap, and caps a sitemap 404 at minor', async () => {
    const origin = site.url;
    const pages = [
      page(`${origin}/`),
      page(`${origin}/sitemaps/static.xml`, { sitemapOnly: true }),
      page(`${origin}/notes.txt`, { sitemapOnly: true }),
      page(`${origin}/sitemap-only`, { sitemapOnly: true }),
    ];
    const flows = buildPageCheckFlows(siteMap(pages)).flows.filter(flow =>
      flow.id === 'check-axe' || flow.id === 'check-meta' || flow.id === 'check-http',
    );
    const raw = await runPlan(plan(origin, flows), llm, runOpts(shots));
    const run = triage(raw);

    const axeXml = step(raw.flows, 'check-axe', '/sitemaps/static.xml');
    const metaXml = step(raw.flows, 'check-meta', '/sitemaps/static.xml');
    const axeTxt = step(raw.flows, 'check-axe', '/notes.txt');
    const metaTxt = step(raw.flows, 'check-meta', '/notes.txt');
    expect(axeXml?.status).toBe('skipped');
    expect(metaXml?.status).toBe('skipped');
    expect(axeXml?.observation).toMatch(/not HTML/);
    expect(metaXml?.observation).toMatch(/not HTML/);
    expect(axeTxt?.status).toBe('skipped');
    expect(metaTxt?.status).toBe('skipped');
    expect(step(raw.flows, 'check-axe', '/')?.status).not.toBe('skipped');

    const xmlBug = run.bugs.find(bug => /static\.xml|notes\.txt/.test(`${bug.page_url} ${bug.observed}`));
    expect(xmlBug).toBeUndefined();

    const sitemapBug = bugTouching(run, '/sitemap-only');
    const domBug = bugTouching(run, '/dom-missing');
    expect(sitemapBug?.severity).toBe('minor');
    expect(domBug?.severity).toBe('major');

    const http = raw.flows.find(flow => flow.flowId === 'check-http');
    expect(http?.trace?.steps.find(item => item.urlAfter?.endsWith('/sitemap-only'))?.sitemapOnly).toBe(true);
    const replayed = triage(await replayTraces(http?.trace ? [http.trace] : [], runOpts(shots)));
    expect(bugTouching(replayed, '/sitemap-only')?.severity).toBe('minor');
    expect(bugTouching(replayed, '/dom-missing')?.severity).toBe('major');
  }, 90_000);

  it('does not file a bug when search stays on the same URL and the page changes', async () => {
    const origin = site.url;
    const raw = await runPlan(plan(origin, [
      flow('search-housing', `${origin}/search`, 'Click "Search"', 'critical'),
      flow('advisory-board', `${origin}/search`, 'Click "Advisory board"', 'major'),
      flow('show-error', `${origin}/search`, 'Click "Break"', 'major'),
    ]), llm, runOpts(shots));
    const run = triage(raw);

    const search = run.flows.find(item => item.flowId === 'search-housing');
    expect(search?.status).toBe('inconclusive');
    expect(run.bugs.some(bug => bug.flow_id === 'search-housing')).toBe(false);
    expect(run.bugs.some(bug => bug.severity === 'critical')).toBe(false);

    const advisory = run.bugs.find(bug => bug.flow_id === 'advisory-board');
    expect(advisory?.severity).toBe('major');
    expect(advisory?.observed).toMatch(/did not change/);

    const shown = run.bugs.find(bug => bug.flow_id === 'show-error');
    expect(shown?.severity).toBe('major');
    expect(shown?.observed).toMatch(/error/i);

    const replayed = triage(await replayTraces([
      raw.flows.find(item => item.flowId === 'search-housing')!.trace!,
      raw.flows.find(item => item.flowId === 'advisory-board')!.trace!,
    ], runOpts(shots)));
    expect(replayed.flows.find(item => item.flowId === 'search-housing')?.status).toBe('inconclusive');
    expect(replayed.bugs.some(bug => bug.flow_id === 'search-housing')).toBe(false);
    expect(replayed.bugs.find(bug => bug.flow_id === 'advisory-board')?.severity).toBe('major');
  }, 60_000);
});

function runOpts(screenshotsDir: string) {
  return {
    screenshotsDir,
    headless: true,
    recordVideo: false,
    strictOracles: true,
    stepTimeoutMs: 8_000,
  };
}

function plan(startUrl: string, flows: TestFlow[]): TestPlan {
  return { startUrl, siteType: 'fixture', flows };
}

function flow(id: string, startUrl: string, action: string, severity: TestFlow['severityIfFails']): TestFlow {
  return {
    id,
    name: id,
    description: action,
    kind: 'happy_path',
    startUrl,
    steps: [{ action, expectation: 'The page responds.' }],
    expectation: 'The URL changes.',
    outcomeCheck: { kind: 'url_changed' },
    severityIfFails: severity,
  };
}

function step(flows: { flowId: string; steps: { target?: string; status: string; observation: string }[] }[], id: string, path: string) {
  return flows.find(flow => flow.flowId === id)?.steps.find(item => item.target?.endsWith(path));
}

function bugTouching(run: { bugs: { severity: string; observed: string; page_url?: string; evidence: { networkFailures: { url: string }[] } }[] }, path: string) {
  return run.bugs.find(bug =>
    bug.evidence.networkFailures.some(item => item.url.includes(path))
    || `${bug.page_url || ''} ${bug.observed}`.includes(path),
  );
}

function page(url: string, extra: Partial<SiteMapPage> = {}): SiteMapPage {
  return {
    url,
    title: 'Page',
    summary: 'Page',
    interactive: [],
    outboundLinks: [],
    authGated: false,
    ...extra,
  };
}

function siteMap(pages: SiteMapPage[]): SiteMap {
  return {
    startUrl: pages[0]?.url || 'https://shop.example/',
    siteType: 'fixture',
    summary: 'Fixture',
    pages,
    pagesExplored: pages.length,
    pendingUrls: [],
    failedUrls: [],
  };
}

function startSite(): Promise<{ url: string; close: () => Promise<void> }> {
  let server: Server;
  return new Promise((resolve, reject) => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (url.pathname === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (url.pathname === '/sitemaps/static.xml') {
        res.writeHead(200, { 'content-type': 'application/xml' });
        res.end('<?xml version="1.0"?><urlset><url><loc>https://shop.example/old</loc></url></urlset>');
        return;
      }
      if (url.pathname === '/notes.txt') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('notes');
        return;
      }
      if (url.pathname === '/sitemap-only' || url.pathname === '/dom-missing') {
        res.writeHead(404, { 'content-type': 'text/html' });
        res.end('<!doctype html><html lang="en"><title>Missing</title><body><h1>Missing</h1></body></html>');
        return;
      }
      if (url.pathname === '/search') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Search</title>
          <meta name="viewport" content="width=device-width, initial-scale=1"></head><body>
          <h1>Search housing</h1>
          <button type="button" id="search">Search</button>
          <button type="button" id="dead">Advisory board</button>
          <button type="button" id="bad">Break</button>
          <div id="out"></div>
          <script>
            document.getElementById('search').onclick = () => { document.getElementById('out').textContent = '3 homes'; };
            document.getElementById('bad').onclick = () => {
              document.getElementById('out').textContent = 'updated';
              const note = document.createElement('div');
              note.setAttribute('role', 'alert');
              note.textContent = 'Something went wrong';
              document.body.appendChild(note);
            };
          </script>
        </body></html>`);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home</title>
        <meta name="description" content="Home"><meta name="viewport" content="width=device-width, initial-scale=1">
        <style>body{font:16px sans-serif;color:#111;background:#fff}a{min-height:44px;display:inline-block}</style>
        </head><body><h1>Home</h1><p><a href="/dom-missing">Missing page</a></p></body></html>`);
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
        close: () => new Promise((done, fail) => server.close(err => err ? fail(err) : done())),
      });
    });
  });
}
