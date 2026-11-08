import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, runRecordNamesStub, starNudgeLine, textNamesStubProvider, type StarNudgeInput } from '../src/starNudge.js';

function input(partial: Partial<StarNudgeInput> = {}): StarNudgeInput {
  return {
    json: false,
    tty: true,
    ci: false,
    optOut: false,
    alreadyNoted: false,
    startUrl: 'https://example.com/',
    finishedAt: '2026-11-08T00:00:01.000Z',
    outcome: 'clean',
    currentBugCount: 0,
    signal: { kind: 'verify', verdicts: ['fixed'] },
    ...partial,
  };
}

const allFixed = { kind: 'diff' as const, stats: { new: 0, fixed: 2, persisting: 0, regressed: 0 } };

describe('star nudge', () => {
  it('prints one link only after a finished clean run with a real fix', () => {
    const line = starNudgeLine(input());
    expect(line).toContain('https://github.com/monkeytestai/monkeytester');
    expect(line?.match(/https:\/\//g)).toHaveLength(1);
    expect(starNudgeLine(input({ signal: allFixed }))).toBe(line);
  });

  it('stays quiet for stubs, CI, JSON, opt-out, and a second ask', () => {
    expect(starNudgeLine(input({ json: true }))).toBeNull();
    expect(starNudgeLine(input({ tty: false }))).toBeNull();
    expect(starNudgeLine(input({ ci: true }))).toBeNull();
    expect(starNudgeLine(input({ optOut: true }))).toBeNull();
    expect(starNudgeLine(input({ alreadyNoted: true }))).toBeNull();
    expect(starNudgeLine(input({ startUrl: 'http://127.0.0.1:4173/' }))).toBeNull();
    expect(starNudgeLine(input({ signal: { kind: 'verify', verdicts: [] } }))).toBeNull();
    expect(starNudgeLine(input({ signal: { kind: 'verify', verdicts: ['fixed', 'still_broken'] } }))).toBeNull();
    expect(starNudgeLine(input({ signal: { kind: 'verify', verdicts: ['healed'] } }))).toBeNull();
    expect(starNudgeLine(input({ signal: { kind: 'verify', verdicts: ['blocked'] } }))).toBeNull();
    expect(starNudgeLine(input({ signal: { kind: 'verify', verdicts: ['flaky'] } }))).toBeNull();
    expect(starNudgeLine(input({
      signal: { kind: 'diff', stats: { new: 1, fixed: 1, persisting: 0, regressed: 0 } },
    }))).toBeNull();
    expect(starNudgeLine(input({
      signal: { kind: 'diff', stats: { new: 0, fixed: 1, persisting: 1, regressed: 0 } },
    }))).toBeNull();
    expect(starNudgeLine(input({
      signal: { kind: 'diff', stats: { new: 0, fixed: 0, persisting: 0, regressed: 0 } },
    }))).toBeNull();
  });

  it('refuses inconclusive, failed, unknown, and unfinished outcomes even when the diff looks all-fixed', () => {
    for (const outcome of ['inconclusive', 'could_not_test', 'bugs_found', 'failed', 'unavailable', 'unknown', undefined] as const) {
      expect(starNudgeLine(input({ outcome, signal: allFixed })), outcome ?? 'missing').toBeNull();
      expect(starNudgeLine(input({ outcome, signal: { kind: 'verify', verdicts: ['fixed'] } })), outcome ?? 'missing').toBeNull();
    }
    expect(starNudgeLine(input({ finishedAt: '', signal: allFixed }))).toBeNull();
    expect(starNudgeLine(input({ finishedAt: undefined, signal: allFixed }))).toBeNull();
    expect(starNudgeLine(input({ currentBugCount: 1, signal: allFixed }))).toBeNull();
    expect(starNudgeLine(input({ currentBugCount: undefined, signal: allFixed }))).toBeNull();
  });

  it('suppresses an explicit stub provider on a non-loopback run', () => {
    const warning = 'Model error: [stub · runner.resolveAction] response did not match schema';
    expect(textNamesStubProvider(warning)).toBe(true);
    expect(starNudgeLine(input({
      startUrl: 'https://shop.example/',
      warnings: [warning],
      signal: allFixed,
    }))).toBeNull();
    expect(starNudgeLine(input({
      startUrl: 'https://shop.example/',
      flows: [{ steps: [{ error: '[stub] generateJSON failed' }] }],
      signal: allFixed,
    }))).toBeNull();
    expect(starNudgeLine(input({
      startUrl: 'https://shop.example/',
      bugs: [{ observed: 'STUB — not real-model testing' }],
      signal: allFixed,
    }))).toBeNull();
    expect(runRecordNamesStub({ warnings: ['Planner used gpt-4o-mini'] })).toBe(false);
    expect(starNudgeLine(input({
      startUrl: 'https://shop.example/',
      warnings: ['Planner used gpt-4o-mini'],
      signal: allFixed,
    }))).toContain('https://github.com/monkeytestai/monkeytester');
  });

  it('treats loopback fixture hosts as local', () => {
    expect(isLoopbackUrl('http://127.0.0.1:4173/')).toBe(true);
    expect(isLoopbackUrl('http://localhost/')).toBe(true);
    expect(isLoopbackUrl('https://example.com/')).toBe(false);
    expect(isLoopbackUrl('https://shop.example/')).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });
});
