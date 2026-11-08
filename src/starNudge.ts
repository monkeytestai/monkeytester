/**
 * One optional star line after a verified fix.
 *
 * The line is local. Nothing is sent, and the one-time marker is a file
 * that contains the word "noted" and no identifier. Stub runs, loopback
 * fixtures, CI, JSON output, and a non-interactive stdout do not qualify:
 * there is no reliable "this helped a person" signal in those cases.
 * The README states the same link on the success path for everyone else.
 */

export const STAR_URL = 'https://github.com/monkeytestai/monkeytester';

const STAR_LINE =
  `If this fix was useful, you can star the project: ${STAR_URL}`;

export type VerifyVerdict = 'fixed' | 'still_broken' | 'flaky' | 'healed' | 'blocked';

export interface StarNudgeInput {
  json: boolean;
  tty: boolean;
  ci: boolean;
  optOut: boolean;
  alreadyNoted: boolean;
  /** Loopback target, stub provider, or an explicit stub run. */
  stubOrLocal: boolean;
  outcome?: string;
  signal:
    | { kind: 'verify'; verdicts: VerifyVerdict[] }
    | { kind: 'diff'; stats: { new: number; fixed: number; persisting: number; regressed: number } };
}

export function starMarkerName(): string {
  return '.star-noted';
}

/** True for hosts this repo uses as fixtures. Missing URLs are not local. */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * A verify/diff star is only honest when every filed bug came back fixed
 * and nothing new or worse appeared. `healed` is a locator recovery, not
 * proof the product bug is gone. `blocked` did not reach the check.
 */
export function starNudgeLine(input: StarNudgeInput): string | null {
  if (input.json || !input.tty || input.ci || input.optOut || input.alreadyNoted || input.stubOrLocal) {
    return null;
  }
  if (input.outcome === 'could_not_test' || input.outcome === 'bugs_found') return null;
  if (!useful(input)) return null;
  return STAR_LINE;
}

function useful(input: StarNudgeInput): boolean {
  if (input.signal.kind === 'verify') {
    return input.signal.verdicts.length > 0 && input.signal.verdicts.every(verdict => verdict === 'fixed');
  }
  const { stats } = input.signal;
  return stats.fixed > 0 && stats.new === 0 && stats.persisting === 0 && stats.regressed === 0;
}
