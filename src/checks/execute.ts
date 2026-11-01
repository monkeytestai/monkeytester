/**
 * Run the reserved page checks in one browser pass.
 *
 * Each crawled URL is opened once. Every check type records its own step
 * with `tool: 'check'`. A failure on one page does not skip the other pages.
 * When `deadlineAt` has passed, the remaining pages are skipped. That is
 * not a timeout error.
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page, Response } from 'playwright';
import type {
  ConsoleErrorEvidence,
  FlowResult,
  NetworkFailureEvidence,
  PageCheck,
  StepResult,
  TestFlow,
  TraceStep,
} from '../types.js';
import { resolveFlowStatus } from '../runner/flowStatus.js';
import { serializeTrace, serializeTraceStep } from '../trace/serialize.js';
import { isPageCheck, pageCheckSpec } from './plan.js';
import { consoleEvidence, judgeConsole, type ConsoleHit } from './console.js';
import {
  BROKEN_LINK_CAP,
  isBrokenStatus,
  isReportableRequest,
  linkEvidence,
  requestEvidence,
  sameSiteLinks,
  type ObservedRequest,
} from './http.js';
import { readMissingLoginAutocomplete, runAxe } from './axe.js';
import { judgeMeta, readMetaInPage } from './meta.js';
import { judgeMobile, MOBILE_VIEWPORT, readMobileInPage } from './mobile.js';

export interface CheckStepOutcome {
  status: 'passed' | 'failed' | 'skipped';
  observation: string;
  error?: string;
  severity?: 'critical' | 'major' | 'minor';
  consoleErrors?: ConsoleErrorEvidence[];
  networkFailures?: NetworkFailureEvidence[];
}

interface Collected {
  hits: ConsoleHit[];
  requests: ObservedRequest[];
}

export interface LinkBudget {
  remaining: number;
}

export interface ExecuteChecksOptions {
  screenshotsDir: string;
  stepTimeoutMs: number;
  /** Epoch ms. Pages not started by then are skipped. */
  deadlineAt?: number;
  onFlowStart?: (flow: TestFlow) => void;
  onStep?: (flow: TestFlow, result: StepResult) => void;
  onFlowComplete?: (result: FlowResult) => void;
}

const buckets = new WeakMap<Page, Collected>();

function bucket(page: Page): Collected {
  let found = buckets.get(page);
  if (!found) {
    found = { hits: [], requests: [] };
    buckets.set(page, found);
    const target = found;
    page.on('console', message => {
      if (message.type() !== 'error') return;
      target.hits.push({
        kind: 'console',
        message: message.text(),
        sourceUrl: message.location()?.url,
      });
    });
    page.on('pageerror', error => {
      target.hits.push({ kind: 'pageerror', message: error.message });
    });
    page.on('response', response => {
      const status = response.status();
      if (status < 400) return;
      const request = response.request();
      target.requests.push({
        url: response.url(),
        method: request.method(),
        status,
        resourceType: request.resourceType(),
      });
    });
    page.on('requestfailed', request => {
      target.requests.push({
        url: request.url(),
        method: request.method(),
        failureText: request.failure()?.errorText,
        resourceType: request.resourceType(),
      });
    });
  }
  return found;
}

function resetCollected(collected: Collected): void {
  collected.hits.length = 0;
  collected.requests.length = 0;
}

function clip(value: string, max = 500): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function withInfo(main: string, info: string[]): string {
  const extra = info.filter(Boolean);
  const text = extra.length ? `${main} Info: ${extra.join(' ')}` : main;
  return clip(text);
}

function skipped(observation: string): CheckStepOutcome {
  return { status: 'skipped', observation };
}

function passed(observation: string, info: string[] = []): CheckStepOutcome {
  return { status: 'passed', observation: withInfo(observation, info) };
}

function failed(
  observation: string,
  error: string,
  extra: Partial<CheckStepOutcome> = {},
  info: string[] = [],
): CheckStepOutcome {
  return {
    status: 'failed',
    observation: withInfo(observation, info),
    error: clip(error, 240),
    ...extra,
  };
}

export async function replayPageCheck(
  page: Page,
  kind: PageCheck,
  url: string,
  timeoutMs: number,
): Promise<CheckStepOutcome> {
  const collected = bucket(page);
  resetCollected(collected);
  if (kind === 'mobile') {
    await page.setViewportSize(MOBILE_VIEWPORT).catch(() => {});
  }
  let response: Response | null = null;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  } catch (err) {
    return loadFailure(kind, url, err);
  }
  await page.waitForTimeout(200).catch(() => {});
  return assessLoadedPage(page, kind, url, collected, { remaining: BROKEN_LINK_CAP }, response?.status());
}

export async function executePageChecks(
  browser: Browser,
  flows: TestFlow[],
  opts: ExecuteChecksOptions,
): Promise<FlowResult[]> {
  if (flows.length === 0) return [];
  mkdirSync(opts.screenshotsDir, { recursive: true });
  for (const flow of flows) opts.onFlowStart?.(flow);

  const desktop = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const mobile = await browser.newContext({ viewport: MOBILE_VIEWPORT });
  const desktopPage = await desktop.newPage();
  const mobilePage = await mobile.newPage();
  const linkBudget: LinkBudget = { remaining: BROKEN_LINK_CAP };
  const steps = new Map<string, StepResult[]>();
  const traces = new Map<string, TraceStep[]>();
  for (const flow of flows) {
    steps.set(flow.id, []);
    traces.set(flow.id, []);
  }

  const urls = flowUrls(flows[0]);
  let budgetUsed = false;

  try {
    for (const url of urls) {
      if (budgetUsed || (opts.deadlineAt !== undefined && Date.now() > opts.deadlineAt)) {
        budgetUsed = true;
        for (const flow of flows) {
          await record(flow, url, skipped('Skipped: the run finished its time budget before this check.'), opts, steps, traces);
        }
        continue;
      }

      const collected = bucket(desktopPage);
      resetCollected(collected);
      let response: Response | null = null;
      let loadError: unknown;
      try {
        response = await desktopPage.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.stepTimeoutMs });
      } catch (err) {
        loadError = err;
      }
      if (!loadError) await desktopPage.waitForTimeout(200).catch(() => {});
      const status = response?.status();

      for (const flow of flows) {
        const kind = kindOf(flow);
        if (!kind || kind === 'mobile') continue;
        const outcome = loadError
          ? loadFailure(kind, url, loadError)
          : status && status >= 400 && kind !== 'http'
            ? skipped(`Page responded HTTP ${status}, so this check was not run.`)
            : await assessLoadedPage(desktopPage, kind, url, collected, linkBudget, status);
        await record(flow, url, outcome, opts, steps, traces, desktopPage);
      }

      const mobileFlow = flows.find(flow => kindOf(flow) === 'mobile');
      if (mobileFlow) {
        if (loadError || (status && status >= 400)) {
          await record(mobileFlow, url, skipped('Page did not load, so the mobile check was not run.'), opts, steps, traces);
        } else {
          let mobileError: unknown;
          try {
            await mobilePage.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.stepTimeoutMs });
            await mobilePage.waitForTimeout(100).catch(() => {});
          } catch (err) {
            mobileError = err;
          }
          const outcome = mobileError
            ? skipped('Page did not load at 375px, so the mobile check was not run.')
            : await assessLoadedPage(mobilePage, 'mobile', url, bucket(mobilePage), linkBudget);
          await record(mobileFlow, url, outcome, opts, steps, traces, mobilePage);
        }
      }
    }
  } finally {
    await desktop.close().catch(() => {});
    await mobile.close().catch(() => {});
  }

  return flows.map(flow => {
    const flowSteps = steps.get(flow.id) ?? [];
    const traceSteps = traces.get(flow.id) ?? [];
    const failed = flowSteps.some(step => step.status === 'failed');
    const ran = flowSteps.some(step => step.status === 'passed' || step.status === 'failed');
    const assertion = ran ? 'verified' as const : 'unverifiable' as const;
    const result: FlowResult = {
      flowId: flow.id,
      name: flow.name,
      description: flow.description,
      kind: flow.kind,
      startUrl: flow.startUrl,
      status: resolveFlowStatus(flowSteps, failed, assertion),
      assertion,
      ...(failed ? { failureReason: flowSteps.find(step => step.status === 'failed')?.error } : {}),
      severityIfFails: flow.severityIfFails,
      steps: flowSteps,
      durationMs: flowSteps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0),
      bugIds: [],
      trace: serializeTrace({
        version: 1,
        flowId: flow.id,
        name: flow.name,
        description: flow.description,
        kind: flow.kind,
        startUrl: flow.startUrl,
        expectation: flow.expectation,
        severityIfFails: flow.severityIfFails,
        steps: traceSteps,
      }),
    };
    opts.onFlowComplete?.(result);
    return result;
  });
}

async function assessLoadedPage(
  page: Page,
  kind: PageCheck,
  url: string,
  collected: Collected,
  linkBudget: LinkBudget,
  status?: number,
): Promise<CheckStepOutcome> {
  if (kind === 'console') return judgeConsoleStep(collected, url);
  if (kind === 'http') return judgeHttpStep(page, url, collected, linkBudget, status);
  if (kind === 'axe') return judgeAxeStep(page);
  if (kind === 'mobile') return judgeMobileStep(page);
  return judgeMetaStep(page);
}

function judgeConsoleStep(collected: Collected, url: string): CheckStepOutcome {
  const judged = judgeConsole(collected.hits, url);
  if (judged.bugs.length === 0) {
    const note = judged.ignored ? [`Ignored ${judged.ignored} third-party or automation message${judged.ignored === 1 ? '' : 's'}.`] : [];
    return passed('No first-party console error or uncaught exception on load.', note);
  }
  const lines = judged.bugs.slice(0, 4).map(hit =>
    hit.kind === 'pageerror' ? `Uncaught page error: ${hit.message}` : `Console error: ${hit.message}`,
  );
  const first = judged.bugs[0];
  const error = first.kind === 'pageerror'
    ? `pageerror: ${first.message}`
    : `console-error: ${first.message}`;
  return failed(lines.join(' '), error, { consoleErrors: consoleEvidence(judged.bugs) });
}

async function judgeHttpStep(
  page: Page,
  url: string,
  collected: Collected,
  linkBudget: LinkBudget,
  status?: number,
): Promise<CheckStepOutcome> {
  const requests = dedupeRequests([
    ...(status && status >= 400 && isBrokenStatus(status)
      ? [{ url, method: 'GET', status, resourceType: 'document' }]
      : []),
    ...collected.requests.filter(item => isReportableRequest(item, url)),
  ]);
  const broken = await probeLinks(page, url, linkBudget);
  if (requests.length === 0 && broken.length === 0) {
    return passed('Same-site requests and sampled links responded.');
  }
  const lines = [
    ...requests.slice(0, 4).map(item => item.status
      ? `${item.method || 'GET'} ${item.url} returned HTTP ${item.status}.`
      : `${item.url} failed (${item.failureText || 'network'}).`),
    ...broken.slice(0, 4).map(link => link.status
      ? `Link ${link.url} returned HTTP ${link.status}.`
      : `Link ${link.url} failed.`),
  ];
  const lead = requests[0] ?? broken[0];
  const code = lead?.status;
  const error = code ? `http-${code}` : 'request-failed';
  const network = [...requestEvidence(requests), ...linkEvidence(broken)];
  return failed(lines.join(' '), error, { networkFailures: network });
}

async function probeLinks(
  page: Page,
  pageUrl: string,
  budget: LinkBudget,
): Promise<{ url: string; status?: number; failureText?: string }[]> {
  if (budget.remaining <= 0) return [];
  const hrefs = await page.$$eval('a[href]', anchors => anchors.map(anchor => anchor.getAttribute('href') || '')).catch(() => [] as string[]);
  const links = sameSiteLinks(hrefs, pageUrl, budget.remaining);
  const broken: { url: string; status?: number; failureText?: string }[] = [];
  for (const link of links) {
    if (budget.remaining <= 0) break;
    budget.remaining -= 1;
    try {
      const response = await page.request.get(link, { timeout: 5_000, failOnStatusCode: false, maxRedirects: 2 });
      if (isBrokenStatus(response.status())) broken.push({ url: link, status: response.status() });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/i.test(message)) continue;
      broken.push({ url: link, failureText: 'request failed' });
    }
  }
  return broken;
}

async function judgeAxeStep(page: Page): Promise<CheckStepOutcome> {
  let judgement;
  try {
    judgement = await runAxe(page);
  } catch {
    return passed('axe-core could not run on this page. Recorded as info, not a bug.', ['axe did not finish.']);
  }
  const missing = await page.evaluate(readMissingLoginAutocomplete).catch(() => [] as string[]);
  const autocomplete = [
    ...judgement.autocomplete,
    ...missing.slice(0, 4).map(name => `Login field "${name}" has no autocomplete attribute.`),
  ];
  const info = judgement.info.slice(0, 4);
  if (judgement.serious.length > 0) {
    const lines = judgement.serious.slice(0, 4).map(item => `${item.impact} ${item.id}: ${item.help}`);
    const first = judgement.serious[0];
    return failed(lines.join(' '), `axe:${first.id}`, {}, [...info, ...autocomplete.map(line => `Minor: ${line}`)]);
  }
  if (autocomplete.length > 0) {
    return failed(
      autocomplete.slice(0, 3).join(' '),
      'autocomplete-missing',
      { severity: 'minor' },
      info,
    );
  }
  return passed(
    judgement.info.length ? 'No serious or critical WCAG A/AA violation.' : 'No WCAG A/AA violation.',
    info,
  );
}

async function judgeMobileStep(page: Page): Promise<CheckStepOutcome> {
  const snapshot = await page.evaluate(readMobileInPage);
  const judged = judgeMobile(snapshot);
  if (judged.bugs.length === 0) return passed('No horizontal overflow and no undersized tap target at 375px.', judged.info);
  const error = judged.bugs[0].startsWith('The page is') ? 'overflow' : 'tap-target';
  return failed(judged.bugs.join(' '), error, { severity: 'minor' }, judged.info);
}

async function judgeMetaStep(page: Page): Promise<CheckStepOutcome> {
  const snapshot = await page.evaluate(readMetaInPage);
  const judged = judgeMeta(snapshot);
  if (judged.bugs.length === 0) return passed('Title and viewport are present.', judged.info);
  const error = judged.bugs.some(line => /viewport/i.test(line)) && !snapshot.title.trim()
    ? 'missing-title'
    : snapshot.title.trim() ? 'missing-viewport' : 'missing-title';
  return failed(judged.bugs.join(' '), error, { severity: 'minor' }, judged.info);
}

function loadFailure(kind: PageCheck, url: string, err: unknown): CheckStepOutcome {
  if (kind !== 'http' && kind !== 'console') {
    return skipped('Page did not finish loading, so this check was not run.');
  }
  const raw = err instanceof Error ? err.message : String(err);
  if (/ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/i.test(raw) || isOwnAutomationText(raw)) {
    return passed('The load was interrupted by the browser. Recorded as info, not a bug.');
  }
  if (kind === 'console') return passed('No first-party console error was captured before the load stopped.');
  return failed(`Could not load ${url}.`, 'navigation-failed');
}

function isOwnAutomationText(text: string): boolean {
  return /waiting for locator|locator\.fill|strict mode violation|invalid selector/i.test(text);
}

function flowUrls(flow: TestFlow | undefined): string[] {
  if (!flow) return [];
  const urls: string[] = [];
  for (const step of flow.steps) {
    const url = step.url;
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

function kindOf(flow: TestFlow): PageCheck | undefined {
  const kind = flow.steps.find(step => step.pageCheck)?.pageCheck;
  return isPageCheck(kind) ? kind : undefined;
}

function dedupeRequests(items: ObservedRequest[]): ObservedRequest[] {
  const seen = new Set<string>();
  return items.filter(item => {
    const key = `${item.method || 'GET'} ${item.status || 0} ${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function record(
  flow: TestFlow,
  url: string,
  outcome: CheckStepOutcome,
  opts: ExecuteChecksOptions,
  steps: Map<string, StepResult[]>,
  traces: Map<string, TraceStep[]>,
  page?: Page,
): Promise<void> {
  const list = steps.get(flow.id);
  if (!list) return;
  const index = list.length + 1;
  const spec = isPageCheck(flow.steps[0]?.pageCheck) ? pageCheckSpec(flow.steps[0].pageCheck!) : undefined;
  const action = flow.steps[index - 1]?.action || `${spec?.action || 'Check'} on ${url}`;
  const expectation = flow.steps[index - 1]?.expectation;
  const result: StepResult = {
    index,
    action,
    expectation,
    status: outcome.status,
    observation: outcome.observation,
    tool: 'check',
    target: url,
    resolution: 'recorded',
    durationMs: 0,
    ...(outcome.error ? { error: outcome.error } : {}),
    ...(outcome.severity ? { severity: outcome.severity } : {}),
    ...(outcome.consoleErrors ? { consoleErrors: outcome.consoleErrors } : {}),
    ...(outcome.networkFailures ? { networkFailures: outcome.networkFailures } : {}),
  };
  if (outcome.status === 'failed' && page) {
    const path = shotPath(opts.screenshotsDir, flow.id, index, outcome.status);
    try {
      await page.screenshot({ path, fullPage: false });
      result.screenshotPath = path;
    } catch { /* a missed screenshot is not a bug */ }
  }
  list.push(result);
  const trace: TraceStep = {
    index,
    action,
    expectation,
    tool: 'check',
    locator: { strategy: 'css', target: url },
    value: flow.steps[index - 1]?.pageCheck,
    urlAfter: url,
    status: outcome.status,
    observation: outcome.observation,
    ...(outcome.error ? { error: outcome.error } : {}),
    resolution: 'recorded',
    ...(outcome.consoleErrors ? { consoleErrors: outcome.consoleErrors } : {}),
    ...(outcome.networkFailures ? { networkFailures: outcome.networkFailures } : {}),
    ...(result.screenshotPath ? { screenshotPath: result.screenshotPath } : {}),
  };
  traces.get(flow.id)?.push(serializeTraceStep(trace));
  opts.onStep?.(flow, result);
}

export function shotPath(dir: string, flowId: string, index: number, status: string): string {
  const slug = flowId.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'flow';
  return join(dir, `flow-${slug}-step-${String(index).padStart(2, '0')}-${status}.png`);
}
