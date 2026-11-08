/**
 * Local evidence paths already stored on a run.
 * `monkeytest open` prints these. It does not fetch the page or upload them.
 */

export interface EvidenceRun {
  flows?: Array<{
    videoPath?: string;
    steps?: Array<{ screenshotPath?: string }>;
  }>;
  bugs?: Array<{ evidence?: { screenshots?: string[] } }>;
}

export function collectEvidencePaths(run: EvidenceRun): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (value: string | undefined) => {
    if (!value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  for (const flow of run.flows ?? []) {
    add(flow.videoPath);
    for (const step of flow.steps ?? []) add(step.screenshotPath);
  }
  for (const bug of run.bugs ?? []) {
    for (const shot of bug.evidence?.screenshots ?? []) add(shot);
  }
  return out;
}
