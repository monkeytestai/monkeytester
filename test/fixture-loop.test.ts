import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIXTURE_LOOP_LABEL, runFixtureLoop } from '../scripts/fixture-loop.ts';
import { ENGINE_VERSION } from '../src/version.js';

describe('local fixture loop', () => {
  it('finds seeded bugs, replays the same traces after the fix, and diffs them', async () => {
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-loop-shots-'));
    const store = mkdtempSync(join(tmpdir(), 'monkeytest-loop-store-'));
    const artifact = await runFixtureLoop(shots, store);
    expect(artifact.label).toBe(FIXTURE_LOOP_LABEL);
    expect(artifact.engineVersion).toBe(ENGINE_VERSION);
    expect(artifact.notALiveModelRun).toBe(true);
    expect(artifact.contactPosts).toBe(0);
    expect(artifact.contactOutcome).toBe('contact_submit_blocked');
    expect(artifact.before).toEqual({
      bugCount: 3,
      signals: ['element-disabled', 'http-4xx', 'page-error'],
    });
    expect(artifact.afterReplay.bugCount).toBe(0);
    expect(artifact.diff).toMatchObject({ new: 0, fixed: 3, persisting: 0, regressed: 0 });
    expect(artifact.diff.line).toBe('0 new, 3 fixed, 0 still broken, 0 regressed (net -3)');
  }, 180_000);
});
