/**
 * USD prices per 1M tokens, used by the bake-off harness.
 *
 * Figures are public list prices (input / output). A model that is not in
 * the table still reports tokens; its cost is null rather than a guess.
 */

export interface ModelPrice {
  /** USD per 1M prompt tokens. */
  inputPerMillion: number;
  /** USD per 1M completion tokens. */
  outputPerMillion: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
  'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
  'gpt-4.1': { inputPerMillion: 2, outputPerMillion: 8 },
  'gpt-4.1-mini': { inputPerMillion: 0.4, outputPerMillion: 1.6 },
  'gpt-4.1-nano': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
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

export function priceForModel(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  if (MODEL_PRICES[model]) return MODEL_PRICES[model];
  const key = model.toLowerCase();
  const hit = Object.keys(MODEL_PRICES).find(name => name.toLowerCase() === key);
  return hit ? MODEL_PRICES[hit] : undefined;
}

/** USD for one run. Null when the model has no row in `MODEL_PRICES`. */
export function estimateCostUsd(
  model: string | undefined,
  promptTokens: number,
  completionTokens: number,
): number | null {
  const price = priceForModel(model);
  if (!price) return null;
  const usd = (promptTokens * price.inputPerMillion + completionTokens * price.outputPerMillion) / 1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
