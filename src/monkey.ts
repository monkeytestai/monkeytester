/**
 * Top-level engine orchestrator.
 *
 * Two ways to use it:
 *
 *   1. `await monkey.exploreAndPlan(url)` — one-shot promise; easiest for the
 *      CLI and for unit-testing the explorer/planner.
 *   2. `await monkey.executeAndTriage(url, { events })` — full pipeline;
 *      pass an `EventBus` to receive realtime lifecycle events for a SaaS
 *      live-activity panel.
 */

import { createLLM, type LLM } from './llm/index.js';
import { explore, type ExploreOptions } from './explorer/index.js';
import { groundedTestPlan, plan, type PlannerOptions } from './planner/index.js';
import { runPlan, type RunnerOptions } from './runner/index.js';
import { replayTraces, type ReplayOptions } from './runner/replay.js';
import { triage, triagePolished } from './triager/index.js';
import { applyPlannerVerdict } from './planner/verdict.js';
import { attachRunOutcome, CANCELLED_DETAIL, countPublicScreens, withCancelledOutcome } from './outcome.js';
import { BASIC_PRESET } from './depth.js';
import { plannerBudgetMs } from './budget.js';
import { verifyBugs, type VerifyOptions, type VerifyReport } from './verify/index.js';
import { EventBus, noopBus } from './events.js';
import { bindAuthProvider, type AuthBindInput } from './auth/bind.js';
import type { AuthOriginPolicy, AuthPublicMetadata, AuthStorageState } from './auth/contract.js';
import { authBlockedRun, outcomeFromAuth, publicMetadata } from './auth/report.js';
import { secretNeedles } from './auth/redact.js';
import { attachedSecrets, scrubString } from './auth/secrets.js';
import type {
  MonkeyLLMConfig,
  SiteMap,
  TestPlan,
  RunResult,
  MonkeyEvent,
  InboxProvider,
} from './types.js';

export { plannerBudgetMs, executionReserveMs, CHECK_EXECUTION_RESERVE_MS } from './budget.js';

export interface MonkeyConfig {
  llm: MonkeyLLMConfig;
  /**
   * Fail a step on an uncaught page error, a document HTTP 404, an action
   * HTTP ≥500, or a disabled control the step tried to use. Default **on**.
   * Pass `false` to restore the previous "those signals stay evidence"
   * bug counts. The CLI always passes `true`. A per-call `run.strictOracles`
   * overrides the constructor.
   */
  strictOracles?: boolean;
  /**
   * Fail a passed or skipped step that observed a same-origin HTTP ≥500
   * (document, xhr, or fetch) and triage it as a blocking bug. Default
   * **on**. Pass `false` to leave those responses as evidence. The CLI
   * defaults this on (`--no-fail-on-5xx` opts out). A per-call
   * `run.failOn5xx` or replay `failOn5xx` overrides the constructor.
   *
   * `runPlan`, `replayTraces`, and `triage(run)` still leave this off unless
   * the caller passes it. `Monkey` passes the constructor value through.
   */
  failOn5xx?: boolean;
  /**
   * Planner model id. Does not change the explorer (per-page summaries) or
   * the runner. gpt-4o-mini stays the summary default when the explorer
   * config uses the cheap preset.
   */
  plannerModel?: string;
  /**
   * Mailbox for the one sign-up in a run. Omit it and sign-up stays
   * validation-only. A per-call `run.inbox` overrides this. Additive.
   */
  inbox?: InboxProvider;
}

/**
 * Product defaults for hard-fault oracles. Both are on unless the host
 * passes `false`. `runPlan` / `triage(run)` do not use this helper; `Monkey` does.
 */
export function resolveMonkeyOracles(
  config: Pick<MonkeyConfig, 'strictOracles' | 'failOn5xx'> = {},
): { strictOracles: boolean; failOn5xx: boolean } {
  return {
    strictOracles: config.strictOracles !== false,
    failOn5xx: config.failOn5xx !== false,
  };
}

export interface ExploreAndPlanOptions {
  explore?: ExploreOptions;
  plan?: PlannerOptions;
  /** Optional live event bus. Receives `LiveEvent`s for the explorer + planner phases. */
  events?: EventBus;
  /** In-memory session bound before explore and plan. Not read from a previous run. */
  auth?: AuthBindInput;
  /** Abort closes the browser and stops explore. The run is `cancelled`. */
  signal?: AbortSignal;
}

export interface ExecuteOptions extends ExploreAndPlanOptions {
  /**
   * Runner config. `screenshotsDir` is required because step screenshots
   * are the most valuable artefact a SaaS report can show.
   */
  run: RunnerOptions;
}

/**
 * Options for the `runFromPlan` re-run path. Skips explore + plan, executes
 * an existing TestPlan and triages the result. This is the cheap, fast path
 * for verifying that previously-found bugs are now fixed.
 */
export interface ExecuteFromPlanOptions {
  /** Required runner config; same shape as `executeAndTriage.run`. */
  run: RunnerOptions;
  /** Optional live event bus. Receives runner + triager events only. */
  events?: EventBus;
  /** Fresh session for this rerun. A previous plan does not carry a jar. */
  auth?: AuthBindInput;
  /** Abort closes the browser and stops the rerun. The run is `cancelled`. */
  signal?: AbortSignal;
}

export class Monkey {

  private readonly explorerLLM: LLM;
  private readonly plannerLLM: LLM;
  private readonly runnerLLM: LLM;
  /** Optional polish LLM; when present, the triager rewrites bug copy. */
  private readonly triagerLLM?: LLM;
  /** Page error, document 404, action 5xx, disabled control. On unless opted out. */
  private readonly strictOracles: boolean;
  /** Same-origin HTTP ≥500 promotion. On unless opted out. */
  private readonly failOn5xx: boolean;
  private readonly inbox?: InboxProvider;

  constructor(config: MonkeyConfig){

    this.explorerLLM = createLLM(config.llm.explorer);
    this.plannerLLM  = createLLM(config.plannerModel
      ? { ...config.llm.planner, model: config.plannerModel }
      : config.llm.planner);
    // Runner picks its own LLM if provided; otherwise it reuses the planner.
    // Most teams will want a *cheaper* runner (per-step tool resolution is
    // hot-path) and a smarter planner (one-shot, high-stakes design call).
    this.runnerLLM   = config.llm.runner
      ? createLLM(config.llm.runner)
      : this.plannerLLM;
    // Triager polish is fully opt-in. When unset, the deterministic
    // rule-based triager runs alone (zero LLM cost).
    this.triagerLLM  = config.llm.triager ? createLLM(config.llm.triager) : undefined;
    const oracles = resolveMonkeyOracles(config);
    this.strictOracles = oracles.strictOracles;
    this.failOn5xx = oracles.failOn5xx;
    this.inbox = config.inbox;

  }

  /**
   * One-shot helper: crawl the site and produce the test plan.
   */
  async exploreAndPlan(
    startUrl: string,
    opts: ExploreAndPlanOptions = {}
  ): Promise<{ siteMap: SiteMap; plan: TestPlan }> {

    const events = opts.events ?? noopBus();
    if (opts.signal?.aborted) {
      return { siteMap: cancelledSiteMap(startUrl), plan: cancelledPlan(startUrl) };
    }
    const gate = await gateCustomerAuth(opts.auth);
    if (!gate.ok) {
      return {
        siteMap: emptySiteMap(startUrl, gate.metadata.detail),
        plan: { startUrl, siteType: 'unknown', flows: [], notes: gate.metadata.detail, auth: gate.metadata },
      };
    }

    const siteMap = await explore(startUrl, this.explorerLLM, {
      ...opts.explore,
      events,
      signal: opts.signal ?? opts.explore?.signal,
      ...gate.browser,
    });
    if (opts.signal?.aborted || siteMap.cancelled) {
      return { siteMap, plan: cancelledPlan(startUrl) };
    }
    const testPlan = await plan(siteMap, this.plannerLLM, {
      ...opts.plan,
      maxPages: opts.plan?.maxPages ?? opts.explore?.maxPages,
      signupInbox: opts.plan?.signupInbox === true || Boolean(this.inbox),
      signedIn: Boolean(gate.browser.storageState),
      events,
    });
    return { siteMap, plan: gate.metadata ? { ...testPlan, auth: gate.metadata } : testPlan };

  }

  /**
   * Full pipeline: explore → plan → run → triage.
   *
   * Resilient by design: if the explorer reaches no pages, or the planner
   * fails, we still resolve with whatever evidence we have so the report
   * can render the failure clearly instead of showing an empty page.
   */
  async executeAndTriage(
    startUrl: string,
    opts: ExecuteOptions
  ): Promise<{ siteMap: SiteMap; plan: TestPlan; run: RunResult }> {

    const events = opts.events ?? noopBus();
    const budgetMs = opts.run.totalBudgetMs;
    const deadlineAt = opts.run.deadlineAt ?? (budgetMs ? Date.now() + budgetMs : undefined);
    if (opts.signal?.aborted) {
      return { siteMap: cancelledSiteMap(startUrl), plan: cancelledPlan(startUrl), run: withCancelledOutcome(emptyRun(startUrl)) };
    }
    const gate = await gateCustomerAuth(opts.auth);
    if (!gate.ok) {
      const blockedPlan: TestPlan = {
        startUrl, siteType: 'unknown', flows: [], notes: gate.metadata.detail, auth: gate.metadata,
      };
      return { siteMap: emptySiteMap(startUrl, gate.metadata.detail), plan: blockedPlan, run: authBlockedRun(startUrl, gate.metadata) };
    }

    const siteMap = await explore(startUrl, this.explorerLLM, {
      ...opts.explore,
      events,
      signal: opts.signal ?? opts.explore?.signal,
      pageTimeoutMs: opts.explore?.pageTimeoutMs ?? (budgetMs ? BASIC_PRESET.pageTimeoutMs : undefined),
      ...gate.browser,
    });
    if (opts.signal?.aborted || siteMap.cancelled) {
      const plan = cancelledPlan(startUrl);
      return { siteMap, plan, run: withCancelledOutcome(emptyRun(startUrl)) };
    }
    if (siteMap.auth && siteMap.auth.outcome !== 'authenticated') {
      const blockedPlan: TestPlan = {
        startUrl, siteType: 'unknown', flows: [], notes: siteMap.auth.detail, auth: siteMap.auth,
      };
      return { siteMap, plan: blockedPlan, run: authBlockedRun(startUrl, siteMap.auth) };
    }

    let testPlan: TestPlan;
    const planLimit = plannerBudgetMs({ totalBudgetMs: budgetMs, deadlineAt });
    try {
      testPlan = await planWithinBudget(planLimit, () => plan(siteMap, this.plannerLLM, {
        ...opts.plan,
        maxPages: opts.plan?.maxPages ?? opts.explore?.maxPages,
        signupInbox: opts.plan?.signupInbox === true || Boolean(opts.run.inbox ?? this.inbox),
        signedIn: Boolean(gate.browser.storageState),
        events,
      }));
    } catch (err) {
      const msg = caughtMessage(err, gate.browser.storageState);
      console.warn(`[monkeytester] planner fallback: ${truncate(msg, 300)}`);
      events.emit({
        phase: 'planner', type: 'engine.error',
        message: `Planner failed: ${truncate(msg, 160)}`,
        data: { error: msg, plannerFallback: true },
      });
      const fallback = markPlannerFallback(groundedTestPlan(
        siteMap,
        opts.plan?.maxFlows ?? 6,
        `Planner failed after exploration: ${msg}`,
        opts.plan?.focus,
      ), msg);
      if (fallback.flows.length === 0) {
        const plan = gate.metadata ? { ...fallback, auth: gate.metadata } : fallback;
        return {
          siteMap,
          plan,
          run: { ...withRunWarnings(finishEmpty(startUrl, siteMap.pages.length, plan.notes, countPublicScreens(siteMap.pages)), siteMap, plan), ...(gate.metadata ? { auth: gate.metadata } : {}) },
        };
      }
      testPlan = fallback;
    }

    if (testPlan.flows.length === 0){
      events.emit({
        phase: 'planner', type: 'plan.skipped',
        message: 'Planner produced no flows — nothing to execute.',
      });
      const plan = gate.metadata ? { ...testPlan, auth: gate.metadata } : testPlan;
      return {
        siteMap,
        plan,
        run: { ...withRunWarnings(finishEmpty(startUrl, siteMap.pages.length, plan.notes, countPublicScreens(siteMap.pages)), siteMap, plan), ...(gate.metadata ? { auth: gate.metadata } : {}) },
      };
    }

    let rawRun: RunResult;
    try {
      events.emit({
        phase: 'runner', type: 'run.start',
        message: `Running ${testPlan.flows.length} flow${testPlan.flows.length === 1 ? '' : 's'}…`,
        data: { flows: testPlan.flows.length },
      });
      rawRun = await runPlan(testPlan, this.runnerLLM, {
        ...opts.run,
        events,
        deadlineAt,
        signal: opts.signal ?? opts.run.signal,
        inbox: opts.run.inbox ?? this.inbox,
        strictOracles: opts.run.strictOracles ?? this.strictOracles,
        failOn5xx: opts.run.failOn5xx ?? this.failOn5xx,
        ...gate.browser,
      });
      events.emit({
        phase: 'runner', type: 'run.complete',
        message: `Run complete: ${rawRun.stats.flowsPassed}/${rawRun.stats.flowsTotal} flows passed.`,
        data: rawRun.stats,
      });
    } catch (err) {
      const msg = caughtMessage(err, gate.browser.storageState);
      events.emit({
        phase: 'runner', type: 'engine.error',
        message: `Runner failed: ${truncate(msg, 160)}`,
        data: { error: msg },
      });
      return {
        siteMap,
        plan: {
          ...testPlan,
          ...(gate.metadata ? { auth: gate.metadata } : {}),
          notes: [testPlan.notes, `Runner failed before executing flows: ${msg}`].filter(Boolean).join('\n'),
        },
        run: { ...withRunWarnings(finishEmpty(startUrl, siteMap.pages.length, `Runner failed before executing flows: ${msg}`, countPublicScreens(siteMap.pages)), siteMap, testPlan), ...(gate.metadata ? { auth: gate.metadata } : {}) },
      };
    }

    const triageOpts = {
      failOn5xx: opts.run.failOn5xx ?? this.failOn5xx,
      pagesVisited: siteMap.pages.length,
      publicScreens: countPublicScreens(siteMap.pages),
      notes: testPlan.notes,
    };
    let run: RunResult;
    if (this.triagerLLM){
      // Polished path: rule-based triage runs first inside `triagePolished`,
      // then each bug is rewritten by the LLM. Failures fall back to the
      // deterministic copy per-bug — never lose results.
      run = await triagePolished(rawRun, {
        llm: this.triagerLLM,
        events,
        ...triageOpts,
      });
    } else {
      events.emit({ phase: 'triager', type: 'triage.start', message: 'Triaging findings…' });
      run = triage(rawRun, triageOpts);
      events.emit({
        phase: 'triager', type: 'triage.complete',
        message: run.bugs.length === 0
          ? 'Triage complete: no confirmed bugs.'
          : `Triage complete: ${run.bugs.length} bug${run.bugs.length === 1 ? '' : 's'} reported.`,
        data: { bugs: run.bugs.length, stats: run.stats, outcome: run.outcome },
      });
    }

    run = await applyPlannerVerdict(run, this.plannerLLM, {
      pagesVisited: siteMap.pages.length,
      notes: testPlan.notes,
    });

    const stampedPlan = gate.metadata ? { ...testPlan, auth: gate.metadata } : testPlan;
    const stampedRun = preferRunAuth(withRunWarnings(run, siteMap, stampedPlan), gate.metadata);
    return { siteMap, plan: stampedPlan, run: stampedRun };

  }

  /**
   * Re-run a previously-stored `TestPlan` against the same (or a new) URL,
   * skipping the explorer and planner phases entirely.
   *
   * This re-executes the stored plan. The runner still asks the LLM which
   * tool to use at each step, so it is not a byte-for-byte replay.
   *
   * For a replay that does not call the LLM, use `replayRecorded` (the CLI
   * `rerun` command) or `verifyRecorded` (`monkeytest verify`). Those walk
   * the action trace captured on the original run.
   *
   * Re-using the stored plan still gives:
   *
   *   - **Same flows** — no explorer or planner drift between runs.
   *   - **Speed + cost** — no explorer LLM calls and no planner call.
   *   - **Comparability** — pair the result with `diffRuns(prev, current)`
   *     to see new / fixed / regressed bugs by stable fingerprint.
   *
   * The plan's `startUrl` is honoured by default. If you want to re-run the
   * same plan against a different environment (e.g. staging vs prod), edit
   * `plan.flows[].startUrl` before passing it in.
   */
  async runFromPlan(
    testPlan: TestPlan,
    opts: ExecuteFromPlanOptions
  ): Promise<{ plan: TestPlan; run: RunResult }> {

    const events = opts.events ?? noopBus();
    const denied = rerunWithoutAuth(testPlan.auth, Boolean(opts.auth || opts.run.storageState), testPlan.startUrl);
    if (denied) return { plan: testPlan, run: denied };
    const gate = await gateCustomerAuth(opts.auth);
    if (!gate.ok) return { plan: { ...testPlan, auth: gate.metadata }, run: authBlockedRun(testPlan.startUrl, gate.metadata) };

    if (testPlan.flows.length === 0){
      events.emit({
        phase: 'planner', type: 'plan.skipped',
        message: 'runFromPlan called with an empty plan — nothing to execute.',
      });
      const empty = finishEmpty(testPlan.startUrl, undefined, testPlan.notes);
      return {
        plan: gate.metadata ? { ...testPlan, auth: gate.metadata } : testPlan,
        run: gate.metadata ? { ...empty, auth: gate.metadata } : empty,
      };
    }

    let rawRun: RunResult;
    try {
      events.emit({
        phase: 'runner', type: 'run.start',
        message: `Re-running ${testPlan.flows.length} stored flow${testPlan.flows.length === 1 ? '' : 's'}…`,
        data: { flows: testPlan.flows.length, mode: 'rerun' },
      });
      rawRun = await runPlan(testPlan, this.runnerLLM, {
        ...opts.run,
        events,
        signal: opts.signal ?? opts.run.signal,
        inbox: opts.run.inbox ?? this.inbox,
        strictOracles: opts.run.strictOracles ?? this.strictOracles,
        failOn5xx: opts.run.failOn5xx ?? this.failOn5xx,
        ...gate.browser,
      });
      events.emit({
        phase: 'runner', type: 'run.complete',
        message: `Re-run complete: ${rawRun.stats.flowsPassed}/${rawRun.stats.flowsTotal} flows passed.`,
        data: rawRun.stats,
      });
    } catch (err) {
      const msg = caughtMessage(err, gate.browser.storageState);
      events.emit({
        phase: 'runner', type: 'engine.error',
        message: `Re-run failed: ${truncate(msg, 160)}`,
        data: { error: msg },
      });
      const empty = finishEmpty(testPlan.startUrl, undefined, msg);
      return {
        plan: gate.metadata ? { ...testPlan, auth: gate.metadata } : testPlan,
        run: gate.metadata ? { ...empty, auth: gate.metadata } : empty,
      };
    }

    const triageOpts = {
      failOn5xx: opts.run.failOn5xx ?? this.failOn5xx,
      notes: testPlan.notes,
    };
    let run: RunResult;
    if (this.triagerLLM){
      run = await triagePolished(rawRun, {
        llm: this.triagerLLM,
        events,
        ...triageOpts,
      });
    } else {
      events.emit({ phase: 'triager', type: 'triage.start', message: 'Triaging findings…' });
      run = triage(rawRun, triageOpts);
      events.emit({
        phase: 'triager', type: 'triage.complete',
        message: run.bugs.length === 0
          ? 'Triage complete: no confirmed bugs.'
          : `Triage complete: ${run.bugs.length} bug${run.bugs.length === 1 ? '' : 's'} reported.`,
        data: { bugs: run.bugs.length, stats: run.stats, outcome: run.outcome },
      });
    }

    run = await applyPlannerVerdict(run, this.plannerLLM, { notes: testPlan.notes });
    return {
      plan: gate.metadata ? { ...testPlan, auth: gate.metadata } : testPlan,
      run: preferRunAuth(run, gate.metadata),
    };

  }

  /**
   * Replay traces captured on a previous run. Does not call the LLM unless
   * `opts.heal` is set, in which case a missed locator is re-resolved with
   * the runner model and that step is marked `healed`.
   */
  async replayRecorded(
    source: RunResult,
    opts: ReplayOptions & { heal?: boolean; auth?: AuthBindInput },
  ): Promise<{ run: RunResult }> {
    const denied = rerunWithoutAuth(source.auth, Boolean(opts.auth || opts.storageState), source.startUrl);
    if (denied) return { run: denied };
    const gate = await gateCustomerAuth(opts.auth);
    if (!gate.ok) return { run: authBlockedRun(source.startUrl, gate.metadata) };
    const traces = source.flows
      .map(flow => flow.trace)
      .filter((trace): trace is NonNullable<typeof trace> => !!trace && trace.steps.length > 0);
    const raw = await replayTraces(traces, {
      ...opts,
      heal: opts.heal,
      llm: opts.heal ? (opts.llm ?? this.runnerLLM) : opts.llm,
      inbox: opts.inbox ?? this.inbox,
      strictOracles: opts.strictOracles ?? this.strictOracles,
      failOn5xx: opts.failOn5xx ?? this.failOn5xx,
      priorAuth: source.auth,
      ...gate.browser,
    });
    const failOn5xx = opts.failOn5xx ?? this.failOn5xx;
    const triaged = this.triagerLLM
      ? await triagePolished(raw, { llm: this.triagerLLM, failOn5xx })
      : triage(raw, { failOn5xx });
    const run = preferRunAuth(triaged, gate.metadata);
    return { run };
  }

  /**
   * Replay each bug trace on `source` and return a fixed / still_broken /
   * flaky / healed / blocked verdict. No LLM unless `opts.heal` is set.
   */
  async verifyRecorded(source: RunResult, opts: VerifyOptions): Promise<VerifyReport> {
    const denied = rerunWithoutAuth(source.auth, Boolean(opts.auth || opts.storageState), source.startUrl);
    if (denied) return blockedVerify(denied);
    const gate = await gateCustomerAuth(opts.auth);
    if (!gate.ok) return blockedVerify(authBlockedRun(source.startUrl, gate.metadata));
    return verifyBugs(source, {
      ...opts,
      llm: opts.heal ? (opts.llm ?? this.runnerLLM) : opts.llm,
      strictOracles: opts.strictOracles ?? this.strictOracles,
      failOn5xx: opts.failOn5xx ?? this.failOn5xx,
      priorAuth: source.auth,
      ...gate.browser,
    });
  }

  /**
   * Async-iterator API. Same pipeline, but yields MonkeyEvents as it goes
   * so the caller can stream them. v0.2 yields explore + plan + flow/step
   * events.
   */
  async *run(
    startUrl: string,
    opts: ExploreAndPlanOptions = {}
  ): AsyncGenerator<MonkeyEvent, void, void> {

    yield { type: 'explore.start', url: startUrl };

    const pageEvents: MonkeyEvent[] = [];
    const siteMap = await explore(startUrl, this.explorerLLM, {
      ...opts.explore,
      signal: opts.signal ?? opts.explore?.signal,
      onPage: (page) => {
        pageEvents.push({ type: 'explore.page', page });
      },
    });
    for (const e of pageEvents) yield e;

    yield { type: 'explore.complete', siteMap };
    yield { type: 'plan.start' };

    let testPlan: TestPlan;
    try {
      testPlan = await plan(siteMap, this.plannerLLM, {
        ...opts.plan,
        signupInbox: opts.plan?.signupInbox === true || Boolean(this.inbox),
      });
    } catch (err) {
      const msg = caughtMessage(err);
      const fallback = markPlannerFallback(groundedTestPlan(
        siteMap,
        opts.plan?.maxFlows ?? 6,
        `Planner failed after exploration: ${msg}`,
        opts.plan?.focus,
      ), msg);
      console.warn(`[monkeytester] planner fallback: ${truncate(msg, 300)}`);
      yield { type: 'error', phase: 'planner', message: msg };
      if (fallback.flows.length === 0) return;
      testPlan = fallback;
    }

    yield { type: 'plan.complete', plan: testPlan };

  }

}

function cancelledSiteMap(startUrl: string): SiteMap {
  return {
    startUrl,
    siteType: 'unknown',
    summary: CANCELLED_DETAIL,
    pages: [],
    pendingUrls: [],
    failedUrls: [],
    cancelled: true,
  };
}

function cancelledPlan(startUrl: string): TestPlan {
  return { startUrl, siteType: 'unknown', flows: [], notes: CANCELLED_DETAIL };
}

function emptyRun(startUrl: string): RunResult {
  const startedAt = new Date().toISOString();
  return {
    startUrl,
    startedAt,
    finishedAt: startedAt,
    flows: [],
    bugs: [],
    stats: {
      flowsTotal: 0, flowsPassed: 0, flowsFailed: 0, flowsBlocked: 0, flowsInconclusive: 0,
      stepsTotal: 0, stepsPassed: 0, stepsFailed: 0,
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
  };
}

function finishEmpty(startUrl: string, pagesVisited: number | undefined, notes?: string, publicScreens?: number): RunResult {
  return attachRunOutcome(emptyRun(startUrl), { pagesVisited, notes, publicScreens });
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function markPlannerFallback(plan: TestPlan, reason: string): TestPlan {
  return {
    ...plan,
    plannerFallback: true,
    plannerFallbackReason: truncate(reason, 400),
  };
}

function withRunWarnings(run: RunResult, siteMap: SiteMap, plan: TestPlan): RunResult {
  const warnings = [...(siteMap.warnings ?? [])];
  if (plan.plannerFallback) {
    const line = plan.plannerFallbackReason
      ? `Planner used the grounded fallback. ${plan.plannerFallbackReason}`
      : 'Planner used the grounded fallback.';
    warnings.push(line);
  }
  return {
    ...run,
    pagesExplored: siteMap.pagesExplored ?? siteMap.pages.length,
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Planning has its own budget. `undefined` waits for the model. `0` skips
 * it so the checks keep the reserve. A slow model rejects into the caller's
 * grounded fallback instead of holding the run until the checks are starved.
 */
async function gateCustomerAuth(auth?: AuthBindInput): Promise<
  | { ok: false; metadata: AuthPublicMetadata }
  | { ok: true; metadata?: AuthPublicMetadata; browser: {
    storageState?: AuthStorageState;
    authOrigin?: AuthOriginPolicy;
    sessionExpiresAt?: string;
    postLoginUrl?: string;
    postLoginSelector?: string;
    egressProxy?: string;
  } }
> {
  if (!auth) return { ok: true, browser: {} };
  const bound = await bindAuthProvider(auth);
  if (!bound.ok) return { ok: false, metadata: bound.metadata };
  return {
    ok: true,
    metadata: bound.metadata,
    browser: {
      storageState: bound.storageState,
      authOrigin: bound.authOrigin,
      ...(bound.metadata.expiresAt ? { sessionExpiresAt: bound.metadata.expiresAt } : {}),
      ...(auth.postLoginUrl ? { postLoginUrl: auth.postLoginUrl } : {}),
      ...(auth.postLoginSelector ? { postLoginSelector: auth.postLoginSelector } : {}),
      ...(auth.egressProxy !== undefined ? { egressProxy: auth.egressProxy } : {}),
    },
  };
}

function caughtMessage(err: unknown, holder?: object): string {
  const raw = err instanceof Error ? err.message : String(err);
  const extra = holder
    ? [...attachedSecrets(holder), ...secretNeedles(holder as AuthStorageState)]
    : [];
  return scrubString(raw, extra);
}

function preferRunAuth(run: RunResult, fallback?: AuthPublicMetadata): RunResult {
  const auth = run.auth && run.auth.outcome !== 'authenticated' ? run.auth : fallback;
  if (!auth) return run;
  return { ...run, auth, ...(outcomeFromAuth(auth) ?? {}) };
}

function blockedVerify(run: RunResult): VerifyReport {
  const detail = run.auth?.detail || 'Signed-in verify needs a new session. This is not a fix.';
  const results = run.bugs.map(bug => ({
    fingerprint: bug.fingerprint,
    fingerprintV2: bug.fingerprintV2,
    bugId: bug.id,
    title: bug.title,
    severity: bug.severity,
    attempts: ['blocked' as const],
    verdict: 'blocked' as const,
    fired: 0,
    repeat: 1,
    detail,
  }));
  return {
    repeat: 1,
    heal: false,
    results,
    stats: { total: results.length, fixed: 0, still_broken: 0, flaky: 0, healed: 0, blocked: results.length },
    exitCode: 1,
    auth: run.auth,
  };
}

function rerunWithoutAuth(prior: AuthPublicMetadata | undefined, hasFresh: boolean, startUrl: string): RunResult | undefined {
  if (prior?.outcome !== 'authenticated' || hasFresh) return undefined;
  return authBlockedRun(startUrl, publicMetadata({
    mode: prior.mode,
    outcome: 'not_authorized',
    policy: { targetOrigin: prior.targetOrigin, idpOrigins: prior.idpOrigins },
    custody: prior.custody,
    detail: 'Our test couldn\'t complete the run because the previous sign-in is not copied onto a rerun. Pass a new in-memory session or --use-session. This is not a verified run.',
  }));
}

function emptySiteMap(startUrl: string, detail: string): SiteMap {
  return {
    startUrl,
    siteType: 'unknown',
    summary: detail,
    pages: [],
    pendingUrls: [],
    failedUrls: [],
    pagesExplored: 0,
  };
}

async function planWithinBudget(limitMs: number | undefined, work: () => Promise<TestPlan>): Promise<TestPlan> {
  if (limitMs === undefined) return work();
  if (limitMs <= 0) {
    throw new Error('Planner skipped: no time left before the checks.');
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Planner exceeded its ${limitMs}ms budget. Checks kept the remaining time.`));
    }, limitMs);
  });
  try {
    return await Promise.race([work(), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
