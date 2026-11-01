/**
 * Page checks run before sign-up and LLM flows. A check the budget skips
 * is budget_exhausted with the time actually spent, including 0 when it was under a millisecond.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { executePageChecks } from '../src/checks/execute.js';
import { buildPageCheckFlows } from '../src/checks/plan.js';
import { ensurePublicFormFlow } from '../src/planner/forms.js';
import { triage } from '../src/triager/index.js';
import type { RunResult, SiteMap, TestFlow } from '../src/types.js';

describe('page check budget', () => {
  it('records budget_exhausted with the measured duration', async () => {
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-budget-reason-'));
    const siteMap: SiteMap = {
      startUrl: 'https://shop.example/',
      siteType: 'shop',
      summary: 'Shop',
      pages: [{
        url: 'https://shop.example/',
        title: 'Shop',
        summary: 'Home',
        interactive: [],
        outboundLinks: [],
        authGated: false,
      }],
      pendingUrls: [],
      failedUrls: [],
    };
    const flows = buildPageCheckFlows(siteMap).flows;
    const browser = await chromium.launch({ headless: true });
    try {
      const results = await executePageChecks(browser, flows, {
        screenshotsDir: shots,
        stepTimeoutMs: 5_000,
        deadlineAt: Date.now() - 1_000,
      });
      expect(results).toHaveLength(5);
      for (const flow of results) {
        expect(flow.outcome_reason).toBe('budget_exhausted');
        expect(flow.outcome_detail || '').not.toMatch(/couldn'?t confirm|could not be checked/i);
        expect(flow.steps.every(step => typeof step.durationMs === 'number' && step.durationMs >= 0)).toBe(true);
      }
      const run: RunResult = {
        startUrl: siteMap.startUrl,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        flows: results,
        bugs: [],
        stats: {
          flowsTotal: results.length, flowsPassed: 0, flowsFailed: 0, flowsBlocked: 0,
          stepsTotal: results.reduce((sum, flow) => sum + flow.steps.length, 0),
          stepsPassed: 0, stepsFailed: 0,
          bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
        },
      };
      const triaged = triage(run, { pagesVisited: 1, publicScreens: 1 });
      expect(triaged.flows.every(flow => flow.outcome_reason === 'budget_exhausted')).toBe(true);
      expect(triaged.bugs).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});

describe('one submit flow per form', () => {
  it('does not keep a second contact-form-submit for the same action', () => {
    const siteMap: SiteMap = {
      startUrl: 'https://www.bananabeings.com/help',
      siteType: 'shop',
      summary: 'Shop',
      pages: [{
        url: 'https://www.bananabeings.com/help',
        title: 'Help',
        summary: 'Contact',
        interactive: [],
        outboundLinks: [],
        authGated: false,
        forms: [{
          action: 'https://www.bananabeings.com/api/contact',
          method: 'post',
          fields: ['email', 'message'],
          submitLabel: 'Send message',
        }],
      }],
      pendingUrls: [],
      failedUrls: [],
    };
    const duplicate: TestFlow = {
      id: 'contact-form-submit',
      name: 'Submit the contact form',
      description: 'Submit the form that posts to /api/contact',
      kind: 'happy_path',
      startUrl: 'https://www.bananabeings.com/help',
      steps: [{ action: 'Submit the form that posts to /api/contact' }],
      expectation: 'The form submits.',
      outcomeCheck: { kind: 'observable_response' },
      severityIfFails: 'critical',
    };
    const planned = ensurePublicFormFlow([duplicate], siteMap, 5);
    const submits = planned.flows.filter(flow => /form-submit|api\/contact/.test(`${flow.id} ${flow.steps.map(step => step.action).join(' ')}`));
    expect(submits.map(flow => flow.id)).toEqual(['public-form-submit']);
  });
});
