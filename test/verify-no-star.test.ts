/**
 * `monkeytest verify` does not ask for a star.
 * A skipped failing step is still labelled `fixed` by the pre-existing
 * verdict rule. This change does not alter that rule.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BugReport, RunResult } from '../src/types.js';
import { classifyAttempt } from '../src/verify/verdict.js';

const STAR = 'https://github.com/monkeytestai/monkeytester';

function cli(args: string[]): { code: number; out: string } {
  const env = { ...process.env };
  delete env.CI;
  delete env.MONKEYTEST_NO_STAR;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
    timeout: 20_000,
  });
  return { code: result.status ?? 1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function verify(run: RunResult, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'monkeytest-verify-star-'));
  const id = 'run-1';
  mkdirSync(join(dir, 'runs'), { recursive: true });
  writeFileSync(join(dir, 'runs', `${id}.json`), JSON.stringify({
    schema: 1,
    id,
    createdAt: '2026-11-08T00:00:00.000Z',
    run,
  }));
  return cli(['verify', id, '--dir', dir, ...extra]);
}

function baseRun(partial: Partial<RunResult>): RunResult {
  return {
    startUrl: 'https://shop.example/',
    startedAt: '2026-11-08T00:00:00.000Z',
    finishedAt: '2026-11-08T00:00:01.000Z',
    flows: [],
    bugs: [],
    outcome: 'bugs_found',
    stats: {
      flowsTotal: 0, flowsPassed: 0, flowsFailed: 0, flowsBlocked: 0,
      stepsTotal: 0, stepsPassed: 0, stepsFailed: 0,
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
    ...partial,
  };
}

function bareBug(fingerprint: string): BugReport {
  return {
    id: 'bug-1',
    fingerprint,
    title: 'Sign-up validation missing',
    severity: 'major',
    affectedFlow: 'Sign up',
    reproSteps: ['Open the page'],
    observed: 'No validation',
    expected: 'A validation message',
    evidence: { screenshots: [], consoleErrors: [], networkFailures: [] },
    triageNotes: 'Look at the form.',
  };
}

describe('verify does not ask for a star', () => {
  it('leaves the pre-existing skipped-step label as fixed', () => {
    const skipped = classifyAttempt([
      { index: 0, tool: 'goto', status: 'passed', observation: 'Opened' },
      { index: 1, tool: 'noop', status: 'skipped', observation: 'No sign-up form was on the page.' },
    ], 1);
    expect(skipped.outcome).toBe('fixed');
  });

  it('does not ask for an empty run, an inconclusive run, a blocked run, or a fingerprint mismatch', () => {
    const empty = verify(baseRun({ bugs: [] }));
    expect(empty.code).toBe(0);
    expect(empty.out).not.toContain(STAR);

    const inconclusive = verify(baseRun({
      outcome: 'inconclusive',
      bugs: [bareBug('fp-1')],
    }));
    expect(inconclusive.code).toBe(0);
    expect(inconclusive.out).toContain('blocked');
    expect(inconclusive.out).not.toContain(STAR);

    const mismatch = verify(baseRun({ bugs: [bareBug('fp-1')] }), ['--bug', 'missing']);
    expect(mismatch.code).toBe(2);
    expect(mismatch.out).not.toContain(STAR);
  });
});
