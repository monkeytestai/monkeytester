/**
 * Replay page checks use the live settle and keep axe findings.
 *
 * A contrast failure that paints after 200ms must still fail on replay.
 * Several pages that share a rule roll up to the same minor bug, with the
 * same fingerprint, as the live check.
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { executePageChecks } from '../src/checks/execute.js';
import { replayTraces } from '../src/runner/replay.js';
import { triage } from '../src/triager/index.js';
import type { BugReport, FlowResult, RunResult, TestFlow } from '../src/types.js';

describe('replay page checks match live', () => {
  let server: Server;
  let origin = '';
  let browser: Browser;
  const shots = mkdtempSync(join(tmpdir(), 'monkeytest-replay-checks-'));

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (url.pathname === '/late') {
        res.end(latePage());
        return;
      }
      const scrollable = url.pathname === '/';
      res.end(staticPage(url.pathname === '/' ? 'Home' : url.pathname.slice(1), scrollable));
    });
    await new Promise<void>((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('check site did not bind');
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  it('sees a low-contrast element that renders after the old 200ms replay settle', async () => {
    const url = `${origin}/late`;
    const live = triage(asRun(url, await executePageChecks(browser, [axeFlow([url])], {
      screenshotsDir: shots,
      stepTimeoutMs: 8_000,
    })));
    const replay = triage(await replayTraces(tracesOf(live), {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      stepTimeoutMs: 8_000,
    }));

    const liveRule = live.flows[0].steps.flatMap(step => step.axeRules ?? []).find(rule => rule.id === 'color-contrast');
    const replayRule = replay.flows[0].steps.flatMap(step => step.axeRules ?? []).find(rule => rule.id === 'color-contrast');
    expect(liveRule?.id).toBe('color-contrast');
    expect(replayRule?.id).toBe('color-contrast');
    expect(replay.flows[0].steps.some(step => step.status === 'failed')).toBe(true);
    expect(replay.bugs.map(bug => bug.fingerprintV2)).toEqual(live.bugs.map(bug => bug.fingerprintV2));
  }, 30_000);

  it('rolls axe findings up with the same severity and fingerprints as live', async () => {
    const urls = [`${origin}/`, `${origin}/shop`, `${origin}/about`];
    const live = triage(asRun(urls[0], await executePageChecks(browser, [axeFlow(urls)], {
      screenshotsDir: shots,
      stepTimeoutMs: 8_000,
    })));
    const replay = triage(await replayTraces(tracesOf(live), {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      stepTimeoutMs: 8_000,
    }));

    const liveContrast = live.bugs.filter(bug => bug.title.includes('color-contrast'));
    const replayContrast = replay.bugs.filter(bug => bug.title.includes('color-contrast'));
    expect(liveContrast).toHaveLength(1);
    expect(replayContrast).toHaveLength(1);
    expect(liveContrast[0].severity).toBe('minor');
    expect(replayContrast[0].severity).toBe('minor');
    expect(liveContrast[0].affectedPages).toHaveLength(urls.length);
    expect(replayContrast[0].affectedPages).toEqual(liveContrast[0].affectedPages);
    expect(replayContrast[0].fingerprint).toBe(liveContrast[0].fingerprint);
    expect(replayContrast[0].fingerprintV2).toBe(liveContrast[0].fingerprintV2);

    expect(identities(replay.bugs)).toEqual(identities(live.bugs));
    expect(replay.bugs.filter(bug => bug.severity === 'major' && /color-contrast|scrollable-region-focusable/.test(bug.title))).toEqual([]);
  }, 30_000);
});

function identities(bugs: BugReport[]): string[] {
  return bugs
    .map(bug => `${bug.fingerprint}|${bug.fingerprintV2}|${bug.severity}|${bug.title}|${(bug.affectedPages ?? []).join(',')}`)
    .sort();
}

function tracesOf(run: RunResult) {
  return run.flows.map(flow => flow.trace).filter((trace): trace is NonNullable<FlowResult['trace']> => Boolean(trace));
}

function axeFlow(urls: string[]): TestFlow {
  return {
    id: 'check-axe',
    name: 'WCAG A and AA',
    description: 'axe-core WCAG A and AA.',
    kind: 'accessibility',
    startUrl: urls[0],
    expectation: 'The page has no serious or critical WCAG A/AA violation.',
    severityIfFails: 'major',
    steps: urls.map(url => ({
      action: `Check WCAG A and AA on ${url}`,
      expectation: 'The page has no serious or critical WCAG A/AA violation.',
      pageCheck: 'axe',
      url,
    })),
  };
}

function asRun(startUrl: string, flows: FlowResult[]): RunResult {
  return {
    startUrl,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    flows,
    bugs: [],
    stats: {
      flowsTotal: flows.length,
      flowsPassed: 0,
      flowsFailed: flows.length,
      flowsBlocked: 0,
      stepsTotal: 0,
      stepsPassed: 0,
      stepsFailed: 0,
      bugsCritical: 0,
      bugsMajor: 0,
      bugsMinor: 0,
    },
  };
}

function latePage(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign up</title></head>
<body><div id="root"></div>
<script>
  setTimeout(() => {
    document.getElementById('root').innerHTML = '<h1 style="color:#c8c8c8;background-color:#ffffff;font-size:16px;font-weight:400">Sign up to continue into the account area</h1>';
  }, 350);
</script>
</body></html>`;
}

function staticPage(title: string, scrollable: boolean): string {
  const region = scrollable
    ? '<div style="height:40px;width:220px;overflow:auto"><p>First line of a note that makes this region scroll.</p><p>Second line of a note that makes this region scroll.</p><p>Third line of a note that makes this region scroll.</p></div>'
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body>
  <h1 style="color:#c8c8c8;background-color:#ffffff;font-size:16px;font-weight:400">${title} heading is too light to read</h1>
  ${region}
</body></html>`;
}
