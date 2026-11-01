/**
 * One engine flow per deterministic check.
 *
 * Ids are reserved (`check-*`). They are not part of the LLM flow budget
 * and `reconcileModelFlows` never sees them. Each flow has one step per
 * crawled page, capped by the page limit the caller passes.
 */

import { BASIC_PRESET } from '../depth.js';
import type { FlowKind, PageCheck, SiteMap, TestFlow, TestStep } from '../types.js';

export const PAGE_CHECK_PREFIX = 'check-';

export interface PageCheckSpec {
  id: string;
  pageCheck: PageCheck;
  kind: FlowKind;
  severityIfFails: TestFlow['severityIfFails'];
  name: string;
  description: string;
  expectation: string;
  /** Short verb used in the step action. */
  action: string;
}

export const PAGE_CHECK_SPECS: readonly PageCheckSpec[] = [
  {
    id: 'check-console',
    pageCheck: 'console',
    kind: 'visual',
    severityIfFails: 'major',
    name: 'Console errors on load',
    description: 'First-party console errors and uncaught exceptions while the page loads.',
    expectation: 'The page loads without a first-party console error or uncaught exception.',
    action: 'Check console errors',
  },
  {
    id: 'check-http',
    pageCheck: 'http',
    kind: 'visual',
    severityIfFails: 'major',
    name: 'Broken requests and links',
    description: 'Same-site requests that fail or return 4xx/5xx, and same-site links checked over HTTP without opening them.',
    expectation: 'Same-site documents, scripts, and links respond without a 4xx or 5xx.',
    action: 'Check failed requests and broken links',
  },
  {
    id: 'check-axe',
    pageCheck: 'axe',
    kind: 'accessibility',
    severityIfFails: 'major',
    name: 'WCAG A and AA',
    description: 'axe-core WCAG A and AA. Serious and critical violations are bugs. Other hits are info. A missing autocomplete on a login field is a suggestion, not a bug.',
    expectation: 'The page has no serious or critical WCAG A/AA violation.',
    action: 'Check WCAG A and AA',
  },
  {
    id: 'check-mobile',
    pageCheck: 'mobile',
    kind: 'visual',
    severityIfFails: 'minor',
    name: 'Mobile layout',
    description: 'Horizontal overflow and tap-target size at a 375px viewport. Overflow on a page with no viewport meta is a suggestion.',
    expectation: 'At 375px the page does not overflow sideways and primary controls are large enough to tap.',
    action: 'Check mobile overflow and tap targets',
  },
  {
    id: 'check-meta',
    pageCheck: 'meta',
    kind: 'accessibility',
    severityIfFails: 'minor',
    name: 'Page metadata',
    description: 'Title, meta description, lang, viewport, and a single h1. A missing title is a bug. Viewport and description are suggestions. Lang and h1 count are info.',
    expectation: 'The page has a title.',
    action: 'Check title, description, lang, viewport, and h1',
  },
];

export function isPageCheckFlowId(id: string): boolean {
  return id.startsWith(PAGE_CHECK_PREFIX);
}

export function isPageCheck(value: string | undefined): value is PageCheck {
  return PAGE_CHECK_SPECS.some(spec => spec.pageCheck === value);
}

export function pageCheckSpec(kind: PageCheck): PageCheckSpec {
  const spec = PAGE_CHECK_SPECS.find(item => item.pageCheck === kind);
  if (!spec) throw new Error(`Unknown page check "${kind}"`);
  return spec;
}

export interface PageCheckPlan {
  flows: TestFlow[];
  note?: string;
}

/**
 * Build the reserved check flows. Empty when the crawl has no pages.
 * `maxPages` slices the sitemap so a host that passes a longer map still
 * stays inside the page cap. The check-type cap is `BASIC_PRESET`.
 */
export function buildPageCheckFlows(siteMap: SiteMap, maxPages?: number): PageCheckPlan {
  const cap = maxPages && maxPages > 0 ? maxPages : siteMap.pages.length;
  const pages = siteMap.pages.slice(0, cap);
  if (pages.length === 0) return { flows: [] };

  const specs = PAGE_CHECK_SPECS.slice(0, BASIC_PRESET.engineFlowCaps.checks);
  const flows = specs.map(spec => {
    const steps: TestStep[] = pages.map(page => ({
      action: `${spec.action} on ${page.url}`,
      expectation: spec.expectation,
      pageCheck: spec.pageCheck,
      url: page.url,
    }));
    return {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      kind: spec.kind,
      startUrl: pages[0].url,
      steps,
      expectation: spec.expectation,
      severityIfFails: spec.severityIfFails,
    };
  });

  return {
    flows,
    note: `Added ${flows.length} page checks (${specs.map(spec => spec.pageCheck).join(', ')}) outside the flow budget.`,
  };
}
