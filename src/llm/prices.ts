/**
 * USD prices per 1M tokens, used by the bake-off harness.
 *
 * Figures are public list prices. A model that is not in the table still
 * reports tokens; its cost is null rather than a guess. `estimateCostUsd`
 * prices each step at that step's model, so explorer tokens are not billed
 * at the planner rate.
 */

export interface ModelPrice {
  /** USD per 1M uncached prompt tokens. */
  inputPerMillion: number;
  /** USD per 1M completion tokens. */
  outputPerMillion: number;
  /**
   * USD per 1M cached prompt tokens. When omitted, cached tokens use
   * `inputPerMillion`.
   */
  cachedInputPerMillion?: number;
  /**
   * The provider no longer serves this id. The row stays so older token
   * logs can still be priced. Do not select it for a new run.
   */
  deprecated?: boolean;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-4o-mini': { inputPerMillion: 0.15, cachedInputPerMillion: 0.075, outputPerMillion: 0.6 },
  'gpt-4o': { inputPerMillion: 2.5, cachedInputPerMillion: 1.25, outputPerMillion: 10 },
  'gpt-4.1': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-4.1-mini': { inputPerMillion: 0.4, cachedInputPerMillion: 0.1, outputPerMillion: 1.6 },
  'gpt-4.1-nano': {
    inputPerMillion: 0.1,
    cachedInputPerMillion: 0.025,
    outputPerMillion: 0.4,
    deprecated: true,
  },
  'gpt-5-mini': { inputPerMillion: 0.25, cachedInputPerMillion: 0.025, outputPerMillion: 2 },
  'gpt-5-nano': { inputPerMillion: 0.05, cachedInputPerMillion: 0.005, outputPerMillion: 0.4 },
  'o4-mini': { inputPerMillion: 1.1, outputPerMillion: 4.4 },
  'claude-haiku-4-5': { inputPerMillion: 1, outputPerMillion: 5 },
  'claude-sonnet-4-5': { inputPerMillion: 3, outputPerMillion: 15 },
  'claude-3-5-haiku-latest': { inputPerMillion: 0.8, outputPerMillion: 4 },
  'gemini-flash-lite-latest': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'gemini-flash-latest': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'mistral-small-latest': { inputPerMillion: 0.1, outputPerMillion: 0.3 },
  'mistral-large-latest': { inputPerMillion: 2, outputPerMillion: 6 },
  'llama-3.3-70b-versatile': { inputPerMillion: 0.59, outputPerMillion: 0.79 },
};

/** One completed call, priced at its own model. */
export interface TokenCostStep {
  model?: string;
  promptTokens: number;
  completionTokens: number;
  /** Of `promptTokens`, how many were served from the prompt cache. */
  cachedTokens?: number;
}

export function priceForModel(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const key = model.toLowerCase();
  const hit = Object.keys(MODEL_PRICES).find(name => name.toLowerCase() === key);
  return hit ? MODEL_PRICES[hit] : undefined;
}

function roundUsd(usd: number): number {
  return Math.round(usd * 1_000_000) / 1_000_000;
}

function costOf(price: ModelPrice, promptTokens: number, completionTokens: number, cachedTokens = 0): number {
  const cached = Math.min(Math.max(0, cachedTokens), Math.max(0, promptTokens));
  const fresh = Math.max(0, promptTokens) - cached;
  const cachedRate = price.cachedInputPerMillion ?? price.inputPerMillion;
  return (fresh * price.inputPerMillion + cached * cachedRate + Math.max(0, completionTokens) * price.outputPerMillion) / 1_000_000;
}

/**
 * USD for one model, or for a list of steps each priced at its own model.
 * Null when any step with tokens has no row in `MODEL_PRICES`.
 */
export function estimateCostUsd(
  model: string | undefined,
  promptTokens: number,
  completionTokens: number,
): number | null;
export function estimateCostUsd(steps: TokenCostStep[]): number | null;
export function estimateCostUsd(
  modelOrSteps: string | undefined | TokenCostStep[],
  promptTokens?: number,
  completionTokens?: number,
): number | null {
  if (Array.isArray(modelOrSteps)) {
    if (modelOrSteps.length === 0) return 0;
    let total = 0;
    for (const step of modelOrSteps) {
      const price = priceForModel(step.model);
      if (!price) return null;
      total += costOf(price, step.promptTokens, step.completionTokens, step.cachedTokens);
    }
    return roundUsd(total);
  }
  const price = priceForModel(modelOrSteps);
  if (!price) return null;
  return roundUsd(costOf(price, promptTokens ?? 0, completionTokens ?? 0));
}
