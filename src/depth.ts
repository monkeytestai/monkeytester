/**
 * Crawl depth presets.
 *
 * The SaaS calls the free run `basic` and labels it "Quick pass"
 * (`depthLabel` in mtaiclient). `standard` and `deep` match the broader
 * passes. `shallow` remains the smaller smoke preset from the cost guide.
 *
 * `--depth` on the CLI and `resolveDepthPreset` are the same table.
 * `focus: 'forms-search-cta'` is how Quick pass biases the planner.
 *
 * `BASIC_PRESET` is the flat object mtaiserver imports. The `basic` row of
 * `DEPTH_PRESETS` is that object, plus the id, label, and focus.
 */

export type DepthPresetName = 'basic' | 'standard' | 'deep' | 'shallow';

export type PlanFocus = 'forms-search-cta';

/**
 * Quick pass numbers. One object so a host does not copy the caps.
 *
 * `pages` is the crawl cap. `llmFlows` is the planner cap (engine checks and
 * auth-negative flows sit outside it). `engineFlowCaps` is how many of those
 * reserved flows the basic run keeps. `totalBudgetMs` is a hard wall-clock
 * budget for the whole run; past it, remaining page checks are skipped.
 */
export const BASIC_PRESET = {
  pages: 6,
  llmFlows: 5,
  engineFlowCaps: {
    checks: 5,
    authNegative: 6,
  },
  stepTimeoutMs: 10_000,
  flowTimeoutMs: 25_000,
  totalBudgetMs: 120_000,
  /** Per-page crawl timeout. Keeps a stuck document from using the whole budget. */
  pageTimeoutMs: 12_000,
} as const;

export interface DepthPreset {
  /** Machine id. Quick pass is `basic`, which is what the SaaS already stores. */
  id: DepthPresetName;
  /** Human label. */
  label: string;
  maxPages: number;
  maxFlows: number;
  /** Set for Quick pass. Omit on the other presets so planning stays unchanged. */
  focus?: PlanFocus;
  /** Per-step action timeout. Set on Quick pass. */
  stepTimeoutMs?: number;
  /** Per-flow wall-clock cap. Set on Quick pass. */
  flowTimeoutMs?: number;
  /** Whole-run wall-clock cap. Past this, remaining page checks are skipped. */
  totalBudgetMs?: number;
  /** Per-page navigation timeout during the crawl. */
  pageTimeoutMs?: number;
  /** Caps for engine flows that do not consume `maxFlows`. */
  engineFlowCaps?: {
    checks: number;
    authNegative: number;
  };
}

export const DEPTH_PRESETS: Record<DepthPresetName, DepthPreset> = {
  basic: {
    id: 'basic',
    label: 'Quick pass',
    maxPages: BASIC_PRESET.pages,
    maxFlows: BASIC_PRESET.llmFlows,
    focus: 'forms-search-cta',
    stepTimeoutMs: BASIC_PRESET.stepTimeoutMs,
    flowTimeoutMs: BASIC_PRESET.flowTimeoutMs,
    totalBudgetMs: BASIC_PRESET.totalBudgetMs,
    pageTimeoutMs: BASIC_PRESET.pageTimeoutMs,
    engineFlowCaps: BASIC_PRESET.engineFlowCaps,
  },
  standard: {
    id: 'standard',
    label: 'Broader pass',
    maxPages: 8,
    maxFlows: 6,
  },
  deep: {
    id: 'deep',
    label: 'Deeper dig',
    maxPages: 16,
    maxFlows: 10,
  },
  shallow: {
    id: 'shallow',
    label: 'Shallow',
    maxPages: 4,
    maxFlows: 3,
  },
};

const ALIASES: Record<string, DepthPresetName> = {
  basic: 'basic',
  'quick-pass': 'basic',
  quickpass: 'basic',
  quick: 'basic',
  standard: 'standard',
  'broader-pass': 'standard',
  deep: 'deep',
  'deeper-dig': 'deep',
  shallow: 'shallow',
};

export function resolveDepthPreset(name: string): DepthPreset {
  const key = name.trim().toLowerCase().replace(/[\s_]+/g, '-');
  const id = ALIASES[key];
  if (!id) {
    throw new Error(
      `Unknown depth preset "${name}". Use basic (Quick pass), standard, deep, or shallow.`,
    );
  }
  return DEPTH_PRESETS[id];
}

/**
 * Apply a preset to page and flow caps. An explicit `--max` or `--flows`
 * wins over the preset so a caller can widen one knob. Timeouts and the
 * total budget come from the preset when it defines them.
 */
export function applyDepthPreset(
  name: string,
  limits: { maxPages: number; maxFlows: number; maxPagesSet?: boolean; maxFlowsSet?: boolean },
): {
  maxPages: number;
  maxFlows: number;
  focus?: PlanFocus;
  preset: DepthPreset;
  stepTimeoutMs?: number;
  flowTimeoutMs?: number;
  totalBudgetMs?: number;
  pageTimeoutMs?: number;
  engineFlowCaps?: DepthPreset['engineFlowCaps'];
} {
  const preset = resolveDepthPreset(name);
  return {
    maxPages: limits.maxPagesSet ? limits.maxPages : preset.maxPages,
    maxFlows: limits.maxFlowsSet ? limits.maxFlows : preset.maxFlows,
    focus: preset.focus,
    preset,
    stepTimeoutMs: preset.stepTimeoutMs,
    flowTimeoutMs: preset.flowTimeoutMs,
    totalBudgetMs: preset.totalBudgetMs,
    pageTimeoutMs: preset.pageTimeoutMs,
    engineFlowCaps: preset.engineFlowCaps,
  };
}
