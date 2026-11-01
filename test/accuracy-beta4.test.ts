/**
 * 0.7.0-beta.4 accuracy fixes: temperature, planner budget, trailing slash,
 * third-party page errors, login-wall plans, unlinked roots, suggestions,
 * invented hosts, and per-step prices.
 */

import { describe, expect, it, vi } from 'vitest';
import { plannerBudgetMs } from '../src/budget.js';
import { outcomeForAxe } from '../src/checks/execute.js';
import { judgeConsole } from '../src/checks/console.js';
import { isDifferentRegistrableDomain, registrableDomain, scriptUrlFromError } from '../src/checks/party.js';
import {
  canonicalPageUrl,
  linksOnCrawlSite,
  planCrawlOrder,
  seedCrawlQueue,
} from '../src/explorer/queue.js';
import {
  isUnsupportedTemperatureError,
  modelRejectsCustomTemperature,
  temperatureForRequest,
  withTemperatureRetry,
} from '../src/llm/temperature.js';
import { estimateCostUsd, MODEL_PRICES } from '../src/llm/prices.js';
import type { LLM } from '../src/llm/index.js';
import { EventBus } from '../src/events.js';
import { plan } from '../src/planner/index.js';
import { findUncrawledReferences } from '../src/planner/inventory.js';
import { oracleFromEvidence } from '../src/runner/evidence.js';
import { triage } from '../src/triager/index.js';
import { scoreBakeoff } from '../scripts/bakeoff.js';
import type { RunResult, SiteMap, TestFlow } from '../src/types.js';

const TI = 'https://the-internet.herokuapp.com';
const ADD = `${TI}/add_remove_elements/`;

describe('temperature', () => {
  it('omits temperature for gpt-5 and o-series, and keeps 0.2 for other models', () => {
    expect(modelRejectsCustomTemperature('gpt-5-mini')).toBe(true);
    expect(modelRejectsCustomTemperature('gpt-5-nano')).toBe(true);
    expect(modelRejectsCustomTemperature('gpt-5')).toBe(true);
    expect(modelRejectsCustomTemperature('gpt-5.1')).toBe(true);
    expect(modelRejectsCustomTemperature('o4-mini')).toBe(true);
    expect(modelRejectsCustomTemperature('o1-preview')).toBe(true);
    expect(modelRejectsCustomTemperature('o3')).toBe(true);
    expect(modelRejectsCustomTemperature('gpt-4o-mini')).toBe(false);
    expect(modelRejectsCustomTemperature('gpt-4.1-nano')).toBe(false);
    expect(temperatureForRequest('gpt-5-mini', 0.2)).toBeUndefined();
    expect(temperatureForRequest('gpt-5-mini', 1)).toBeUndefined();
    expect(temperatureForRequest('gpt-4o-mini', undefined)).toBe(0.2);
    expect(temperatureForRequest('gpt-4o-mini', 0.4)).toBe(0.4);
  });

  it('retries once when the provider rejects temperature', async () => {
    const seen: Array<number | undefined> = [];
    const value = await withTemperatureRetry(0.2, async temperature => {
      seen.push(temperature);
      if (temperature !== undefined) {
        throw new Error("400 Unsupported value: 'temperature' does not support 0.2. Only the default (1) value is supported.");
      }
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(seen).toEqual([0.2, undefined]);
    expect(isUnsupportedTemperatureError(new Error('400 only the default (1) value is supported for temperature'))).toBe(true);
    expect(isUnsupportedTemperatureError(new Error('401 unauthorized'))).toBe(false);
  });
});

describe('planner budget', () => {
  it('keeps a reserve for checks after a slow crawl', () => {
    const started = 1_000_000;
    const deadline = started + 120_000;
    expect(plannerBudgetMs({ totalBudgetMs: 120_000, deadlineAt: deadline, now: started + 30_000 })).toBe(45_000);
    expect(plannerBudgetMs({ totalBudgetMs: 120_000, deadlineAt: deadline, now: started + 90_000 })).toBe(0);
    expect(plannerBudgetMs({})).toBeUndefined();
  });
});

describe('trailing slash and unlinked root', () => {
  it('visits /add_remove_elements/ with the slash and dedups the bare path', () => {
    expect(canonicalPageUrl(ADD)).toBe(ADD);
    const links = linksOnCrawlSite([{ url: ADD, text: 'Add/Remove Elements' }], `${TI}/`);
    expect(links[0]?.url).toBe(ADD);
    const order = planCrawlOrder({
      startUrl: `${TI}/`,
      maxPages: 3,
      edges: { [`${TI}/`]: [{ url: ADD, text: 'Add/Remove Elements' }] },
    });
    expect(order).toContain(ADD);
    expect(order).not.toContain(`${TI}/add_remove_elements`);
  });

  it('does not seed demo.playwright.dev/ when the start URL is /todomvc', () => {
    const start = 'https://demo.playwright.dev/todomvc';
    expect(seedCrawlQueue(start).map(item => item.url)).toEqual([start]);
    const order = planCrawlOrder({ startUrl: start, maxPages: 4, edges: { [start]: [] } });
    expect(order).toEqual([start]);
    expect(order).not.toContain('https://demo.playwright.dev/');
  });
});

describe('third-party page errors', () => {
  it('does not fail a step on an ad-script error, and still fails a first-party one', () => {
    const page = 'https://demoqa.com/elements';
    const ad = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
    expect(registrableDomain('www.demoqa.com')).toBe('demoqa.com');
    expect(registrableDomain('cdn.demoqa.com')).toBe('demoqa.com');
    expect(isDifferentRegistrableDomain(ad, page)).toBe(true);
    expect(isDifferentRegistrableDomain('https://demoqa.com/app.js', page)).toBe(false);
    const fromStack = scriptUrlFromError({
      message: 'ads failed',
      stack: `Error: ads failed\n    at run (${ad}:12:3)`,
    });
    expect(fromStack).toBe(ad);
    expect(oracleFromEvidence(
      [{ message: 'ads failed', sourceUrl: ad }],
      [],
      page,
    )).toBeNull();
    expect(oracleFromEvidence(
      [{ message: 'checkout exploded', sourceUrl: 'https://demoqa.com/app.js' }],
      [],
      page,
    )?.error).toBe('pageerror');
    expect(oracleFromEvidence(['checkout exploded'], [])?.error).toBe('pageerror');
    const judged = judgeConsole([
      { kind: 'pageerror', message: 'ads failed', sourceUrl: ad },
      { kind: 'pageerror', message: 'checkout exploded', sourceUrl: 'https://demoqa.com/app.js' },
    ], page);
    expect(judged.bugs.map(hit => hit.message)).toEqual(['checkout exploded']);
    expect(judged.thirdParty.map(hit => hit.message)).toEqual(['ads failed']);
  });
});

describe('suggestions are not bugs', () => {
  it('records missing autocomplete without failing the check, and keeps a serious axe bug', () => {
    const only = outcomeForAxe({
      pageUrl: 'https://www.saucedemo.com/',
      serious: [],
      autocomplete: ['Login field "user-name" has no autocomplete attribute.'],
      info: [],
    });
    expect(only.status).toBe('passed');
    expect(only.suggestions?.map(item => item.kind)).toEqual(['autocomplete']);
    const serious = outcomeForAxe({
      pageUrl: 'https://demoqa.com/',
      serious: [{ impact: 'critical', id: 'image-alt', help: 'Images must have alternative text' }],
      autocomplete: ['Login field "email" has no autocomplete attribute.'],
      info: [],
    });
    expect(serious.status).toBe('failed');
    expect(serious.error).toBe('axe:image-alt');
    expect(serious.observation).not.toMatch(/autocomplete/);
    expect(serious.suggestions?.[0]?.kind).toBe('autocomplete');
  });

  it('keeps suggestions out of the bug list and the verdict', () => {
    const run: RunResult = {
      startUrl: 'https://www.saucedemo.com/',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      flows: [{
        flowId: 'check-axe',
        name: 'WCAG A and AA',
        description: 'axe',
        kind: 'accessibility',
        startUrl: 'https://www.saucedemo.com/',
        status: 'passed',
        assertion: 'verified',
        steps: [{
          index: 1,
          action: 'Check WCAG A and AA',
          status: 'passed',
          observation: 'No serious or critical WCAG A/AA violation.',
          suggestions: [{
            pageUrl: 'https://www.saucedemo.com/',
            title: 'Missing autocomplete',
            detail: 'Login field "password" has no autocomplete attribute.',
            kind: 'autocomplete',
            severity: 'info',
          }],
        }],
        durationMs: 10,
        bugIds: [],
      }],
      bugs: [],
      stats: {
        flowsTotal: 1, flowsPassed: 1, flowsFailed: 0, flowsBlocked: 0,
        stepsTotal: 1, stepsPassed: 1, stepsFailed: 0,
        bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
      },
    };
    const triaged = triage(run, { pagesVisited: 1, publicScreens: 1 });
    expect(triaged.bugs).toEqual([]);
    expect(triaged.stats.bugsMinor).toBe(0);
    expect(triaged.outcome).toBe('clean');
    expect(triaged.suggestions).toHaveLength(1);
    const scored = scoreBakeoff(triaged, { startUrl: run.startUrl, siteType: 'shop', flows: [] });
    expect(scored.realBugs).toBe(0);
    expect(scored.suggestions).toBe(1);
    expect(scored.plannerFallback).toBe(false);
  });
});

describe('login wall and invented hosts', () => {
  it('does not treat an empty plan on a login wall as a planner failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const events: string[] = [];
    const bus = new EventBus();
    bus.on(event => events.push(event.type));
    const calls: string[] = [];
    const llm: LLM = {
      providerLabel: 'openai:gpt-4o-mini',
      async generateJSON({ label }) {
        calls.push(label || '');
        return { flows: [], notes: 'Auth wall.' };
      },
    };
    const siteMap: SiteMap = {
      startUrl: 'https://www.saucedemo.com/',
      siteType: 'shop',
      summary: 'A login wall.',
      pages: [{
        url: 'https://www.saucedemo.com/',
        title: 'Swag Labs',
        summary: 'Sign in.',
        interactive: [],
        outboundLinks: [],
        authGated: true,
        inputs: [
          { name: 'user-name', type: 'text', label: 'Username' },
          { name: 'password', type: 'password', label: 'Password' },
        ],
      }],
      pendingUrls: [],
      failedUrls: [],
    };
    const result = await plan(siteMap, llm, { maxFlows: 5, minFlows: 5, events: bus });
    expect(calls).toEqual(['planner.generate']);
    expect(events).not.toContain('engine.error');
    expect(result.plannerFallback).toBeUndefined();
    expect(result.notes).toMatch(/login wall/i);
    expect(result.notes || '').not.toMatch(/planner model returned no flow list|could not be used/i);
    warn.mockRestore();
  });

  it('drops a planned navigation to a URL on another host that was not crawled', () => {
    const siteMap: SiteMap = {
      startUrl: 'https://parabank.parasoft.com/parabank/index.htm',
      siteType: 'bank',
      summary: 'ParaBank.',
      pages: [{
        url: 'https://parabank.parasoft.com/parabank/index.htm',
        title: 'ParaBank',
        summary: 'Services.',
        interactive: [],
        outboundLinks: ['https://parabank.parasoft.com/parabank/services/store-01?wsdl'],
        authGated: false,
      }],
      pendingUrls: [],
      failedUrls: [],
    };
    const flow: TestFlow = {
      id: 'open-wsdl',
      name: 'Open Bookstore Web Service WSDL',
      description: 'Open the bookstore WSDL.',
      kind: 'happy_path',
      startUrl: siteMap.pages[0].url,
      steps: [{ action: 'Open http://store.parabank.parasoft.com/?wsdl' }],
      expectation: 'The WSDL loads.',
      severityIfFails: 'major',
    };
    const dropped = findUncrawledReferences([flow], siteMap);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toMatch(/store\.parabank\.parasoft\.com/);
    const linked: TestFlow = {
      ...flow,
      id: 'real-wsdl',
      steps: [{ action: 'Open https://parabank.parasoft.com/parabank/services/store-01?wsdl' }],
    };
    expect(findUncrawledReferences([linked], siteMap)).toEqual([]);
  });
});

describe('per-step prices', () => {
  it('prices gpt-5 models, marks gpt-4.1-nano deprecated, and bills each step at its own rate', () => {
    expect(MODEL_PRICES['gpt-5-mini']).toMatchObject({ inputPerMillion: 0.25, outputPerMillion: 2 });
    expect(MODEL_PRICES['gpt-5-nano']).toMatchObject({ inputPerMillion: 0.05, outputPerMillion: 0.4 });
    expect(MODEL_PRICES['gpt-4.1-nano']?.deprecated).toBe(true);
    const mixed = estimateCostUsd([
      { model: 'gpt-4o-mini', promptTokens: 1000, completionTokens: 100 },
      { model: 'gpt-4o', promptTokens: 1000, completionTokens: 100 },
    ]);
    const plannerOnly = estimateCostUsd('gpt-4o', 2000, 200);
    expect(mixed).not.toBeNull();
    expect(plannerOnly).not.toBeNull();
    expect(mixed).toBeLessThan(plannerOnly as number);
    expect(estimateCostUsd('gpt-5-mini', 1_000_000, 0)).toBe(0.25);
    expect(estimateCostUsd([{ model: 'gpt-5-mini', promptTokens: 1_000_000, completionTokens: 0, cachedTokens: 1_000_000 }])).toBe(0.025);
    expect(estimateCostUsd([{ model: 'no-such-model', promptTokens: 10, completionTokens: 1 }])).toBeNull();
  });
});
