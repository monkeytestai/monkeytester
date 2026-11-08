import { describe, expect, it } from 'vitest';
import { isLoopbackUrl, starNudgeLine, type StarNudgeInput } from '../src/starNudge.js';

function input(partial: Partial<StarNudgeInput> = {}): StarNudgeInput {
  return {
    json: false,
    tty: true,
    ci: false,
    optOut: false,
    alreadyNoted: false,
    stubOrLocal: false,
    outcome: 'clean',
    signal: { kind: 'verify', verdicts: ['fixed'] },
    ...partial,
  };
}

describe('star nudge', () => {
  it('prints one link only after every bug is fixed on a real TTY', () => {
    const line = starNudgeLine(input());
    expect(line).toContain('https://github.com/monkeytestai/monkeytester');
    expect(line?.match(/https:\/\//g)).toHaveLength(1);
    expect(starNudgeLine(input({
      signal: { kind: 'diff', stats: { new: 0, fixed: 2, persisting: 0, regressed: 0 } },
    }))).toBe(line);
  });

  it('stays quiet for stubs, CI, JSON, opt-out, inconclusive failures, and a second ask', () => {
    expect(starNudgeLine(input({ json: true }))).toBeNull();
    expect(starNudgeLine(input({ tty: false }))).toBeNull();
    expect(starNudgeLine(input({ ci: true }))).toBeNull();
    expect(starNudgeLine(input({ optOut: true }))).toBeNull();
    expect(starNudgeLine(input({ alreadyNoted: true }))).toBeNull();
    expect(starNudgeLine(input({ stubOrLocal: true }))).toBeNull();
    expect(starNudgeLine(input({ outcome: 'could_not_test' }))).toBeNull();
    expect(starNudgeLine(input({ outcome: 'bugs_found' }))).toBeNull();
    expect(starNudgeLine(input({ outcome: 'inconclusive' }))).toContain('https://github.com/monkeytestai/monkeytester');
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

  it('treats loopback fixture hosts as local', () => {
    expect(isLoopbackUrl('http://127.0.0.1:4173/')).toBe(true);
    expect(isLoopbackUrl('http://localhost/')).toBe(true);
    expect(isLoopbackUrl('https://example.com/')).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });
});
