/**
 * One optional star line after a verified fix.
 *
 * The line is local. Nothing is sent, and the one-time marker is a file
 * that contains the word "noted" and no identifier. CI, JSON, a
 * non-interactive stdout, an inconclusive or unfinished run, and an
 * explicit stub record do not qualify.
 *
 * Stub detection reads strings the engine already stores (`warnings`,
 * step `observation` / `error`, bug `observed`). It does not add a flag.
 */

export const STAR_URL = 'https://github.com/monkeytestai/monkeytester';

const STAR_LINE =
  `If this fix was useful, you can star the project: ${STAR_URL}`;

export interface StarFlowText {
  outcome_detail?: string;
  description?: string;
  failureReason?: string;
  steps?: Array<{ observation?: string; error?: string }>;
}

export interface StarBugText {
  title?: string;
  observed?: string;
  expected?: string;
  triageNotes?: string;
}

export interface StarNudgeInput {
  json: boolean;
  tty: boolean;
  ci: boolean;
  optOut: boolean;
  alreadyNoted: boolean;
  /** `RunResult.startUrl`. Loopback is a local fixture. */
  startUrl?: string;
  /** `RunResult.finishedAt`. Missing means the run did not complete. */
  finishedAt?: string;
  /** `RunResult.outcome`. Only `clean` is a completed success. */
  outcome?: string;
  /** `RunResult.bugs.length` on the run being judged. */
  currentBugCount?: number;
  /** `RunResult.warnings`. Model errors embed `[providerLabel · …]`. */
  warnings?: string[];
  outcome_detail?: string;
  flows?: StarFlowText[];
  bugs?: StarBugText[];
  /** Produced by `diffRuns`. There is no verify signal. */
  signal: { kind: 'diff'; stats: { new: number; fixed: number; persisting: number; regressed: number } };
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
 * True when text already stored on a run names a stub provider.
 * The runner and explorer put provider failures in `warnings` and step
 * errors as `[stub · label]` or `[stub]`. This does not invent a field.
 */
export function textNamesStubProvider(text: string | undefined): boolean {
  if (!text) return false;
  return /\[stub(?:\s*[·:]|\])/i.test(text)
    || /\bprovider(?:Label)?:\s*['"]?stub\b/i.test(text)
    || /\bSTUB — not real-model testing\b/.test(text);
}

export function runRecordNamesStub(input: Pick<StarNudgeInput, 'warnings' | 'outcome_detail' | 'flows' | 'bugs'>): boolean {
  const bits: Array<string | undefined> = [
    input.outcome_detail,
    ...(input.warnings ?? []),
  ];
  for (const flow of input.flows ?? []) {
    bits.push(flow.outcome_detail, flow.description, flow.failureReason);
    for (const step of flow.steps ?? []) bits.push(step.observation, step.error);
  }
  for (const bug of input.bugs ?? []) {
    bits.push(bug.title, bug.observed, bug.expected, bug.triageNotes);
  }
  return bits.some(textNamesStubProvider);
}

/**
 * A star requires a finished `clean` run and a real diff fix.
 * `monkeytest verify` does not ask. Its `fixed` label is not a clean run:
 * a skipped step can be reported fixed, and a flow can stay inconclusive.
 */
export function starNudgeLine(input: StarNudgeInput): string | null {
  if (input.json || !input.tty || input.ci || input.optOut || input.alreadyNoted) return null;
  if (isLoopbackUrl(input.startUrl) || runRecordNamesStub(input)) return null;
  if (!completedClean(input)) return null;
  if (!useful(input)) return null;
  return STAR_LINE;
}

function completedClean(input: StarNudgeInput): boolean {
  if (!input.finishedAt || !input.finishedAt.trim()) return false;
  // Only a finished clean run counts. `inconclusive`, `could_not_test`,
  // `bugs_found`, `failed`, `unavailable`, `unknown`, and a missing outcome
  // are not a success, even when diff stats or verdicts say otherwise.
  if (input.outcome !== 'clean') return false;
  if (input.currentBugCount !== 0) return false;
  return true;
}

function useful(input: StarNudgeInput): boolean {
  const { stats } = input.signal;
  return stats.fixed > 0 && stats.new === 0 && stats.persisting === 0 && stats.regressed === 0;
}
