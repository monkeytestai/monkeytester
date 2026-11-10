/**
 * Replay a recorded action trace without asking the LLM.
 *
 * Each step is executed from the stored locator (test id, then role+name,
 * label, placeholder, text, then the CSS fallback). A step whose action
 * still names a visible label is re-resolved from that text before the
 * locator is treated as stale. Auth-negative and sign-up validation steps
 * call the same checks as a live run. `--heal` is the only path that calls
 * the model: when every recorded locator misses, the step's original
 * instruction is re-resolved and the result is marked `healed`.
 *
 * A locator that still misses is `locator_mismatch`. That is an automation
 * error, not a site bug. The outcome pass, the signed-out redirect, and the
 * sensitive-submit / OAuth guards are the live-run functions.
 */

import type { Browser, BrowserContext, Page } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LLM } from '../llm/index.js';
import { logModelDetail } from '../llm/coerce.js';
import type {
  AxeRuleFinding,
  ConsoleErrorEvidence,
  FlowAssertion,
  FlowResult,
  FlowTrace,
  InboxProvider,
  NetworkFailureEvidence,
  RunResult,
  StepResult,
  StepStatus,
  Suggestion,
  TestFlow,
  TestStep,
  TraceStep,
  TraceTool,
} from '../types.js';
import {
  buildLocator,
  captureLocator,
  clickAsksForButton,
  directActionFromStep,
  executeAction,
  mergeLocatorIdentity,
  resolveAction,
  skeletonForLLM,
  type ResolvedAction,
} from './actions.js';
import { createFlowTimeout } from './timeout.js';
import { isPageCheck } from '../checks/plan.js';
import { replayPageCheck } from '../checks/execute.js';
import { applyPassedOracles, attachStepEvidence, flushStepEvents, type StepEvidence } from './evidence.js';
import { collectOrigins, outcomeWithSameOrigin5xx, promoteRecordedSteps } from './http5xx.js';
import { resolveFlowStatus } from './flowStatus.js';
import { installPageNameHelper } from './locate.js';
import { signupSubmitBlock } from '../signup/guard.js';
import { emptySignupLedger, signupFields, type SignupLedger } from '../signup/ledger.js';
import { isPageVisitFlow } from '../explorer/authRedirect.js';
import { evaluateOutcomeCheck, snapPage, type PageSnap } from '../outcome/check.js';
import {
  ensureNetErrorEvidence,
  isRequestBlockedStep,
  netEvidenceFor,
  settleActionBrowserError,
} from './browserError.js';
import { installDialogPolicy, installSubmissionGuards, isContactSubmitBlock, setStepIntent, type SensitiveKind } from './sensitive.js';
import { openFencedContext } from '../auth/browser.js';
import { launchFencedBrowser, type EgressPin } from '../auth/egress.js';
import type { AuthOriginPolicy, AuthStorageState } from '../auth/contract.js';
import { captureDisabled, redactValue, rememberPageSecrets, secretNeedles } from '../auth/redact.js';
import { authBlockedRun, publicMetadata } from '../auth/report.js';
import { adoptAttached, scrubModel, withSensitiveSinks } from '../auth/secrets.js';
import { authCheckForFlowId, isAuthNegativeFlowId } from '../planner/authNegative.js';
import { isSignupFlowId, signupCheckForFlowId } from '../signup/plan.js';
import { runAuthCheck } from './authNegative.js';
import { runSignupCheck } from '../signup/run.js';
import {
  appendSuggestions,
  applySubmissionGuard,
  assertionFromVerdict,
  isOutcomeAssertAction,
  isRecordedSubmissionHalt,
  oracleAssertion,
  passSignedOutVisit,
} from './flowJudge.js';

export interface ReplayOptions {
  screenshotsDir: string;
  stepTimeoutMs?: number;
  flowTimeoutMs?: number;
  headless?: boolean;
  /** Default true. Tests turn this off; video is not required to replay. */
  recordVideo?: boolean;
  /**
   * Same switch as `RunnerOptions.strictOracles`. Default false so a library
   * replay does not grow new bugs. The CLI passes true.
   */
  strictOracles?: boolean;
  /**
   * Same switch as `RunnerOptions.failOn5xx`. Default false. The CLI passes
   * the value of `--fail-on-5xx` (on unless `--no-fail-on-5xx`).
   */
  failOn5xx?: boolean;
  /**
   * Reuse a browser across calls. The caller owns its lifecycle; replay will
   * not close it. `verify` uses this so N repeats share one Chromium.
   */
  browser?: Browser;
  /**
   * When a recorded locator matches nothing, ask `llm` to re-resolve that
   * step from its original instruction. The step is marked `healed`.
   */
  heal?: boolean;
  llm?: LLM;
  /** Same mailbox as a live run. Replay still refuses a second completed sign-up. */
  inbox?: InboxProvider;
  /** Same allow-list as `RunnerOptions.allowSensitive`. */
  allowSensitive?: SensitiveKind[];
  storageState?: AuthStorageState;
  authOrigin?: AuthOriginPolicy;
  egressPin?: EgressPin;
  /** When the source run was authenticated, a new jar is required. */
  priorAuth?: import('../auth/contract.js').AuthPublicMetadata;
}

export async function replayTraces(
  traces: FlowTrace[],
  opts: ReplayOptions,
): Promise<RunResult> {
  return withSensitiveSinks(secretNeedles(opts.storageState), async () => {
    adoptAttached(opts.storageState);
    const result = await replayTracesScoped(traces, { ...opts, llm: opts.llm ? scrubModel(opts.llm) : opts.llm });
    return redactValue(result, secretNeedles(opts.storageState));
  });
}

async function replayTracesScoped(
  traces: FlowTrace[],
  opts: ReplayOptions,
): Promise<RunResult> {
  const screenshotsDir = resolve(opts.screenshotsDir);
  mkdirSync(screenshotsDir, { recursive: true });

  const startedAt = new Date().toISOString();
  const flows: FlowResult[] = [];

  if (opts.priorAuth?.outcome === 'authenticated' && !opts.storageState) {
    return authBlockedRun(traces[0]?.startUrl || '', publicMetadata({
      mode: opts.priorAuth.mode,
      outcome: 'not_authorized',
      policy: { targetOrigin: opts.priorAuth.targetOrigin, idpOrigins: opts.priorAuth.idpOrigins },
      custody: opts.priorAuth.custody,
      detail: 'Our test couldn\'t complete the run because replay of a signed-in trace needs a new session. This is not a verified run.',
    }));
  }

  if (traces.length === 0){
    return emptyReplay(startedAt);
  }

  const owned = !opts.browser;
  let browser = opts.browser;
  if (!browser) {
    const launch = await launchFencedBrowser({
      headless: opts.headless ?? true,
      policy: opts.storageState && opts.authOrigin ? opts.authOrigin : undefined,
    });
    if (!launch.ok) {
      return authBlockedRun(traces[0]?.startUrl || '', publicMetadata({
        mode: 'session',
        outcome: 'target_rejected',
        policy: opts.authOrigin ?? { targetOrigin: 'https://invalid.invalid', idpOrigins: [] },
        custody: 'in-memory',
        detail: launch.detail,
      }));
    }
    browser = launch.browser;
    if (launch.pin) opts = { ...opts, egressPin: launch.pin };
  }
  const signup = emptySignupLedger();
  try {
    for (const trace of traces){
      flows.push(await runOneTrace(browser, trace, { ...opts, screenshotsDir, signup }));
    }
  } finally {
    if (owned) await browser.close().catch(() => {});
  }

  return {
    startUrl: traces[0]?.startUrl || '',
    startedAt,
    finishedAt: new Date().toISOString(),
    flows,
    bugs: [],
    stats: aggregate(flows),
    ...signupFields(signup),
    ...(opts.storageState && opts.authOrigin ? {
      auth: publicMetadata({
        mode: 'session',
        outcome: 'authenticated',
        policy: opts.authOrigin,
        custody: 'in-memory',
        detail: 'Signed in for this process only. The session was not written on this result.',
      }),
    } : {}),
  };
}

async function runOneTrace(
  browser: Browser,
  trace: FlowTrace,
  opts: ReplayOptions & { screenshotsDir: string; signup: SignupLedger },
): Promise<FlowResult> {
  const started = Date.now();
  const timeoutMs = opts.flowTimeoutMs ?? 180_000;
  const abort = new AbortController();
  const timeout = createFlowTimeout(trace.name || trace.flowId, timeoutMs, () => abort.abort());
  const work = replayFlow(browser, trace, opts, abort.signal);
  // If the timeout wins the race, replayFlow may still reject once the
  // context closes. Observe that rejection so it cannot surface later.
  work.catch(() => {});

  try {
    // `timeout.promise` rejects when the budget is hit and only resolves if
    // `cancel()` runs — which is the `finally` below, after this race.
    const winner = await Promise.race([work, timeout.promise]);
    if (!winner || !('flowId' in winner)){
      throw new Error(`flow "${trace.name || trace.flowId}" exceeded ${timeoutMs}ms`);
    }
    return winner;
  } catch (err) {
    abort.abort();
    return {
      flowId: trace.flowId,
      name: trace.name || trace.flowId,
      description: trace.description || '',
      kind: trace.kind || 'happy_path',
      startUrl: trace.startUrl,
      status: 'error',
      failureReason: err instanceof Error ? err.message : String(err),
      steps: [],
      durationMs: Date.now() - started,
      bugIds: [],
    };
  } finally {
    timeout.cancel();
  }
}

async function replayFlow(
  browser: Browser,
  trace: FlowTrace,
  opts: ReplayOptions & { screenshotsDir: string; signup: SignupLedger },
  signal: AbortSignal,
): Promise<FlowResult> {
  const started = Date.now();
  const stepTimeout = opts.stepTimeoutMs ?? 15_000;
  const context = await openContext(browser, opts);
  const onAbort = () => { void context.close().catch(() => {}); };
  if (signal.aborted){
    await context.close().catch(() => {});
    throw new Error('flow aborted');
  }
  signal.addEventListener('abort', onAbort, { once: true });

  const page = await context.newPage();
  await installSubmissionGuards(page, { inbox: Boolean(opts.inbox), allow: opts.allowSensitive });
  installDialogPolicy(page);
  const evidence = attachStepEvidence(page);
  const origins = collectOrigins([trace.startUrl]);

  const steps: StepResult[] = [];
  const traceSteps: TraceStep[] = [];
  const flowSuggestions: Suggestion[] = [];
  const stepSuggestionPages = new Set<string>();
  let failed = false;
  let failureReason: string | undefined;
  let halted = false;
  let guarded = false;
  let beforeLast: PageSnap | undefined;
  let beforeAction: PageSnap | undefined;
  let assertion: FlowAssertion = 'missing';
  const lastActionIndex = [...trace.steps].reverse().find(step =>
    step.index > 0 && step.tool !== 'check' && !isOutcomeAssertAction(step.action),
  )?.index;

  try {
    for (const recorded of trace.steps){
      if (signal.aborted) throw new Error('flow aborted');
      evidence.stepIndex = recorded.index;

      if (isOutcomeAssertAction(recorded.action) && recorded.tool === 'assert_text') {
        continue;
      }

      if ((failed || halted) && recorded.tool !== 'check'){
        const blocked = blockedResult(recorded, failed
          ? 'Earlier step failed; not attempted.'
          : 'The sign-up submit was not run.');
        blocked.screenshotPath = await shot(page, opts.screenshotsDir, trace.flowId, recorded.index, 'blocked');
        steps.push(blocked);
        continue;
      }

      const urlBefore = page.url();
      const startedAt = new Date().toISOString();
      const stepStart = Date.now();
      const checkKinds = [trace.outcomeCheck?.kind, ...(trace.outcomeCheck?.also || []).map(item => item.kind)].filter(Boolean).join(' ');
      setStepIntent(page, [
        trace.name,
        trace.description,
        trace.expectation,
        checkKinds,
        recorded.action,
        recorded.expectation,
      ].filter(Boolean).join('\n'));
      if (!beforeLast && recorded.index > 0) beforeLast = await snapPage(page);
      if (recorded.index === lastActionIndex) beforeAction = await snapPage(page);
      const played = await playStep(page, trace, recorded, opts, stepTimeout, evidence, signal);
      if (played.skip) continue;
      const actionToolName = played.action.tool;
      if (actionToolName === 'click' || actionToolName === 'fill' || actionToolName === 'goto' || actionToolName === 'press') {
        played.outcome = settleActionBrowserError(
          played.outcome,
          safeUrl(page),
          evidence.networkByStep.get(recorded.index),
        );
      }
      if (played.halted) halted = true;
      if (played.outcome.error === 'sensitive-submit' || played.outcome.error === 'oauth-navigation' || played.outcome.error === 'request_blocked') {
        guarded = true;
      }
      if (!played.engine && recorded.tool !== 'check' && opts.strictOracles) {
        played.outcome = await applyPassedOracles(page, evidence, recorded.index, played.outcome);
      }
      if (!played.engine && recorded.tool !== 'check' && opts.failOn5xx) {
        if (!opts.strictOracles) await flushStepEvents(page);
        played.outcome = outcomeWithSameOrigin5xx(
          played.outcome,
          evidence.networkByStep.get(recorded.index),
          origins,
        );
      }
      const notes = suggestionsForReplay(trace, played.outcome.suggestions);
      const stepNotes = suggestionsForStep(stepSuggestionPages, notes);
      appendSuggestions(flowSuggestions, notes);
      const urlAfter = safeUrl(page);

      const result: StepResult = {
        index: recorded.index,
        action: recorded.action || played.action.tool,
        expectation: recorded.expectation,
        status: played.outcome.status,
        observation: played.outcome.observation,
        tool: played.action.tool,
        target: played.action.target,
        locator: played.locator,
        resolution: played.resolution,
        durationMs: Date.now() - stepStart,
        screenshotPath: await shot(page, opts.screenshotsDir, trace.flowId, recorded.index, played.outcome.status),
        consoleErrors: played.outcome.consoleErrors?.length
          ? played.outcome.consoleErrors
          : evidence.consoleByStep.get(recorded.index),
        networkFailures: ensureNetErrorEvidence(
          played.outcome.networkFailures?.length
            ? played.outcome.networkFailures
            : evidence.networkByStep.get(recorded.index),
          `${played.outcome.error || ''}\n${played.outcome.observation}`,
          urlBefore,
        ),
        ...(played.outcome.error ? { error: played.outcome.error } : {}),
        ...(played.outcome.severity ? { severity: played.outcome.severity } : {}),
        ...(played.outcome.axeRules?.length ? { axeRules: played.outcome.axeRules } : {}),
        ...(stepNotes?.length ? { suggestions: stepNotes } : {}),
      };
      steps.push(result);
      traceSteps.push({
        index: recorded.index,
        action: recorded.action,
        expectation: recorded.expectation,
        tool: played.action.tool as TraceStep['tool'],
        locator: played.locator,
        value: played.action.value,
        urlBefore,
        urlAfter,
        startedAt,
        durationMs: result.durationMs,
        status: result.status,
        observation: result.observation,
        error: result.error,
        screenshotPath: result.screenshotPath,
        consoleErrors: result.consoleErrors,
        networkFailures: result.networkFailures,
        resolution: played.resolution,
      });

      if (result.status === 'failed' && recorded.tool !== 'check'){
        failed = true;
        failureReason = result.error || result.observation;
      } else if (result.status === 'failed' && !failureReason) {
        failureReason = result.error || result.observation;
      }
    }
    if (opts.failOn5xx) await flushStepEvents(page);
    const judged = await replayAssertion(page, trace, steps, {
      halted,
      failed,
      guarded,
      beforeLast,
      beforeAction,
      suggestions: flowSuggestions,
    });
    assertion = judged.assertion;
    failed = judged.failed;
    failureReason = failed ? (failureReason || judged.observation) : undefined;
    if (judged.outcomeStep) {
      traceSteps.push({
        index: judged.outcomeStep.index,
        action: judged.outcomeStep.action,
        expectation: judged.outcomeStep.expectation,
        tool: 'assert_text',
        urlBefore: beforeLast?.url,
        urlAfter: safeUrl(page),
        status: judged.outcomeStep.status,
        observation: judged.outcomeStep.observation,
        error: judged.outcomeStep.error,
        resolution: 'recorded',
      });
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
    await context.close().catch(() => {});
  }

  if (opts.failOn5xx) {
    const promoted = promoteRecordedSteps(steps, traceSteps, origins);
    if (promoted.changed) {
      steps.splice(0, steps.length, ...promoted.steps);
      traceSteps.splice(0, traceSteps.length, ...promoted.traceSteps);
      if (promoted.failed) {
        failed = true;
        failureReason = failureReason || promoted.failureReason;
      }
    }
  }

  const contactBlocked = steps.some(isContactSubmitBlock);
  const requestBlocked = !contactBlocked && steps.some(isRequestBlockedStep);
  const status = assertion === 'blocked'
    ? 'blocked' as const
    : contactBlocked && !failed
      ? 'inconclusive' as const
      : requestBlocked && !failed
        ? 'inconclusive' as const
        : resolveFlowStatus(steps, failed, assertion);
  return {
    flowId: trace.flowId,
    name: trace.name || trace.flowId,
    description: trace.description || '',
    kind: trace.kind || 'happy_path',
    startUrl: trace.startUrl,
    status,
    assertion: contactBlocked && !failed ? 'unverifiable' as const : assertion,
    ...(contactBlocked ? { outcome_reason: 'contact_submit_blocked' as const } : {}),
    ...(requestBlocked && !failed ? { outcome_reason: 'request_blocked' as const } : {}),
    ...(!contactBlocked && !requestBlocked && status === 'inconclusive' && assertion === 'missing' ? { outcome_reason: 'no_assertion' as const } : {}),
    ...(!contactBlocked && !requestBlocked && status === 'inconclusive' && assertion === 'unverifiable' ? { outcome_reason: 'assertion_unverifiable' as const } : {}),
    failureReason,
    ...(trace.severityIfFails ? { severityIfFails: trace.severityIfFails } : {}),
    steps,
    durationMs: Date.now() - started,
    bugIds: [],
    trace: {
      version: 1,
      flowId: trace.flowId,
      name: trace.name || trace.flowId,
      description: trace.description,
      kind: trace.kind,
      startUrl: trace.startUrl,
      expectation: trace.expectation,
      ...(trace.outcomeCheck ? { outcomeCheck: trace.outcomeCheck } : {}),
      steps: traceSteps,
    },
    ...(flowSuggestions.length ? { suggestions: flowSuggestions } : {}),
  };
}

interface PlayedStep {
  action: { tool: string; target?: string; value?: string; locator?: ResolvedAction['locator']; rationale?: string };
  locator: TraceStep['locator'];
  outcome: Awaited<ReturnType<typeof executeAction>> & {
    severity?: 'critical' | 'major' | 'minor';
    axeRules?: AxeRuleFinding[];
    consoleErrors?: ConsoleErrorEvidence[];
    networkFailures?: NetworkFailureEvidence[];
  };
  resolution: 'recorded' | 'healed';
  halted?: boolean;
  /** Engine auth or sign-up check. Oracles inside that check already ran. */
  engine?: boolean;
  /** Recorded outcome step. The shared judge writes a fresh one. */
  skip?: boolean;
}

const silentLlm: LLM = {
  providerLabel: 'replay',
  async generateJSON() {
    throw new Error('replay has no model');
  },
};

/** One auth-redirect note per landing page across the steps of a flow. */
function suggestionsForStep(seen: Set<string>, notes: Suggestion[] | undefined): Suggestion[] | undefined {
  if (!notes?.length) return undefined;
  const kept: Suggestion[] = [];
  for (const item of notes) {
    if (item.kind === 'auth-redirect') {
      if (seen.has(item.pageUrl)) continue;
      seen.add(item.pageUrl);
    }
    kept.push(item);
  }
  return kept.length ? kept : undefined;
}

function suggestionsForReplay(
  trace: FlowTrace,
  notes: Suggestion[] | undefined,
): Suggestion[] | undefined {
  if (!notes?.length) return notes;
  if (traceIsPageVisit(trace)) return notes;
  const kept = notes.filter(item => item.kind !== 'auth-redirect');
  return kept.length ? kept : undefined;
}

function traceIsPageVisit(trace: FlowTrace): boolean {
  return isPageVisitFlow({
    name: trace.name || trace.flowId,
    description: trace.description,
    steps: trace.steps
      .filter(step => step.index > 0 && !isOutcomeAssertAction(step.action))
      .map(step => ({ action: step.action || '' })),
  });
}

function isEngineReplayStep(trace: FlowTrace, recorded: TraceStep): boolean {
  if (recorded.tool === 'goto' || recorded.tool === 'check' || recorded.tool === 'assert_text') return false;
  if (isOutcomeAssertAction(recorded.action)) return false;
  return Boolean(authCheckForFlowId(trace.flowId) || signupCheckForFlowId(trace.flowId));
}

function flowFromTrace(trace: FlowTrace, recorded: TraceStep): TestFlow {
  const auth = authCheckForFlowId(trace.flowId);
  const signup = signupCheckForFlowId(trace.flowId);
  const step: TestStep = {
    action: recorded.action || '',
    expectation: recorded.expectation,
    ...(recorded.value !== undefined ? { value: recorded.value } : {}),
    ...(auth ? { check: auth } : {}),
    ...(signup ? { signupCheck: signup } : {}),
  };
  return {
    id: trace.flowId,
    name: trace.name || trace.flowId,
    description: trace.description || '',
    kind: trace.kind || 'edge_case',
    startUrl: trace.startUrl,
    steps: [step],
    expectation: trace.expectation || recorded.expectation || '',
    ...(trace.outcomeCheck ? { outcomeCheck: trace.outcomeCheck } : {}),
    severityIfFails: trace.severityIfFails || 'major',
  };
}

async function playEngineStep(
  page: Page,
  trace: FlowTrace,
  recorded: TraceStep,
  opts: ReplayOptions & { signup: SignupLedger },
  timeoutMs: number,
  evidence: StepEvidence,
  signal: AbortSignal,
): Promise<PlayedStep> {
  const flow = flowFromTrace(trace, recorded);
  const step = flow.steps[0];
  if (step.check) {
    const outcome = await runAuthCheck(page, flow, step, evidence, recorded.index, {
      timeoutMs,
      llm: opts.llm ?? silentLlm,
      fallbacks: { used: opts.llm ? 0 : 1 },
      readMostly: Boolean(opts.storageState),
    });
    return {
      action: { tool: outcome.tool, target: outcome.target, value: outcome.value },
      locator: recorded.locator,
      resolution: 'recorded',
      engine: true,
      outcome: {
        status: outcome.status,
        observation: outcome.observation,
        ...(outcome.error ? { error: outcome.error } : {}),
      },
    };
  }
  const signup = step.signupCheck;
  if (!signup) return staleLocator(recorded);
  const outcome = await runSignupCheck(page, signup, {
    ledger: opts.signup,
    inbox: opts.inbox,
    runId: trace.flowId,
    timeoutMs,
    signal,
  });
  return {
    action: { tool: outcome.tool, target: outcome.target, value: outcome.value },
    locator: recorded.locator,
    resolution: 'recorded',
    engine: true,
    halted: outcome.status === 'skipped' && isRecordedSubmissionHalt(outcome),
    outcome: {
      status: outcome.status,
      observation: outcome.observation,
      ...(outcome.error ? { error: outcome.error } : {}),
    },
  };
}

async function recoverByInstruction(page: Page, recorded: TraceStep): Promise<ResolvedAction | null> {
  if (!recorded.action) return null;
  if (recorded.tool !== 'click' && recorded.tool !== 'fill' && recorded.tool !== 'press') return null;
  const skeleton = await skeletonForLLM(page);
  const direct = directActionFromStep(recorded.action, skeleton, recorded.value);
  if (!direct || direct.tool !== recorded.tool) return null;
  try {
    if (await buildLocator(page, direct).count() < 1) return null;
  } catch {
    return null;
  }
  return direct;
}

function skippedPlay(recorded: TraceStep, extra: { skip?: boolean } = {}): PlayedStep {
  return {
    action: actionFromRecorded(recorded),
    locator: recorded.locator,
    resolution: 'recorded',
    skip: extra.skip,
    outcome: { status: 'skipped', observation: recorded.observation || 'Skipped.' },
  };
}

function staleLocator(recorded: TraceStep): PlayedStep {
  return {
    action: actionFromRecorded(recorded),
    locator: recorded.locator,
    resolution: 'recorded',
    outcome: {
      status: 'failed',
      observation: `Recorded locator no longer matches for ${recorded.tool} (${describeLocator(recorded)}).`,
      error: 'locator_mismatch',
    },
  };
}

async function playStep(
  page: Page,
  trace: FlowTrace,
  recorded: TraceStep,
  opts: ReplayOptions & { signup: SignupLedger },
  timeoutMs: number,
  evidence: StepEvidence,
  signal: AbortSignal,
): Promise<PlayedStep> {
  if (recorded.tool === 'check') return playRecordedCheck(page, recorded, timeoutMs);
  if (isOutcomeAssertAction(recorded.action) && recorded.tool === 'assert_text') {
    return skippedPlay(recorded, { skip: true });
  }
  if (isEngineReplayStep(trace, recorded)) {
    return playEngineStep(page, trace, recorded, opts, timeoutMs, evidence, signal);
  }
  if (!needsElement(recorded)){
    const action = actionFromRecorded(recorded);
    const blocked = await blockRecordedSubmit(page, action, opts);
    if (blocked) return blocked;
    const outcome = await executeAction(page, action, timeoutMs, {
      strictOracles: opts.strictOracles,
      intent: recorded.action,
      readMostly: Boolean(opts.storageState),
    });
    return { action, locator: recorded.locator, outcome, resolution: 'recorded' };
  }

  const matched = await firstMatch(page, recorded);
  if (matched){
    const identified = await captureLocator(page, matched).catch(() => undefined);
    const locator = mergeLocatorIdentity(identified, recorded.locator);
    const blocked = await blockRecordedSubmit(page, matched, opts);
    if (blocked) return { ...blocked, locator };
    const asked = clickAsksForButton(recorded.action, matched) ? { ...matched, buttonIntent: true } : matched;
    const outcome = await executeAction(page, asked, timeoutMs, {
      strictOracles: opts.strictOracles,
      intent: recorded.action,
      readMostly: Boolean(opts.storageState),
    });
    return { action: matched, locator, outcome, resolution: 'recorded' };
  }

  if (recorded.status !== 'skipped' && recorded.action) {
    const recovered = await recoverByInstruction(page, recorded);
    if (recovered) {
      const identified = await captureLocator(page, recovered).catch(() => undefined);
      const locator = mergeLocatorIdentity(identified, recorded.locator);
      const blocked = await blockRecordedSubmit(page, recovered, opts);
      if (blocked) return { ...blocked, locator };
      const asked = clickAsksForButton(recorded.action, recovered) ? { ...recovered, buttonIntent: true } : recovered;
      const outcome = await executeAction(page, asked, timeoutMs, {
        strictOracles: opts.strictOracles,
        intent: recorded.action,
        readMostly: Boolean(opts.storageState),
      });
      return {
        action: recovered,
        locator,
        outcome: {
          ...outcome,
          observation: `Re-resolved from the step text. ${outcome.observation}`,
        },
        resolution: 'recorded',
      };
    }
  }

  if (opts.heal && opts.llm && recorded.action){
    let healed: ResolvedAction;
    try {
      healed = await healStep(page, trace, recorded, opts.llm);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logModelDetail('runner.resolveAction', detail);
      return {
        action: actionFromRecorded(recorded),
        locator: recorded.locator,
        resolution: 'recorded',
        outcome: {
          status: 'failed',
          observation: 'Recorded locator no longer matches, and the model could not propose a replacement.',
          error: 'locator_mismatch',
        },
      };
    }
    const identified = await captureLocator(page, healed).catch(() => undefined);
    const locator = mergeLocatorIdentity(identified, recorded.locator);
    const blocked = await blockRecordedSubmit(page, healed, opts);
    if (blocked) return { ...blocked, locator };
    const asked = clickAsksForButton(recorded.action, healed) ? { ...healed, buttonIntent: true } : healed;
    const outcome = await executeAction(page, asked, timeoutMs, {
      strictOracles: opts.strictOracles,
      intent: recorded.action,
      readMostly: Boolean(opts.storageState),
    });
    return {
      action: healed,
      locator,
      outcome: {
        ...outcome,
        observation: `Healed (recorded locator missed). ${outcome.observation}`,
      },
      resolution: 'healed',
    };
  }

  // The original run already continued past this step. A locator miss here
  // must not become a hard failure, or verify never reaches the later bug
  // (a placeholder fill that timed out, then a form POST that returned 500).
  // A step that originally passed or failed still stops the flow.
  if (recorded.status === 'skipped'){
    const halt = isRecordedSubmissionHalt(recorded);
    return {
      action: actionFromRecorded(recorded),
      locator: recorded.locator,
      resolution: 'recorded',
      halted: halt,
      outcome: {
        status: 'skipped',
        observation: halt
          ? (recorded.observation || 'The recorded submit was not run.')
          : `Recorded step was skipped and its locator still does not match for ${recorded.tool} (${describeLocator(recorded)}). Left skipped so later steps still run.`,
        ...(halt && recorded.error ? { error: recorded.error } : {}),
      },
    };
  }

  return {
    action: actionFromRecorded(recorded),
    locator: recorded.locator,
    resolution: 'recorded',
    outcome: {
      status: 'failed',
      observation: `Recorded locator no longer matches for ${recorded.tool} (${describeLocator(recorded)}).`,
      error: 'locator_mismatch',
    },
  };
}

async function healStep(
  page: Page,
  trace: FlowTrace,
  recorded: TraceStep,
  llm: LLM,
): Promise<ResolvedAction> {
  const flow: TestFlow = {
    id: trace.flowId,
    name: trace.name || trace.flowId,
    description: trace.description || '',
    kind: trace.kind || 'happy_path',
    startUrl: trace.startUrl,
    expectation: trace.expectation || '',
    severityIfFails: 'major',
    steps: trace.steps
      .filter(step => step.action)
      .map(step => ({ action: step.action!, expectation: step.expectation })),
  };
  const step: TestStep = { action: recorded.action || '', expectation: recorded.expectation };
  const skeleton = await skeletonForLLM(page);
  return resolveAction(llm, flow, step, skeleton);
}

async function playRecordedCheck(page: Page, recorded: TraceStep, timeoutMs: number): Promise<PlayedStep> {
  const kind = recorded.value;
  const url = recorded.locator?.target || recorded.urlAfter;
  if (!isPageCheck(kind) || !url) {
    return {
      action: { tool: 'check', target: url },
      locator: recorded.locator,
      resolution: 'recorded',
      outcome: {
        status: 'skipped',
        observation: 'Page check excluded from replay.',
      },
    };
  }
  const outcome = await replayPageCheck(page, kind, url, timeoutMs, {
    sitemapOnly: recorded.sitemapOnly,
  });
  return {
    action: { tool: 'check', target: url, value: kind },
    locator: recorded.locator ?? { strategy: 'css', target: url },
    resolution: 'recorded',
    outcome: {
      status: outcome.status,
      observation: outcome.observation,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.severity ? { severity: outcome.severity } : {}),
      ...(outcome.axeRules?.length ? { axeRules: outcome.axeRules } : {}),
      ...(outcome.suggestions?.length ? { suggestions: outcome.suggestions } : {}),
      ...(outcome.consoleErrors?.length ? { consoleErrors: outcome.consoleErrors } : {}),
      ...(outcome.networkFailures?.length ? { networkFailures: outcome.networkFailures } : {}),
    },
  };
}

function needsElement(step: TraceStep): boolean {
  if (step.tool === 'goto' || step.tool === 'noop' || step.tool === 'assert_text' || step.tool === 'check') return false;
  if (step.tool === 'press' && !step.locator) return false;
  return true;
}

function actionTool(step: TraceStep): Exclude<TraceTool, 'check'> {
  return step.tool === 'check' ? 'noop' : step.tool;
}

async function replayAssertion(
  page: Page,
  trace: FlowTrace,
  steps: StepResult[],
  flags: {
    halted: boolean;
    failed: boolean;
    guarded: boolean;
    beforeLast?: PageSnap;
    beforeAction?: PageSnap;
    suggestions: Suggestion[];
  },
): Promise<{ assertion: FlowAssertion; observation: string; failed: boolean; outcomeStep?: StepResult }> {
  const finish = (assertion: FlowAssertion, observation: string) => {
    const guarded = applySubmissionGuard(assertion, steps, flags.guarded);
    return {
      assertion: guarded.assertion,
      observation,
      failed: guarded.failed || guarded.assertion === 'failed',
    };
  };

  if (flags.halted) {
    return finish('blocked', 'The sign-up submit was not run.');
  }
  if (trace.steps.some(step => step.tool === 'check')) {
    const ran = steps.some(step => step.status === 'passed' || step.status === 'failed');
    return finish(ran ? 'verified' : 'unverifiable', ran ? 'The page check ran.' : 'The page check did not run.');
  }

  const oracle = isAuthNegativeFlowId(trace.flowId) || isSignupFlowId(trace.flowId);
  if (oracle) {
    return finish(oracleAssertion(steps), 'The check ran.');
  }

  if (flags.failed) {
    return finish('unverifiable', 'The outcome was not checked because an earlier step failed.');
  }

  if (!trace.outcomeCheck) {
    return finish('missing', 'This replay has no outcome check, so it cannot pass.');
  }

  const planSteps = trace.steps
    .filter(step => step.index > 0 && !isOutcomeAssertAction(step.action))
    .map(step => ({ action: step.action || '' }));
  const networkFailures = steps.flatMap(step => step.networkFailures ?? []);
  let verdict = await evaluateOutcomeCheck(page, trace.outcomeCheck, {
    startUrl: trace.startUrl,
    before: flags.beforeLast,
    beforeAction: flags.beforeAction ?? flags.beforeLast,
    consoleErrors: steps.flatMap(step => step.consoleErrors ?? []),
    networkFailures,
    guardCaused: flags.guarded || steps.some(step => isContactSubmitBlock(step) || isRequestBlockedStep(step)),
    navigationError: [...steps].reverse().find(step => step.error)?.error,
  });
  verdict = passSignedOutVisit(verdict, {
    name: trace.name || trace.flowId,
    description: trace.description,
    startUrl: trace.startUrl,
    steps: planSteps,
  }, safeUrl(page) || '', undefined, flags.suggestions);
  const unfinished = steps.some(step => step.index > 0 && (step.status === 'skipped' || step.status === 'blocked'));
  const assertion = assertionFromVerdict(verdict, unfinished);
  const outcomeStep: StepResult = {
    index: (steps[steps.length - 1]?.index ?? 0) + 1,
    action: 'Check the expected outcome',
    expectation: trace.expectation,
    status: assertion === 'verified' ? 'passed' : assertion === 'failed' ? 'failed' : 'skipped',
    observation: verdict.observation,
    tool: 'assert_text',
    target: trace.outcomeCheck.kind,
    ...(assertion === 'failed' ? { error: verdict.observation } : {}),
    ...netEvidenceFor(verdict.observation, networkFailures, flags.beforeLast?.url || trace.startUrl),
  };
  steps.push(outcomeStep);
  const judged = finish(assertion, verdict.observation);
  return { ...judged, outcomeStep };
}

async function blockRecordedSubmit(
  page: Page,
  action: ResolvedAction,
  opts: ReplayOptions & { signup: SignupLedger },
): Promise<PlayedStep | undefined> {
  const blocked = await signupSubmitBlock(page, action, { inbox: opts.inbox, ledger: opts.signup });
  if (!blocked) return undefined;
  return {
    action,
    locator: undefined,
    resolution: 'recorded',
    halted: true,
    outcome: { status: 'skipped', observation: blocked.observation },
  };
}

function actionFromRecorded(step: TraceStep): ResolvedAction {
  if (step.tool === 'goto'){
    return { tool: 'goto', target: step.locator?.target || step.urlAfter || '' };
  }
  if (step.tool === 'assert_text'){
    return { tool: 'assert_text', target: step.locator?.target || step.action };
  }
  if (step.tool === 'noop'){
    return { tool: 'noop', rationale: step.observation };
  }
  if (step.tool === 'press' && !step.locator){
    return { tool: 'press', value: step.value };
  }
  const locator = step.locator;
  return {
    tool: actionTool(step),
    locator: locator?.strategy === 'testid' ? 'testid' : (locator?.strategy || 'css'),
    target: locator?.target || '',
    value: step.value,
  };
}

async function firstMatch(page: Page, step: TraceStep): Promise<ResolvedAction | null> {
  const locator = step.locator;
  if (!locator) return null;

  const candidates: ResolvedAction[] = [];
  const push = (action: ResolvedAction) => {
    const key = `${action.locator}|${action.target}`;
    if (candidates.some(existing => `${existing.locator}|${existing.target}` === key)) return;
    candidates.push(action);
  };

  const tool = actionTool(step);
  if (locator.testId) push({ tool, locator: 'testid', target: locator.testId, value: step.value });
  if (locator.role && (locator.name || locator.target)){
    const name = locator.name || locator.target;
    push({ tool, locator: 'role', target: `${locator.role}:${name}`, value: step.value });
  }
  if (locator.label) push({ tool, locator: 'label', target: locator.label, value: step.value });
  if (locator.placeholder) push({ tool, locator: 'placeholder', target: locator.placeholder, value: step.value });
  if (locator.text) push({ tool, locator: 'text', target: locator.text, value: step.value });
  if (locator.css) push({ tool, locator: 'css', target: locator.css, value: step.value });
  if (locator.strategy === 'css' && locator.target && locator.target !== locator.css){
    push({ tool, locator: 'css', target: locator.target, value: step.value });
  }
  if (locator.strategy && locator.strategy !== 'css' && locator.target){
    push({
      tool,
      locator: locator.strategy,
      target: locator.strategy === 'role' && locator.role && locator.name
        ? `${locator.role}:${locator.name}`
        : locator.target,
      value: step.value,
    });
  }

  for (const candidate of candidates){
    try {
      const count = await buildLocator(page, candidate).count();
      if (count > 0) return candidate;
    } catch {
      /* a stale CSS selector can throw on parse; try the next candidate */
    }
  }
  return null;
}

function describeLocator(step: TraceStep): string {
  const locator = step.locator;
  if (!locator) return 'no locator';
  const bits = [
    locator.testId && `testid=${locator.testId}`,
    locator.role && `role=${locator.role}`,
    locator.name && `name=${locator.name}`,
    locator.css && `css=${locator.css}`,
  ].filter(Boolean);
  return bits.join(' ') || `${locator.strategy}:${locator.target}`;
}

function blockedResult(recorded: TraceStep, observation: string): StepResult {
  return {
    index: recorded.index,
    action: recorded.action || recorded.tool,
    expectation: recorded.expectation,
    status: 'blocked',
    observation,
    resolution: 'recorded',
  };
}

async function openContext(browser: Browser, opts: ReplayOptions & { screenshotsDir: string }): Promise<BrowserContext> {
  const context = await openFencedContext(browser, {
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 monkeytest.ai',
    viewport: { width: 1280, height: 800 },
    ...(opts.recordVideo === false || opts.storageState ? {} : {
      recordVideo: { dir: opts.screenshotsDir, size: { width: 1280, height: 800 } },
    }),
    storageState: opts.storageState,
    authOrigin: opts.authOrigin,
    egressPin: opts.egressPin,
  });
  await installPageNameHelper(context);
  context.on('page', page => {
    if (opts.storageState) rememberPageSecrets(page, secretNeedles(opts.storageState), true);
  });
  return context;
}

async function shot(
  page: Page,
  dir: string,
  flowId: string,
  index: number,
  status: string,
): Promise<string | undefined> {
  if (captureDisabled(page)) return undefined;
  const filename = `replay-${slug(flowId)}-step-${String(index).padStart(2, '0')}-${status}.png`;
  const fullPath = join(dir, filename);
  try {
    await page.screenshot({ path: fullPath, fullPage: false });
    return fullPath;
  } catch {
    return undefined;
  }
}

function safeUrl(page: Page): string | undefined {
  try { return page.url(); }
  catch { return undefined; }
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'flow';
}

function aggregate(flows: FlowResult[]): RunResult['stats'] {
  let stepsTotal = 0, stepsPassed = 0, stepsFailed = 0;
  for (const flow of flows){
    for (const step of flow.steps){
      stepsTotal++;
      if (step.status === 'passed') stepsPassed++;
      if (step.status === 'failed') stepsFailed++;
    }
  }
  return {
    flowsTotal: flows.length,
    flowsPassed: flows.filter(flow => flow.status === 'passed').length,
    flowsFailed: flows.filter(flow => flow.status === 'failed' || flow.status === 'error').length,
    flowsBlocked: flows.filter(flow => flow.status === 'blocked').length,
    flowsInconclusive: flows.filter(flow => flow.status === 'inconclusive').length,
    stepsTotal, stepsPassed, stepsFailed,
    bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
  };
}

function emptyReplay(startedAt: string): RunResult {
  return {
    startUrl: '',
    startedAt,
    finishedAt: new Date().toISOString(),
    flows: [],
    bugs: [],
    stats: {
      flowsTotal: 0, flowsPassed: 0, flowsFailed: 0, flowsBlocked: 0, flowsInconclusive: 0,
      stepsTotal: 0, stepsPassed: 0, stepsFailed: 0,
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
  };
}
