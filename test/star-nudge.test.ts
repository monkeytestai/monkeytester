import { describe, expect, it } from 'vitest';
import { diffRuns } from '../src/diff/index.js';
import { isLoopbackUrl, runRecordNamesStub, starNudgeLine, textNamesStubProvider, type StarNudgeInput } from '../src/starNudge.js';
import type { BugReport, RunResult } from '../src/types.js';

function bug(fingerprint: string): BugReport {
  return {
    id: `bug-${fingerprint}`,
    fingerprint,
    title: 'Checkout failed',
    severity: 'major',
    affectedFlow: 'Checkout',
    reproSteps: ['Open /checkout'],
    observed: 'The button was disabled',
    expected: 'The button can be used',
    evidence: { screenshots: [], consoleErrors: [], networkFailures: [] },
    triageNotes: 'Look at the control.',
  };
}

function runOf(bugs: BugReport[], outcome: RunResult['outcome']): RunResult {
  return {
    startUrl: 'https://shop.example/',
    startedAt: '2026-11-08T00:00:00.000Z',
    finishedAt: '2026-11-08T00:00:01.000Z',
    outcome,
    flows: [],
    bugs,
    stats: {
      flowsTotal: 1, flowsPassed: 0, flowsFailed: bugs.length, flowsBlocked: 0,
      stepsTotal: 1, stepsPassed: 0, stepsFailed: 1,
      bugsCritical: 0,
      bugsMajor: bugs.length,
      bugsMinor: 0,
    },
  };
}

function decide(previous: RunResult, current: RunResult, extra: Partial<StarNudgeInput> = {}) {
  const diff = diffRuns(previous, current);
  return {
    diff,
    line: starNudgeLine({
      json: false,
      tty: true,
      ci: false,
      optOut: false,
      alreadyNoted: false,
      startUrl: current.startUrl,
      finishedAt: current.finishedAt,
      outcome: current.outcome,
      currentBugCount: current.bugs.length,
      warnings: current.warnings,
      outcome_detail: current.outcome_detail,
      flows: current.flows,
      bugs: current.bugs,
      signal: { kind: 'diff', stats: diff.stats },
      ...extra,
    }),
  };
}

describe('diff star nudge', () => {
  const before = runOf([bug('fp-disabled')], 'bugs_found');

  it('asks only when diffRuns reports a real fix and the later run is clean', () => {
    const after = runOf([], 'clean');
    const { diff, line } = decide(before, after);
    expect(diff.stats).toEqual({ new: 0, fixed: 1, persisting: 0, regressed: 0, delta: -1 });
    expect(line).toContain('https://github.com/monkeytestai/monkeytester');
    expect(line?.match(/https:\/\//g)).toHaveLength(1);
  });

  it('stays quiet when the later run is not a finished clean zero-bug result', () => {
    const quiet = (current: RunResult) => decide(before, current).line;
    expect(quiet(runOf([], 'inconclusive'))).toBeNull();
    expect(quiet(runOf([], 'could_not_test'))).toBeNull();
    expect(quiet(runOf([], 'bugs_found'))).toBeNull();
    expect(quiet({ ...runOf([], 'clean'), finishedAt: '' })).toBeNull();
    expect(quiet({ ...runOf([], 'clean'), outcome: undefined })).toBeNull();
    expect(quiet(runOf([bug('fp-disabled')], 'clean'))).toBeNull();
    expect(quiet(runOf([bug('fp-other')], 'clean'))).toBeNull();
    const regressed = runOf([bug('fp-disabled')], 'clean');
    regressed.bugs[0].severity = 'critical';
    expect(decide(runOf([{ ...bug('fp-disabled'), severity: 'minor' }], 'bugs_found'), regressed).line).toBeNull();
  });

  it('keeps the stub, loopback, CI, TTY, JSON, and opt-out guards', () => {
    const after = runOf([], 'clean');
    expect(decide(before, after, { json: true }).line).toBeNull();
    expect(decide(before, after, { tty: false }).line).toBeNull();
    expect(decide(before, after, { ci: true }).line).toBeNull();
    expect(decide(before, after, { optOut: true }).line).toBeNull();
    expect(decide(before, after, { alreadyNoted: true }).line).toBeNull();
    expect(decide(before, after, { startUrl: 'http://127.0.0.1:9/' }).line).toBeNull();
    const warning = 'Model error: [stub · runner.resolveAction] response did not match schema';
    expect(textNamesStubProvider(warning)).toBe(true);
    after.warnings = [warning];
    expect(decide(before, after).line).toBeNull();
    expect(runRecordNamesStub({ warnings: ['Planner used gpt-4o-mini'] })).toBe(false);
    expect(isLoopbackUrl('https://shop.example/')).toBe(false);
  });
});
