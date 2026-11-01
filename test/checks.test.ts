/**
 * Phase 2 page checks, case-count floor, and the basic time budget.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isOwnAutomationBug } from '../src/automation/signatures.js';
import { judgeConsole } from '../src/checks/console.js';
import { BROKEN_LINK_CAP, sameSiteLinks } from '../src/checks/http.js';
import { judgeMeta } from '../src/checks/meta.js';
import { judgeMobile } from '../src/checks/mobile.js';
import { isIgnoredConsoleMessage } from '../src/checks/noise.js';
import { buildPageCheckFlows } from '../src/checks/plan.js';
import { BASIC_PRESET } from '../src/depth.js';
import type { LLM } from '../src/llm/index.js';
import { plan } from '../src/planner/index.js';
import { runPlan } from '../src/runner/index.js';
import { triage } from '../src/triager/index.js';
import type { SiteMap, SiteMapPage, TestFlow } from '../src/types.js';
import { startChecksFixture, type ChecksFixture } from './fixtures/checks/server.ts';

const stub: LLM = {
  providerLabel: 'stub',
  async generateJSON() {
    throw new Error('page checks must not call a model');
  },
};

describe('page check classifiers', () => {
  it('drops extension, third-party, and our own automation noise', () => {
    expect(isIgnoredConsoleMessage('ResizeObserver loop limit exceeded', undefined, 'https://shop.example/')).toBe(true);
    expect(isIgnoredConsoleMessage('waiting for locator("#x")', undefined, 'https://shop.example/')).toBe(true);
    expect(isIgnoredConsoleMessage('TypeError: cart is undefined', 'https://cdn.example/app.js', 'https://shop.example/')).toBe(true);
    expect(isIgnoredConsoleMessage('TypeError: cart is undefined', 'https://shop.example/app.js', 'https://shop.example/')).toBe(false);
    const judged = judgeConsole([
      { kind: 'pageerror', message: 'checkout exploded', sourceUrl: 'https://shop.example/app.js' },
      { kind: 'pageerror', message: 'Script error.' },
      { kind: 'console', message: 'waiting for locator("#save")' },
    ], 'https://shop.example/');
    expect(judged.bugs.map(hit => hit.message)).toEqual(['checkout exploded']);
    expect(judged.unattributed.map(hit => hit.message)).toEqual(['Script error.']);
    expect(judged.ignored).toBe(1);
  });

  it('treats a missing title as a bug and viewport or description as suggestions', () => {
    const bare = judgeMeta({ title: '', description: '', lang: '', viewport: '', h1: 2 });
    expect(bare.bugs.join(' ')).toMatch(/title/);
    expect(bare.bugs.join(' ')).not.toMatch(/viewport/);
    expect(bare.suggestions.join(' ')).toMatch(/viewport/);
    expect(bare.suggestions.join(' ')).toMatch(/meta description/);
    expect(bare.info.join(' ')).not.toMatch(/meta description/);
    expect(bare.info.join(' ')).toMatch(/lang/);
    expect(bare.info.join(' ')).toMatch(/h1/);
    const titled = judgeMeta({ title: 'Shop', description: '', lang: 'en', viewport: '', h1: 1 });
    expect(titled.bugs).toEqual([]);
    expect(titled.suggestions.join(' ')).toMatch(/viewport/);
    expect(judgeMeta({ title: 'Shop', description: '', lang: 'en', viewport: 'width=device-width', h1: 1 }).bugs).toEqual([]);
  });

  it('flags real overflow and tiny named controls, and ignores a scrollbar', () => {
    expect(judgeMobile({ overflow: 15, targets: [] }).bugs).toEqual([]);
    expect(judgeMobile({ overflow: 80, targets: [] }).bugs[0]).toMatch(/80px/);
    const desktopOnly = judgeMobile({ overflow: 501, targets: [], hasViewport: false });
    expect(desktopOnly.bugs).toEqual([]);
    expect(desktopOnly.suggestions[0]).toMatch(/501px/);
    expect(judgeMobile({ overflow: 80, targets: [], hasViewport: true }).bugs[0]).toMatch(/80px/);
    const tiny = judgeMobile({
      overflow: 0,
      targets: [{ name: 'Go', width: 10, height: 10, tag: 'button' }],
    });
    expect(tiny.bugs[0]).toMatch(/Tap targets/);
    const many = judgeMobile({
      overflow: 0,
      targets: Array.from({ length: 9 }, (_, index) => ({ name: `Icon ${index}`, width: 8, height: 8, tag: 'button' })),
    });
    expect(many.bugs).toEqual([]);
    expect(many.info[0]).toMatch(/Too many/);
  });

  it('caps broken-link probes at about 20', () => {
    const hrefs = Array.from({ length: 30 }, (_, index) => `https://shop.example/p/${index}`);
    expect(sameSiteLinks(hrefs, 'https://shop.example/', BROKEN_LINK_CAP)).toHaveLength(20);
  });
});

describe('case count floor', () => {
  it('plans at least 8 cases for a sign-in sitemap', async () => {
    const result = await plan(signinMap(), emptyPlanner(), {
      maxFlows: BASIC_PRESET.llmFlows,
      minFlows: 0,
      focus: 'forms-search-cta',
    });
    expect(result.flows.filter(flow => flow.id.startsWith('auth-neg-')).length).toBeGreaterThanOrEqual(5);
    expect(result.flows.filter(flow => flow.id.startsWith('check-'))).toHaveLength(BASIC_PRESET.engineFlowCaps.checks);
    expect(result.flows.length).toBeGreaterThanOrEqual(8);
    expect(result.flows.filter(flow => flow.id.startsWith('check-')).every(flow => flow.steps.length === 3)).toBe(true);
  });

  it('plans at least 8 cases for a public site', async () => {
    const result = await plan(publicMap(), emptyPlanner(), {
      maxFlows: BASIC_PRESET.llmFlows,
      minFlows: 0,
      focus: 'forms-search-cta',
    });
    const budgeted = result.flows.filter(flow => !flow.id.startsWith('check-') && !flow.id.startsWith('auth-neg-'));
    expect(budgeted.length).toBeGreaterThanOrEqual(3);
    expect(budgeted.length).toBeLessThanOrEqual(BASIC_PRESET.llmFlows);
    expect(result.flows.filter(flow => flow.id.startsWith('check-'))).toHaveLength(5);
    expect(result.flows.length).toBeGreaterThanOrEqual(8);
  });

  it('asks for more journeys when the first plan is thin and drops an uncrawled page', async () => {
    const labels: string[] = [];
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON({ label }) {
        labels.push(label || '');
        if (label === 'planner.expand') {
          return {
            flows: [
              homeFlow('home-read'),
              {
                id: 'invented-pricing',
                name: 'View pricing',
                description: 'Open pricing.',
                kind: 'happy_path',
                startUrl: 'https://shop.example/pricing',
                steps: [{ action: 'Click "View pricing"' }],
                expectation: 'Pricing loads.',
                severityIfFails: 'major',
              },
              cta('Get started'),
              cta('Contact us'),
            ],
          };
        }
        return { flows: [homeFlow('home-read')] };
      },
    };
    const result = await plan(publicMap(), llm, { maxFlows: 5, minFlows: 5, pageChecks: false });
    expect(labels).toContain('planner.expand');
    expect(result.flows.some(flow => flow.id === 'invented-pricing')).toBe(false);
    expect(result.droppedFlows?.some(flow => flow.id === 'invented-pricing')).toBe(true);
    expect(result.plannerLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it('may use a forgot-password link on an auth page', async () => {
    const result = await plan(forgotOnly(), emptyPlanner(), {
      maxFlows: 4,
      minFlows: 0,
      focus: 'forms-search-cta',
      pageChecks: false,
    });
    const actions = result.flows.flatMap(flow => flow.steps.map(step => step.action)).join('\n');
    expect(actions).toContain('Forgot password');
    expect(actions).not.toContain('Sign in');
  });
});

describe('check fixtures', () => {
  let fixture: ChecksFixture;
  const shots = mkdtempSync(join(tmpdir(), 'monkeytest-checks-'));

  beforeAll(async () => {
    fixture = await startChecksFixture();
  });

  afterAll(async () => {
    await fixture.close();
  });

  it('files a bug only for a clear break, and records tool check', async () => {
    const pages = ['/console', '/console-noise', '/http', '/axe', '/axe-login', '/mobile', '/meta', '/clean']
      .map(path => page(`${fixture.url}${path}`));
    const built = buildPageCheckFlows(site(pages));
    const raw = await runPlan({
      startUrl: fixture.url,
      siteType: 'fixture',
      flows: built.flows,
    }, stub, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      stepTimeoutMs: 8_000,
    });
    const run = triage(raw);
    expect(raw.flows.every(flow => flow.steps.every(step => step.tool === 'check'))).toBe(true);
    expect(run.bugs.every(bug => !isOwnAutomationBug(bug))).toBe(true);

    const step = (id: string, path: string) => raw.flows.find(flow => flow.flowId === id)?.steps.find(item => item.target === `${fixture.url}${path}`);
    expect(step('check-console', '/console')?.status).toBe('failed');
    expect(step('check-console', '/console')?.error).toMatch(/pageerror|console-error/);
    expect(step('check-console', '/console-noise')?.status).toBe('passed');
    expect(step('check-http', '/http')?.status).toBe('failed');
    expect(step('check-http', '/http')?.error).toMatch(/http-404/);
    expect(step('check-axe', '/axe')?.status).toBe('failed');
    expect(['major', 'critical']).toContain(step('check-axe', '/axe')?.severity);
    const login = step('check-axe', '/axe-login');
    expect(login?.status).toBe('passed');
    expect(login?.suggestions?.some(item => item.kind === 'autocomplete')).toBe(true);
    expect(step('check-mobile', '/mobile')?.status).toBe('failed');
    expect(step('check-meta', '/meta')?.status).toBe('failed');
    expect(step('check-meta', '/meta')?.severity).toBe('minor');
    expect(step('check-meta', '/meta')?.error).toBe('missing-title');
    expect(step('check-meta', '/meta')?.suggestions?.some(item => item.kind === 'viewport')).toBe(true);
    expect(step('check-meta', '/meta')?.observation).toMatch(/Info:/);
    for (const id of ['check-console', 'check-http', 'check-axe', 'check-mobile', 'check-meta']) {
      expect(step(id, '/clean')?.status).toBe('passed');
    }

    const loginBug = run.bugs.find(bug => bug.flow_id === 'check-axe' && bug.page_url?.endsWith('/axe-login'));
    expect(loginBug).toBeUndefined();
    expect(run.suggestions?.some(item => item.kind === 'autocomplete' && item.pageUrl.endsWith('/axe-login'))).toBe(true);
    expect(run.stats.bugsMinor).toBeGreaterThan(0);
    const axeBugs = run.bugs.filter(bug => bug.flow_id === 'check-axe' && bug.page_url?.endsWith('/axe'));
    expect(axeBugs.length).toBeGreaterThan(0);
    expect(axeBugs.every(bug => bug.severity === 'major' || bug.severity === 'critical')).toBe(true);
  }, 90_000);
});

describe('basic time budget', () => {
  it('skips remaining checks instead of failing the run as a timeout', async () => {
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-budget-'));
    const flows = buildPageCheckFlows(site([page('http://127.0.0.1:9/never')])).flows;
    const raw = await runPlan({
      startUrl: 'http://127.0.0.1:9/never',
      siteType: 'fixture',
      flows,
    }, stub, {
      screenshotsDir: shots,
      headless: true,
      recordVideo: false,
      deadlineAt: Date.now() - 1_000,
    });
    expect(raw.flows).toHaveLength(5);
    expect(raw.flows.every(flow => flow.steps.every(step => step.status === 'skipped'))).toBe(true);
    expect(raw.flows.every(flow => flow.status === 'inconclusive')).toBe(true);
    const blob = JSON.stringify(raw);
    expect(blob).not.toMatch(/exceeded \d+ms/);
    expect(blob).toMatch(/time budget/);
  }, 60_000);
});

function emptyPlanner(): LLM {
  return {
    providerLabel: 'stub',
    async generateJSON() {
      return { flows: [] };
    },
  };
}

function signinMap(): SiteMap {
  return site([
    page('https://shop.example/?mode=signin', {
      authGated: true,
      forms: [{
        action: '',
        method: 'get',
        fields: ['email', 'password'],
        inputs: [
          { name: 'email', label: 'Email', type: 'email' },
          { name: 'password', label: 'Password', type: 'password' },
        ],
        submitLabel: 'Sign in',
      }],
      controls: [
        { kind: 'button', label: 'Sign in' },
        { kind: 'link', label: 'Forgot password', href: 'https://shop.example/forgot-password' },
        { kind: 'link', label: 'Sign up', href: 'https://shop.example/?mode=signup' },
      ],
    }),
    page('https://shop.example/?mode=signup', { authGated: true }),
    page('https://shop.example/forgot-password', { authGated: true }),
  ]);
}

function publicMap(): SiteMap {
  return site([
    page('https://shop.example/', {
      forms: [{ action: 'https://shop.example/search', method: 'get', fields: ['q'], submitLabel: 'Search' }],
      controls: [
        { kind: 'button', label: 'Get started' },
        { kind: 'button', label: 'Search' },
      ],
    }),
    page('https://shop.example/contact', {
      forms: [{
        action: 'https://shop.example/api/contact',
        method: 'post',
        fields: ['email', 'message'],
        inputs: [
          { label: 'Email', name: 'email', type: 'email' },
          { label: 'Message', name: 'message', type: 'textarea' },
        ],
        submitLabel: 'Send message',
      }],
      controls: [{ kind: 'button', label: 'Send message' }],
    }),
  ]);
}

function forgotOnly(): SiteMap {
  return site([
    page('https://shop.example/login', {
      authGated: true,
      controls: [
        { kind: 'button', label: 'Sign in' },
        { kind: 'link', label: 'Forgot password', href: 'https://shop.example/forgot-password' },
      ],
      forms: [{
        action: '',
        method: 'get',
        fields: ['email'],
        inputs: [{ name: 'email', label: 'Email', type: 'email' }],
        submitLabel: 'Sign in',
      }],
    }),
  ]);
}

function homeFlow(id: string): TestFlow {
  return {
    id,
    name: 'Read the homepage',
    description: 'Read the shop.',
    kind: 'happy_path',
    startUrl: 'https://shop.example/',
    steps: [{ action: 'Read the introductory paragraph', expectation: 'The page loads.' }],
    expectation: 'The homepage loads.',
    severityIfFails: 'minor',
  };
}

function cta(label: string): TestFlow {
  const id = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id: `model-${id}`,
    name: `Use ${label}`,
    description: `Activate ${label}.`,
    kind: 'happy_path',
    startUrl: 'https://shop.example/',
    steps: [{ action: `Click "${label}"`, expectation: 'The control runs.' }],
    expectation: 'The control runs.',
    severityIfFails: 'major',
  };
}

function site(pages: SiteMapPage[]): SiteMap {
  return {
    startUrl: pages[0]?.url || 'https://shop.example/',
    siteType: 'fixture',
    summary: 'Fixture.',
    pages,
    pendingUrls: [],
    failedUrls: [],
  };
}

function page(url: string, extra: Partial<SiteMapPage> = {}): SiteMapPage {
  return {
    url,
    title: 'Page',
    summary: 'A page.',
    interactive: [],
    outboundLinks: [],
    authGated: false,
    ...extra,
  };
}
