/**
 * Before/after false-positive rate on the hand-labelled bake-off corpus
 * (planner-bakeoff-2026-11-01, every ranked run). Each row is one signature
 * and the number of times it was reported. The "after" column runs the
 * 0.7.0-beta.4 classifiers: a former false positive is a suggestion or is
 * not reported. Real bugs stay bugs.
 */

import { describe, expect, it } from 'vitest';
import { outcomeForAxe } from '../src/checks/execute.js';
import { judgeMeta } from '../src/checks/meta.js';
import { judgeMobile } from '../src/checks/mobile.js';
import { planCrawlOrder, seedCrawlQueue } from '../src/explorer/queue.js';
import { findUncrawledReferences } from '../src/planner/inventory.js';
import { oracleFromEvidence } from '../src/runner/evidence.js';
import type { SiteMap, TestFlow } from '../src/types.js';

type Kind = 'bug' | 'suggestion' | 'dropped';

interface LabeledFinding {
  site: string;
  label: 'REAL' | 'FP';
  rule: string;
  reports: number;
}

const LABELS: LabeledFinding[] = [
  { site: 'automationexercise.com', label: 'REAL', rule: 'mixed-content', reports: 60 },
  { site: 'automationexercise.com', label: 'REAL', rule: 'axe-serious', reports: 60 },
  { site: 'bananabeings.com', label: 'REAL', rule: 'axe-serious', reports: 66 },
  { site: 'bananabeings.com', label: 'REAL', rule: 'bb-contact-500', reports: 14 },
  { site: 'demo.playwright.dev/todomvc', label: 'FP', rule: 'pw-root-404', reports: 12 },
  { site: 'demo.playwright.dev/todomvc', label: 'FP', rule: 'page-metadata', reports: 12 },
  { site: 'demo.playwright.dev/todomvc', label: 'FP', rule: 'pw-root-404-flow', reports: 1 },
  { site: 'demo.playwright.dev/todomvc', label: 'REAL', rule: 'axe-serious', reports: 12 },
  { site: 'demoqa.com', label: 'FP', rule: 'pageerror-nav', reports: 33 },
  { site: 'demoqa.com', label: 'REAL', rule: 'axe-serious', reports: 60 },
  { site: 'jewellerycasting08.lovable.app', label: 'FP', rule: 'autocomplete-only', reports: 36 },
  { site: 'parabank.parasoft.com', label: 'FP', rule: 'mobile-overflow-noviewport', reports: 66 },
  { site: 'parabank.parasoft.com', label: 'FP', rule: 'page-metadata', reports: 66 },
  { site: 'parabank.parasoft.com', label: 'FP', rule: 'pb-invented-wsdl', reports: 1 },
  { site: 'parabank.parasoft.com', label: 'REAL', rule: 'axe-serious', reports: 66 },
  { site: 'practicesoftwaretesting.com', label: 'FP', rule: 'autocomplete-only', reports: 11 },
  { site: 'practicesoftwaretesting.com', label: 'REAL', rule: 'axe-serious', reports: 11 },
  { site: 'the-internet.herokuapp.com', label: 'FP', rule: 'ti-trailing-slash-404', reports: 11 },
  { site: 'the-internet.herokuapp.com', label: 'REAL', rule: 'ti-http-500', reports: 12 },
  { site: 'the-internet.herokuapp.com', label: 'REAL', rule: 'axe-serious', reports: 11 },
  { site: 'www.saucedemo.com', label: 'FP', rule: 'autocomplete-only', reports: 11 },
];

function classify(row: LabeledFinding): Kind {
  switch (row.rule) {
    case 'page-metadata': {
      const judged = judgeMeta({ title: 'Page', description: '', lang: '', viewport: '', h1: 0 });
      return judged.bugs.length > 0 ? 'bug' : 'suggestion';
    }
    case 'autocomplete-only': {
      const outcome = outcomeForAxe({
        pageUrl: `https://${row.site}/`,
        serious: [],
        autocomplete: ['Login field "email" has no autocomplete attribute.'],
        info: [],
      });
      return outcome.status === 'failed' ? 'bug' : 'suggestion';
    }
    case 'mobile-overflow-noviewport': {
      const judged = judgeMobile({ overflow: 501, targets: [], hasViewport: false });
      return judged.bugs.length > 0 ? 'bug' : 'suggestion';
    }
    case 'pageerror-nav': {
      const oracle = oracleFromEvidence(
        [{ message: 'ads', sourceUrl: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js' }],
        [],
        'https://demoqa.com/elements',
      );
      return oracle ? 'bug' : 'suggestion';
    }
    case 'ti-trailing-slash-404': {
      const href = 'https://the-internet.herokuapp.com/add_remove_elements/';
      const order = planCrawlOrder({
        startUrl: 'https://the-internet.herokuapp.com/',
        maxPages: 2,
        edges: {
          'https://the-internet.herokuapp.com/': [{ url: href, text: 'Add/Remove Elements' }],
        },
      });
      return order.includes(href) && !order.includes('https://the-internet.herokuapp.com/add_remove_elements')
        ? 'dropped'
        : 'bug';
    }
    case 'pw-root-404':
    case 'pw-root-404-flow': {
      const start = 'https://demo.playwright.dev/todomvc';
      const seeded = seedCrawlQueue(start).some(item => item.url === 'https://demo.playwright.dev/');
      return seeded ? 'bug' : 'dropped';
    }
    case 'pb-invented-wsdl': {
      const siteMap: SiteMap = {
        startUrl: 'https://parabank.parasoft.com/parabank/index.htm',
        siteType: 'bank',
        summary: 'ParaBank.',
        pages: [{
          url: 'https://parabank.parasoft.com/parabank/index.htm',
          title: 'ParaBank',
          summary: 'Home.',
          interactive: [],
          outboundLinks: [],
          authGated: false,
        }],
        pendingUrls: [],
        failedUrls: [],
      };
      const flow: TestFlow = {
        id: 'wsdl',
        name: 'Open WSDL',
        description: 'Invented host.',
        kind: 'happy_path',
        startUrl: siteMap.startUrl,
        steps: [{ action: 'Open http://store.parabank.parasoft.com/?wsdl' }],
        expectation: 'Loads.',
        severityIfFails: 'major',
      };
      return findUncrawledReferences([flow], siteMap).length > 0 ? 'dropped' : 'bug';
    }
    case 'axe-serious': {
      const outcome = outcomeForAxe({
        pageUrl: `https://${row.site}/`,
        serious: [{ impact: 'serious', id: 'color-contrast', help: 'Elements must meet minimum color contrast ratio thresholds' }],
        autocomplete: [],
        info: [],
      });
      return outcome.status === 'failed' ? 'bug' : 'suggestion';
    }
    case 'ti-http-500': {
      const oracle = oracleFromEvidence([], [{
        url: 'http://the-internet.herokuapp.com/login',
        method: 'GET',
        status: 500,
        resourceType: 'document',
      }]);
      return oracle?.error === 'http-500' ? 'bug' : 'dropped';
    }
    case 'mixed-content':
    case 'bb-contact-500':
      return 'bug';
    default:
      throw new Error(`unclassified rule ${row.rule}`);
  }
}

describe('bake-off false-positive measurement', () => {
  it('keeps every real bug and stops reporting the labelled false positives', () => {
    const beforeReports = LABELS.reduce((sum, row) => sum + row.reports, 0);
    const beforeFp = LABELS.filter(row => row.label === 'FP').reduce((sum, row) => sum + row.reports, 0);
    const beforeReal = LABELS.filter(row => row.label === 'REAL').reduce((sum, row) => sum + row.reports, 0);
    let afterBugs = 0;
    let afterFpBugs = 0;
    let suggestions = 0;
    let dropped = 0;
    let realKept = 0;
    for (const row of LABELS) {
      const kind = classify(row);
      if (row.label === 'REAL') {
        expect(kind, row.rule).toBe('bug');
        realKept += row.reports;
        afterBugs += row.reports;
      } else if (kind === 'bug') {
        afterFpBugs += row.reports;
        afterBugs += row.reports;
      } else if (kind === 'suggestion') {
        suggestions += row.reports;
      } else {
        dropped += row.reports;
      }
    }
    const beforeRate = beforeFp / beforeReports;
    const afterRate = afterBugs === 0 ? 0 : afterFpBugs / afterBugs;
    expect(beforeReports).toBe(632);
    expect(beforeFp).toBe(260);
    expect(beforeReal).toBe(372);
    expect(Number((beforeRate * 100).toFixed(1))).toBe(41.1);
    expect(realKept).toBe(372);
    expect(afterFpBugs).toBe(0);
    expect(afterBugs).toBe(372);
    expect(afterRate).toBe(0);
    expect(suggestions).toBe(235);
    expect(dropped).toBe(25);
    expect(suggestions + dropped).toBe(beforeFp);
  });
});
