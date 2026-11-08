import { describe, expect, it } from 'vitest';
import {
  ADJUDICATION_PROTOCOL_ID,
  CURRENT_ADJUDICATION,
  FALSE_POSITIVE_GATE,
  FIXED_10_SITES,
  PRIOR_TWO_SITE_NOTE,
  corpusAuthorizesExecution,
  aggregateFalsePositiveRate,
  assignedSiteCount,
  coverageRatio,
  evaluateGate,
  falsePositiveRate,
  type AdjudicationReport,
  type SiteAdjudication,
} from '../src/audit/adjudication.js';

function row(partial: Pick<SiteAdjudication, 'siteId' | 'confirmedBugs' | 'falsePositives'> & Partial<SiteAdjudication>): SiteAdjudication {
  return {
    engineVersion: '0.7.2-beta.2',
    gitSha: 'abc',
    channel: 'source',
    depth: 'basic',
    models: { explorer: 'gpt-4o-mini', planner: 'gpt-4o', runner: 'gpt-4o-mini' },
    inScopePages: 4,
    pagesExplored: 2,
    misses: 0,
    inconclusiveFlows: 0,
    ...partial,
  };
}

describe('fixed 10-site adjudication protocol', () => {
  it('keeps 10 slots, leaves one unassigned, and does not call the gate passed', () => {
    expect(FIXED_10_SITES).toHaveLength(10);
    expect(assignedSiteCount()).toBe(9);
    expect(FIXED_10_SITES.filter(site => site.source === 'unassigned')).toHaveLength(1);
    expect(CURRENT_ADJUDICATION).toBeNull();
    expect(evaluateGate(CURRENT_ADJUDICATION)).toEqual({
      passed: false,
      rate: undefined,
      reason: 'A site slot is unassigned. The gate cannot be scored from a shorter list.',
    });
    expect(PRIOR_TWO_SITE_NOTE.sufficientForGate).toBe(false);
    expect(PRIOR_TWO_SITE_NOTE.sites).toHaveLength(2);
    expect(FALSE_POSITIVE_GATE).toBe(0.1);
    expect(corpusAuthorizesExecution()).toBe(false);
    expect(FIXED_10_SITES.every(site => site.authorizedToRun === false)).toBe(true);
    const jewellery = FIXED_10_SITES.find(site => site.id === 'jewellery-lovable');
    expect(jewellery?.customerSite).toBe(true);
    expect(jewellery?.startUrl).toBe('https://jewellerycasting08.lovable.app/');
    expect(FIXED_10_SITES.find(site => site.id === 'bananabeings')?.customerSite).toBe(true);
  });

  it('uses confirmed bugs as the denominator and does not treat zero bugs as 0%', () => {
    expect(falsePositiveRate(12, 0)).toBe(0);
    expect(falsePositiveRate(10, 1)).toBe(0.1);
    expect(falsePositiveRate(0, 0)).toBeUndefined();
    expect(falsePositiveRate(3, 4)).toBeUndefined();
    expect(aggregateFalsePositiveRate([
      { confirmedBugs: 0, falsePositives: 0 },
      { confirmedBugs: 8, falsePositives: 2 },
    ])).toBe(0.25);
    expect(coverageRatio(2, 4)).toBe(0.5);
    expect(coverageRatio(0, 0)).toBeUndefined();
  });

  it('rejects a two-site 0% sheet and accepts only a stamped 10-site rate under 10%', () => {
    const assigned = FIXED_10_SITES.map((site, index) => (
      site.startUrl ? site : { ...site, startUrl: 'https://example.test/unassigned', source: 'bake-off-corpus' as const }
    ));
    expect(assigned).toHaveLength(10);
    const twoSite: AdjudicationReport = {
      protocolId: ADJUDICATION_PROTOCOL_ID,
      sites: [
        row({ siteId: 'bananabeings', confirmedBugs: 12, falsePositives: 0 }),
        row({ siteId: 'slot-10', confirmedBugs: 0, falsePositives: 0 }),
      ],
    };
    expect(evaluateGate(twoSite, assigned).passed).toBe(false);

    const passing: AdjudicationReport = {
      protocolId: ADJUDICATION_PROTOCOL_ID,
      sites: assigned.map(site => row({ siteId: site.id, confirmedBugs: 10, falsePositives: 0 })),
    };
    const pass = evaluateGate(passing, assigned);
    expect(pass.passed).toBe(true);
    expect(pass.rate).toBe(0);

    const atGate: AdjudicationReport = {
      protocolId: ADJUDICATION_PROTOCOL_ID,
      sites: assigned.map(site => row({ siteId: site.id, confirmedBugs: 10, falsePositives: 1 })),
    };
    expect(evaluateGate(atGate, assigned).passed).toBe(false);
    expect(evaluateGate(atGate, assigned).rate).toBe(0.1);
  });

  it('fails closed on a bad row before it aggregates a flattering rate', () => {
    const assigned = FIXED_10_SITES.map(site => (
      site.startUrl ? site : { ...site, startUrl: 'https://example.test/unassigned', source: 'bake-off-corpus' as const }
    ));
    const sites = assigned.map(site => row({ siteId: site.id, confirmedBugs: 10, falsePositives: 0 }));
    sites[4] = row({
      siteId: assigned[4].id,
      confirmedBugs: 0,
      falsePositives: 0,
      inScopePages: 0,
      pagesExplored: 3,
      channel: 'prod' as SiteAdjudication['channel'],
    });
    const result = evaluateGate({ protocolId: ADJUDICATION_PROTOCOL_ID, sites }, assigned);
    expect(result.passed).toBe(false);
    expect(result.rate).toBeUndefined();
    expect(result.reason).toContain(assigned[4].id);
    expect(CURRENT_ADJUDICATION).toBeNull();
    expect(FIXED_10_SITES.every(site => site.authorizedToRun === false)).toBe(true);

    const counted = gateWith(assigned, { siteId: 'saucedemo', confirmedBugs: 2, falsePositives: 9 });
    expect(counted.passed).toBe(false);
    expect(counted.rate).toBeUndefined();
    expect(counted.reason).toMatch(/falsePositives/);

    const coverage = gateWith(assigned, {
      siteId: 'the-internet',
      confirmedBugs: 4,
      falsePositives: 0,
      pagesExplored: 8,
      inScopePages: 2,
    });
    expect(coverage.passed).toBe(false);
    expect(coverage.rate).toBeUndefined();
    expect(coverage.reason).toMatch(/pagesExplored/);

    const fraction = gateWith(assigned, {
      siteId: 'demoqa',
      confirmedBugs: 1.5 as unknown as number,
      falsePositives: 0,
    });
    expect(fraction.passed).toBe(false);
    expect(fraction.rate).toBeUndefined();
    expect(fraction.reason).toMatch(/confirmedBugs/);
  });
});

function gateWith(
  assigned: typeof FIXED_10_SITES,
  bad: Pick<SiteAdjudication, 'siteId' | 'confirmedBugs' | 'falsePositives'> & Partial<SiteAdjudication>,
) {
  const sites = assigned.map(site => row({ siteId: site.id, confirmedBugs: 10, falsePositives: 0 }));
  const index = sites.findIndex(site => site.siteId === bad.siteId);
  sites[index] = row(bad);
  return evaluateGate({ protocolId: ADJUDICATION_PROTOCOL_ID, sites }, assigned);
}
