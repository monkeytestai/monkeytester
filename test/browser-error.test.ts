/**
 * A browser error page is never a pass. The bug's page is the last real
 * http(s) URL, live and replay share a fingerprint, and replay does not
 * repeat the opening `Open <url>` step.
 */

import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { mergeLocatorIdentity } from '../src/runner/actions.js';
import {
  browserErrorObservation,
  browserErrorVerdict,
  firstHttpPageUrl,
  guardBrowserObservation,
  isBrowserInternalUrl,
  settleActionBrowserError,
} from '../src/runner/browserError.js';
import { EMPTY_CONTACT_VALIDATION } from '../src/runner/sensitive.js';
import { evaluateOutcomeCheck } from '../src/outcome/check.js';
import { failureLocation, fingerprintFailure } from '../src/trace/fingerprint.js';
import { triage } from '../src/triager/index.js';
import type { FlowResult, RunResult, StepResult, TraceLocator } from '../src/types.js';

const HELP = 'https://bananabeings.com/help';
const CHROME_ERROR = 'chrome-error://chromewebdata/';

describe('browser error pages', () => {
  it('recognises browser-internal error URLs and keeps http pages', () => {
    expect(isBrowserInternalUrl(CHROME_ERROR)).toBe(true);
    expect(isBrowserInternalUrl('about:neterror?e=dnsNotFound')).toBe(true);
    expect(isBrowserInternalUrl('edge-error://edgewebdata/')).toBe(true);
    expect(isBrowserInternalUrl('about:certerror')).toBe(true);
    expect(isBrowserInternalUrl(HELP)).toBe(false);
    expect(isBrowserInternalUrl('about:blank')).toBe(false);
    expect(firstHttpPageUrl([CHROME_ERROR, HELP])).toBe(HELP);
  });

  it('does not pass any outcome check on an error page', () => {
    const kinds = [
      'url_changed',
      'url_includes',
      'text_absent',
      'element_absent',
      'observable_response',
      'text_visible',
      'validation_visible',
    ] as const;
    for (const kind of kinds) {
      const verdict = browserErrorVerdict(CHROME_ERROR, {
        networkFailures: [{
          url: HELP,
          method: 'GET',
          failureText: 'net::ERR_CONNECTION_REFUSED',
          resourceType: 'document',
        }],
      }, 'net::ERR_CONNECTION_REFUSED');
      expect(verdict?.state, kind).not.toBe('verified');
      expect(verdict?.state, kind).toBe('failed');
      expect(verdict?.observation).toBe(browserErrorObservation('net::ERR_CONNECTION_REFUSED'));
    }
    const firefox = browserErrorVerdict('about:neterror?e=connectionFailure', {}, 'net::ERR_CONNECTION_REFUSED');
    expect(firefox?.state).toBe('failed');
    expect(firefox?.observation).toContain('net::ERR_CONNECTION_REFUSED');
  });

  it('is inconclusive when our guard aborted the request', () => {
    const verdict = browserErrorVerdict(CHROME_ERROR, {
      guardCaused: true,
      networkFailures: [{
        url: `${HELP}/contact`,
        method: 'POST',
        failureText: 'net::ERR_BLOCKED_BY_CLIENT',
        resourceType: 'document',
      }],
    }, 'net::ERR_BLOCKED_BY_CLIENT');
    expect(verdict?.state).toBe('unverifiable');
    expect(verdict?.state).not.toBe('verified');
    expect(verdict?.observation).toBe(guardBrowserObservation('net::ERR_BLOCKED_BY_CLIENT'));
    expect(verdict?.observation).toContain('request_blocked');

    const fromTheNetError = browserErrorVerdict(CHROME_ERROR, {}, 'net::ERR_BLOCKED_BY_CLIENT');
    expect(fromTheNetError?.state).toBe('unverifiable');
  });

  it('turns a passed action on an error page into a named failure, and keeps an empty-contact bug', () => {
    const failed = settleActionBrowserError(
      { status: 'passed', observation: 'Clicked button:Submit.' },
      CHROME_ERROR,
      [{ url: HELP, method: 'GET', failureText: 'net::ERR_NAME_NOT_RESOLVED', resourceType: 'document' }],
    );
    expect(failed.status).toBe('failed');
    expect(failed.observation).toContain('net::ERR_NAME_NOT_RESOLVED');

    const blocked = settleActionBrowserError(
      { status: 'passed', observation: 'Clicked button:Submit.' },
      CHROME_ERROR,
      [{ url: HELP, method: 'POST', failureText: 'net::ERR_BLOCKED_BY_CLIENT', resourceType: 'document' }],
    );
    expect(blocked.status).toBe('skipped');
    expect(blocked.error).toBe('request_blocked');

    const emptyContact = settleActionBrowserError(
      { status: 'failed', observation: EMPTY_CONTACT_VALIDATION, error: 'missing-validation' },
      CHROME_ERROR,
      [{ url: HELP, method: 'POST', failureText: 'net::ERR_BLOCKED_BY_CLIENT', resourceType: 'document' }],
    );
    expect(emptyContact.status).toBe('failed');
    expect(emptyContact.error).toBe('missing-validation');
    expect(emptyContact.observation).toBe(EMPTY_CONTACT_VALIDATION);
  });

  it('does not verify a live page that Chrome replaced with an error page', async () => {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    try {
      await page.goto('data:text/html,<p>Hello help</p>');
      const ok = await evaluateOutcomeCheck(page, { kind: 'text_visible', value: 'Hello help' }, {
        startUrl: HELP,
      });
      expect(ok.state).toBe('verified');

      await page.goto('http://127.0.0.1:59999/', { timeout: 4_000, waitUntil: 'commit' }).catch(() => {});
      await page.waitForURL(/^chrome-error:/, { timeout: 4_000 });
      expect(page.url()).toMatch(/^chrome-error:/);
      const checks = [
        { kind: 'url_changed' as const },
        { kind: 'text_absent' as const, value: 'Thanks' },
        { kind: 'element_absent' as const, value: 'Submit' },
        { kind: 'observable_response' as const },
        { kind: 'url_includes' as const, value: '/help' },
      ];
      for (const check of checks) {
        const verdict = await evaluateOutcomeCheck(page, check, {
          startUrl: HELP,
          before: { url: HELP, signal: 'help form' },
          networkFailures: [{
            url: HELP,
            method: 'GET',
            failureText: 'net::ERR_CONNECTION_REFUSED',
            resourceType: 'document',
          }],
        });
        expect(verdict.state, check.kind).not.toBe('verified');
        expect(verdict.observation).toContain('net::ERR_CONNECTION_REFUSED');
      }

      const guarded = await evaluateOutcomeCheck(page, { kind: 'url_changed' }, {
        startUrl: HELP,
        guardCaused: true,
        networkFailures: [{
          url: `${HELP}/contact`,
          method: 'POST',
          failureText: 'net::ERR_BLOCKED_BY_CLIENT',
          resourceType: 'document',
        }],
      });
      expect(guarded.state).toBe('unverifiable');
      expect(guarded.observation).toContain('request_blocked');
    } finally {
      await browser.close();
    }
  }, 20_000);
});

describe('bug page_url', () => {
  it('uses the last http page before the action, never chrome-error', () => {
    const run = triage(runWith(failedContactStep(), {
      urlBefore: HELP,
      urlAfter: CHROME_ERROR,
    }));
    expect(run.bugs).toHaveLength(1);
    expect(run.bugs[0].page_url).toBe(HELP);
    expect(run.bugs[0].page_url).not.toMatch(/chrome-error:|about:neterror|edge-error:/);
    expect(run.bugs[0].observed).toMatch(/nothing sent/i);
  });
});

describe('fingerprints', () => {
  const liveLocator: TraceLocator = {
    strategy: 'role',
    target: 'button:Submit',
    role: 'button',
    name: 'Submit',
    testId: 'contact-submit',
  };
  const replayTestId: TraceLocator = {
    strategy: 'testid',
    target: 'contact-submit',
    testId: 'contact-submit',
  };

  it('gives the empty-contact bug the same fpV2 when replay only matched a test id', () => {
    const merged = mergeLocatorIdentity(replayTestId, liveLocator);
    const shared = {
      tool: 'click',
      action: 'Click "Submit"',
      error: 'missing-validation',
      observation: EMPTY_CONTACT_VALIDATION,
      location: HELP,
    };
    const live = fingerprintFailure({ ...shared, locator: liveLocator, target: 'button:Submit' });
    const replay = fingerprintFailure({ ...shared, locator: merged, target: 'contact-submit' });
    const thin = fingerprintFailure({ ...shared, locator: replayTestId, target: 'contact-submit' });
    expect(replay.fingerprintV2).toBe(live.fingerprintV2);
    expect(replay.parts).toEqual(live.parts);
    expect(thin.fingerprintV2).not.toBe(live.fingerprintV2);
    expect(thin.parts.role).toBe('');
    expect(thin.parts.name).toBe('');
    expect(replay.parts.role).toBe('button');
    expect(replay.parts.name).toBe('submit');

    const liveBug = triage(runWith(failedContactStep(), {
      urlBefore: HELP,
      urlAfter: CHROME_ERROR,
      locator: liveLocator,
      target: 'button:Submit',
    })).bugs[0];
    const replayBug = triage(runWith(failedContactStep(), {
      urlBefore: HELP,
      urlAfter: CHROME_ERROR,
      locator: merged,
      target: 'contact-submit',
    })).bugs[0];
    expect(replayBug.fingerprintV2).toBe(liveBug.fingerprintV2);
    expect(failureLocation({
      tool: 'click',
      urlBefore: HELP,
      urlAfter: CHROME_ERROR,
      fallback: HELP,
    })).toBe(HELP);
  });

  it('keeps a normal http location in the fingerprint', () => {
    const located = failureLocation({
      tool: 'click',
      urlBefore: 'https://shop.example/checkout',
      urlAfter: 'https://shop.example/checkout',
    });
    expect(located).toBe('https://shop.example/checkout');
    const hash = fingerprintFailure({
      tool: 'click',
      error: 'pageerror: boom',
      location: located,
      locator: { strategy: 'role', target: 'button:Save', role: 'button', name: 'Save' },
    });
    expect(hash.parts.location).toBe('https://shop.example/checkout');
    expect(hash.parts.role).toBe('button');
    expect(hash.fingerprintV2).toBe(fingerprintFailure({
      tool: 'fill',
      error: 'pageerror: boom',
      location: 'https://shop.example/checkout',
      locator: { strategy: 'role', target: 'button:Save', role: 'button', name: 'Save' },
    }).fingerprintV2);
  });
});

describe('replay repro steps', () => {
  it('does not list the same Open url twice in a row', () => {
    const run = triage(runWith(failedContactStep(), {
      urlBefore: HELP,
      urlAfter: CHROME_ERROR,
      openingAction: `Open ${HELP}/`,
    }));
    const bug = run.bugs[0];
    expect(bug.reproSteps).toEqual([
      `Open ${HELP}`,
      'Click "Submit"',
    ]);
    for (let i = 1; i < bug.reproSteps.length; i++) {
      expect(bug.reproSteps[i]).not.toBe(bug.reproSteps[i - 1]);
    }
  });
});

describe('net error classification', () => {
  it('files a mid-flow net error as a failure and leaves the starting page unreachable', () => {
    const refused = triage(runWith({
      index: 2,
      action: 'Open the help page',
      expectation: 'The help page loads.',
      status: 'failed',
      observation: 'Goto on https://bananabeings.com/help failed: net::ERR_CONNECTION_REFUSED',
      tool: 'goto',
      target: HELP,
      error: 'net::ERR_CONNECTION_REFUSED',
      networkFailures: [{
        url: HELP,
        method: 'GET',
        failureText: 'net::ERR_CONNECTION_REFUSED',
        resourceType: 'document',
      }],
    }, { urlBefore: 'https://bananabeings.com/', urlAfter: CHROME_ERROR }));
    expect(refused.bugs).toHaveLength(1);
    expect(refused.bugs[0].page_url).toBe('https://bananabeings.com/');
    expect(refused.bugs[0].evidence.networkFailures.some(item => item.failureText === 'net::ERR_CONNECTION_REFUSED')).toBe(true);
    expect(refused.bugs[0].observed).toContain('net::ERR_CONNECTION_REFUSED');
    expect(refused.outcome).toBe('bugs_found');

    const blocked = triage(runWith({
      index: 2,
      action: 'Click "Submit"',
      status: 'failed',
      observation: 'Click on button:Submit failed: net::ERR_BLOCKED_BY_CLIENT',
      tool: 'click',
      target: 'button:Submit',
      error: 'net::ERR_BLOCKED_BY_CLIENT',
    }, { urlBefore: HELP, urlAfter: CHROME_ERROR }));
    expect(blocked.bugs).toEqual([]);
    expect(blocked.flows[0].status).toBe('inconclusive');
    expect(blocked.flows[0].outcome_reason).toBe('request_blocked');
    expect(blocked.outcome).not.toBe('bugs_found');

    const starting = triage(runWith({
      index: 0,
      action: `Open ${HELP}`,
      status: 'failed',
      observation: 'Could not load the starting page (net::ERR_NAME_NOT_RESOLVED).',
      tool: 'goto',
      target: HELP,
      error: 'net::ERR_NAME_NOT_RESOLVED',
    }), { pagesVisited: 0 });
    expect(starting.bugs).toHaveLength(0);
    expect(starting.outcome).toBe('could_not_test');
    expect(starting.outcome_reason).toBe('site_unreachable');
  });
});

function failedContactStep(): StepResult {
  return {
    index: 1,
    action: 'Click "Submit"',
    expectation: 'A validation message is shown.',
    status: 'failed',
    observation: EMPTY_CONTACT_VALIDATION,
    tool: 'click',
    target: 'button:Submit',
    error: 'missing-validation',
  };
}

function runWith(
  step: StepResult,
  extra: {
    urlBefore?: string;
    urlAfter?: string;
    locator?: TraceLocator;
    target?: string;
    openingAction?: string;
  } = {},
): RunResult {
  const locator = extra.locator ?? {
    strategy: 'role' as const,
    target: 'button:Submit',
    role: 'button',
    name: 'Submit',
    testId: 'contact-submit',
  };
  const failed: StepResult = {
    ...step,
    locator,
    ...(extra.target ? { target: extra.target } : {}),
  };
  const flow: FlowResult = {
    flowId: 'help-contact',
    name: 'Help contact',
    description: 'Submit the empty contact form and expect a validation message.',
    kind: 'edge_case',
    startUrl: HELP,
    status: 'failed',
    steps: [
      {
        index: 0,
        action: extra.openingAction || `Open ${HELP}`,
        status: 'passed',
        observation: 'Navigated.',
        tool: 'goto',
      },
      failed,
    ],
    durationMs: 10,
    bugIds: [],
    trace: {
      version: 1,
      flowId: 'help-contact',
      name: 'Help contact',
      startUrl: HELP,
      steps: [
        {
          index: 0,
          tool: 'goto',
          action: extra.openingAction || `Open ${HELP}`,
          status: 'passed',
          locator: { strategy: 'css', target: HELP },
          urlAfter: HELP,
        },
        {
          index: failed.index,
          tool: (failed.tool || 'click') as 'click',
          action: failed.action,
          status: 'failed',
          error: failed.error,
          locator,
          urlBefore: extra.urlBefore || HELP,
          urlAfter: extra.urlAfter || HELP,
        },
      ],
    },
  };
  return {
    startUrl: HELP,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    flows: [flow],
    bugs: [],
    stats: {
      flowsTotal: 1, flowsPassed: 0, flowsFailed: 1, flowsBlocked: 0, flowsInconclusive: 0,
      stepsTotal: 2, stepsPassed: 1, stepsFailed: 1,
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
  };
}
