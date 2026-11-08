/**
 * Fixed 10-site false-positive protocol.
 *
 * This module does not fetch any site. The in-repo result is `null`:
 * the gate has not been measured. A historical 0% note on two sites is
 * not a measurement of this set.
 *
 * Denominator: confirmed bugs the engine filed (`bugs[]`). Suggestions,
 * inconclusive flows, and pages are not the denominator. Zero confirmed
 * bugs is an undefined rate, not 0%.
 *
 * Aggregate rate sums counts across sites. It does not average per-site
 * rates, so a site with no bugs cannot dilute a site with false positives.
 *
 * Coverage and misses are reported beside the rate. Misses are known
 * defects that no filed bug matched. They are not false positives.
 */

export const ADJUDICATION_PROTOCOL_ID = 'fixed-10-2026-11-08';

/** Gate threshold. A lower rate is required. Equality does not pass. */
export const FALSE_POSITIVE_GATE = 0.1;

export type AdjudicationSource = 'bake-off-corpus' | 'unassigned';

export interface AdjudicationSite {
  id: string;
  /**
   * Start URL for a future adjudicated run. `null` means the slot is not
   * assigned. This file does not request the URL.
   */
  startUrl: string | null;
  source: AdjudicationSource;
}

/**
 * Nine hosts are the hand-labelled bake-off corpus in
 * `test/fp-measurement.test.ts`. The tenth slot stays unassigned: that
 * corpus has no tenth host, and this change does not invent one or crawl
 * a customer site to fill the table.
 */
export const FIXED_10_SITES: readonly AdjudicationSite[] = [
  { id: 'automationexercise', startUrl: 'https://automationexercise.com/', source: 'bake-off-corpus' },
  { id: 'bananabeings', startUrl: 'https://bananabeings.com/', source: 'bake-off-corpus' },
  { id: 'playwright-todomvc', startUrl: 'https://demo.playwright.dev/todomvc', source: 'bake-off-corpus' },
  { id: 'demoqa', startUrl: 'https://demoqa.com/', source: 'bake-off-corpus' },
  { id: 'jewellery-lovable', startUrl: 'https://jewellerycasting08.lovable.app/', source: 'bake-off-corpus' },
  { id: 'parabank', startUrl: 'https://parabank.parasoft.com/parabank/index.htm', source: 'bake-off-corpus' },
  { id: 'practice-software-testing', startUrl: 'https://practicesoftwaretesting.com/', source: 'bake-off-corpus' },
  { id: 'the-internet', startUrl: 'https://the-internet.herokuapp.com/', source: 'bake-off-corpus' },
  { id: 'saucedemo', startUrl: 'https://www.saucedemo.com/', source: 'bake-off-corpus' },
  { id: 'slot-10', startUrl: null, source: 'unassigned' },
];

/**
 * Release-note figure for 0.7.1: 0 of 12 bugs on two hosts. Recorded here
 * so a reader can see why it does not close the gate.
 */
export const PRIOR_TWO_SITE_NOTE = {
  sites: ['app.monkeytest.ai', 'bananabeings.com'],
  claimedFalsePositives: 0,
  claimedConfirmedBugs: 12,
  engine: '0.7.1',
  sufficientForGate: false as const,
  reason: 'The gate is a false-positive rate under 10% on all 10 assigned sites. Two sites are not that set.',
};

export interface SiteAdjudication {
  siteId: string;
  engineVersion: string;
  gitSha: string;
  /** `latest`, `next`, or `source` when the binary was this checkout. */
  channel: 'latest' | 'next' | 'source';
  depth: string;
  models: { explorer: string; planner: string; runner: string };
  /** Confirmed bugs filed. This is the per-site denominator. */
  confirmedBugs: number;
  falsePositives: number;
  inScopePages: number;
  pagesExplored: number;
  /** Known defects with no matching filed bug. */
  misses: number;
  inconclusiveFlows: number;
}

export interface AdjudicationReport {
  protocolId: string;
  sites: SiteAdjudication[];
}

/** No completed fixed-10 adjudication is stored in this repository. */
export const CURRENT_ADJUDICATION: AdjudicationReport | null = null;

export interface GateResult {
  passed: boolean;
  reason: string;
  rate: number | undefined;
}

export function assignedSiteCount(sites: readonly AdjudicationSite[] = FIXED_10_SITES): number {
  return sites.filter(site => site.source !== 'unassigned' && site.startUrl).length;
}

/**
 * False positives divided by confirmed bugs. `undefined` when the
 * denominator is 0, or when false positives exceed the denominator.
 */
export function falsePositiveRate(confirmedBugs: number, falsePositives: number): number | undefined {
  if (!Number.isInteger(confirmedBugs) || !Number.isInteger(falsePositives)) return undefined;
  if (confirmedBugs <= 0 || falsePositives < 0 || falsePositives > confirmedBugs) return undefined;
  return falsePositives / confirmedBugs;
}

export function aggregateFalsePositiveRate(rows: Array<Pick<SiteAdjudication, 'confirmedBugs' | 'falsePositives'>>): number | undefined {
  const confirmed = rows.reduce((sum, row) => sum + row.confirmedBugs, 0);
  const falsePositives = rows.reduce((sum, row) => sum + row.falsePositives, 0);
  return falsePositiveRate(confirmed, falsePositives);
}

/** Pages explored divided by the adjudicator's in-scope page list. */
export function coverageRatio(pagesExplored: number, inScopePages: number): number | undefined {
  if (!Number.isInteger(pagesExplored) || !Number.isInteger(inScopePages)) return undefined;
  if (inScopePages <= 0 || pagesExplored < 0) return undefined;
  return pagesExplored / inScopePages;
}

export function evaluateGate(
  report: AdjudicationReport | null,
  sites: readonly AdjudicationSite[] = FIXED_10_SITES,
): GateResult {
  if (sites.length !== 10) {
    return { passed: false, rate: undefined, reason: 'The protocol is a fixed set of 10 sites.' };
  }
  if (assignedSiteCount(sites) !== 10) {
    return {
      passed: false,
      rate: undefined,
      reason: 'A site slot is unassigned. The gate cannot be scored from a shorter list.',
    };
  }
  if (!report) {
    return { passed: false, rate: undefined, reason: 'No fixed-10 adjudication is recorded.' };
  }
  if (report.protocolId !== ADJUDICATION_PROTOCOL_ID) {
    return { passed: false, rate: undefined, reason: 'The report is for a different protocol id.' };
  }
  if (report.sites.length !== 10) {
    return { passed: false, rate: undefined, reason: 'The report does not contain 10 site rows.' };
  }
  const ids = new Set(sites.map(site => site.id));
  if (report.sites.some(row => !ids.has(row.siteId))) {
    return { passed: false, rate: undefined, reason: 'The report names a site outside the frozen set.' };
  }
  if (new Set(report.sites.map(row => row.siteId)).size !== 10) {
    return { passed: false, rate: undefined, reason: 'The report repeats a site or omits one.' };
  }
  for (const row of report.sites) {
    if (!row.engineVersion || !row.gitSha || !row.depth || !row.models.explorer || !row.models.planner || !row.models.runner) {
      return { passed: false, rate: undefined, reason: 'A site row is missing its version stamp.' };
    }
  }
  const rate = aggregateFalsePositiveRate(report.sites);
  if (rate === undefined) {
    return {
      passed: false,
      rate: undefined,
      reason: 'The false-positive rate is undefined. A set that filed no confirmed bugs is not 0%.',
    };
  }
  if (rate >= FALSE_POSITIVE_GATE) {
    return { passed: false, rate, reason: 'The false-positive rate is not under 10%.' };
  }
  return { passed: true, rate, reason: 'The recorded fixed-10 adjudication is under 10%.' };
}
