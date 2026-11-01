/**
 * How the Quick pass splits its wall clock.
 *
 * The runner deadline used to start before explore, so a slow planner spent
 * the time the page checks need. Planning gets whatever is left after the
 * crawl, minus a reserve for those checks. A planner that would eat the
 * reserve is skipped and the grounded plan runs instead.
 */

/** Time kept for the guaranteed checks after planning, on a 120s run. */
export const CHECK_EXECUTION_RESERVE_MS = 45_000;

export function executionReserveMs(totalBudgetMs: number): number {
  if (!Number.isFinite(totalBudgetMs) || totalBudgetMs <= 0) return 0;
  return Math.min(CHECK_EXECUTION_RESERVE_MS, Math.floor(totalBudgetMs * 0.4));
}

/**
 * Milliseconds the planner may run. `undefined` means the run has no wall
 * clock, so planning is not capped. `0` means skip the model and use the
 * grounded plan so the checks still have their reserve.
 */
export function plannerBudgetMs(opts: {
  totalBudgetMs?: number;
  /** Absolute deadline already chosen for the run, including explore time. */
  deadlineAt?: number;
  now?: number;
}): number | undefined {
  const now = opts.now ?? Date.now();
  const deadline = opts.deadlineAt ?? (
    opts.totalBudgetMs ? now + opts.totalBudgetMs : undefined
  );
  if (deadline === undefined) return undefined;
  const total = opts.totalBudgetMs ?? Math.max(0, deadline - now);
  const reserve = executionReserveMs(total);
  return Math.max(0, deadline - now - reserve);
}
