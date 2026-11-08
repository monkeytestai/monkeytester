/**
 * Local bug → fix → same-trace rerun → diff.
 *
 * The target is test/fixtures/demo-app on 127.0.0.1. The plan is written
 * in this file. Action resolution is a stub LLM. This is not a live model
 * run, not a customer site, and not a recording of the hosted product.
 *
 *   npx tsx scripts/fixture-loop.ts --out examples/fixture-loop/artifact.json
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffRuns, summariseDiff } from '../src/diff/index.js';
import type { LLM } from '../src/llm/index.js';
import { savePlan, saveRun } from '../src/persistence/index.js';
import { replayTraces } from '../src/runner/replay.js';
import { runPlan } from '../src/runner/index.js';
import { triage } from '../src/triager/index.js';
import type { FlowTrace, TestPlan } from '../src/types.js';
import { ENGINE_VERSION } from '../src/version.js';
import { startDemoServer } from '../test/fixtures/demo-app/server.ts';

export const FIXTURE_LOOP_LABEL = 'STUB — not real-model testing';

export interface FixtureLoopArtifact {
  kind: 'local-fixture-loop';
  label: typeof FIXTURE_LOOP_LABEL;
  engineVersion: string;
  notALiveModelRun: true;
  notACustomerSite: true;
  notAHostedProductRun: true;
  planner: 'hand-authored plan for the local demo fixture';
  actionResolver: 'stub';
  contactPosts: number;
  contactOutcome: string | undefined;
  before: { bugCount: number; signals: string[] };
  afterReplay: { bugCount: number };
  diff: { new: number; fixed: number; persisting: number; regressed: number; line: string };
  reproducedBy: string;
}

export async function runFixtureLoop(shotsDir: string, storeDir: string): Promise<FixtureLoopArtifact> {
  const demo = await startDemoServer({ mode: 'buggy' });
  const llmCalls: string[] = [];
  const llm = stubLLM(llmCalls);
  try {
    const plan = demoPlan(demo.url);
    const first = triage(await runPlan(plan, llm, runOpts(shotsDir)), { failOn5xx: true });
    savePlan(plan, { dir: storeDir });
    saveRun(first, { dir: storeDir, engine: `monkeytester@${ENGINE_VERSION}` });

    const posted = demo.contactPosts();
    const contact = first.flows.find(flow => flow.flowId === 'send-message');
    await fetch(`${demo.url}/__monkeytest/mode`, { method: 'POST', body: 'fixed' });
    if (demo.getMode() !== 'fixed') throw new Error('demo fixture did not enter fixed mode');

    const traces = first.flows
      .map(flow => flow.trace)
      .filter((trace): trace is FlowTrace => !!trace && trace.steps.length > 0);
    if (traces.length !== plan.flows.length) {
      throw new Error(`expected a trace per flow, got ${traces.length}`);
    }
    const callsBeforeReplay = llmCalls.length;
    const replayed = triage(await replayTraces(traces, {
      screenshotsDir: shotsDir,
      headless: true,
      recordVideo: false,
      strictOracles: true,
      failOn5xx: true,
    }), { failOn5xx: true });
    if (llmCalls.length !== callsBeforeReplay) {
      throw new Error('same-trace rerun called the stub LLM');
    }
    saveRun(replayed, { dir: storeDir, engine: `monkeytester@${ENGINE_VERSION}` });
    const diff = diffRuns(first, replayed);
    return {
      kind: 'local-fixture-loop',
      label: FIXTURE_LOOP_LABEL,
      engineVersion: ENGINE_VERSION,
      notALiveModelRun: true,
      notACustomerSite: true,
      notAHostedProductRun: true,
      planner: 'hand-authored plan for the local demo fixture',
      actionResolver: 'stub',
      contactPosts: posted,
      contactOutcome: contact?.outcome_reason,
      before: {
        bugCount: first.bugs.length,
        signals: first.bugs.map(bug => bug.fingerprintParts?.errorSignal || '').sort(),
      },
      afterReplay: { bugCount: replayed.bugs.length },
      diff: { ...diff.stats, line: summariseDiff(diff) },
      reproducedBy: 'npx tsx scripts/fixture-loop.ts --out examples/fixture-loop/artifact.json',
    };
  } finally {
    await demo.close();
  }
}

function runOpts(screenshotsDir: string) {
  return {
    screenshotsDir,
    headless: true,
    recordVideo: false,
    strictOracles: true,
    failOn5xx: true,
    stepTimeoutMs: 8_000,
  };
}

function stubLLM(calls: string[]): LLM {
  return {
    providerLabel: 'stub',
    async generateJSON({ label, prompt }) {
      calls.push(label || '');
      if (label !== 'runner.resolveAction') throw new Error(`unexpected LLM label ${label}`);
      return actionFor(String(prompt));
    },
  };
}

function actionFor(prompt: string) {
  const step = prompt.match(/^\s*Step:\s+(.+)$/m)?.[1] ?? '';
  if (step.includes('Save order')) {
    return { tool: 'click', locator: 'role', target: 'button:Save order', rationale: 'Save the order.' };
  }
  if (step.includes('Track shipment')) {
    return { tool: 'click', locator: 'role', target: 'link:Track shipment', rationale: 'Open tracking.' };
  }
  if (step.includes('Send message')) {
    return { tool: 'click', locator: 'role', target: 'button:Send message', rationale: 'Submit the form.' };
  }
  if (step.includes('Apply coupon')) {
    return { tool: 'click', locator: 'role', target: 'button:Apply coupon', rationale: 'Apply the coupon.' };
  }
  throw new Error(`stub LLM has no action for step "${step}"`);
}

function demoPlan(url: string): TestPlan {
  return {
    startUrl: url,
    siteType: 'fixture',
    flows: [
      flow('save-order', 'Save the order', `${url}/checkout`, 'Click Save order'),
      flow('track-shipment', 'Track the shipment', `${url}/checkout`, 'Click Track shipment'),
      flow('send-message', 'Send a message', `${url}/contact`, 'Click Send message'),
      flow('apply-coupon', 'Apply a coupon', `${url}/checkout`, 'Click Apply coupon'),
    ],
  };
}

function flow(id: string, name: string, startUrl: string, action: string) {
  return {
    id,
    name,
    description: name,
    kind: 'happy_path' as const,
    startUrl,
    expectation: 'The control completes without an error.',
    severityIfFails: 'major' as const,
    steps: [{ action, expectation: 'The control completes without an error.' }],
  };
}

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

const entry = process.argv[1] ? resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
if (entry === self) {
  const out = resolve(arg('--out') || 'examples/fixture-loop/artifact.json');
  const shots = resolve(arg('--shots') || 'examples/fixture-loop/.shots');
  const store = resolve(arg('--dir') || 'examples/fixture-loop/.store');
  mkdirSync(shots, { recursive: true });
  mkdirSync(store, { recursive: true });
  const artifact = await runFixtureLoop(shots, store);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(FIXTURE_LOOP_LABEL);
  console.log(artifact.diff.line);
  console.log(out);
}
