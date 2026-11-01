/**
 * Models that reject a custom temperature.
 *
 * gpt-5* and the o-series only accept the provider default. Sending 0.2
 * returns HTTP 400. Callers omit the field. A 400 that still says the
 * temperature is unsupported is retried once without it.
 */

export function modelRejectsCustomTemperature(model: string | undefined): boolean {
  if (!model) return false;
  const name = model.trim().toLowerCase().split('/').pop() || '';
  const id = name.includes(':') ? name.slice(name.lastIndexOf(':') + 1) : name;
  if (id === 'gpt-5' || id.startsWith('gpt-5-') || id.startsWith('gpt-5.')) return true;
  return /^o\d/.test(id);
}

/**
 * Temperature to send. `undefined` means omit the field so the provider
 * uses its default. Models that reject a custom value always omit it.
 */
export function temperatureForRequest(
  model: string | undefined,
  configured: number | undefined,
): number | undefined {
  if (modelRejectsCustomTemperature(model)) return undefined;
  return configured ?? 0.2;
}

export function isUnsupportedTemperatureError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/temperature/i.test(msg)) return false;
  return /unsupported|not supported|only the default/i.test(msg);
}

/**
 * Run `send` with `temperature`. If the provider rejects that field, retry
 * once with the field omitted.
 */
export async function withTemperatureRetry<T>(
  temperature: number | undefined,
  send: (temperature: number | undefined) => Promise<T>,
): Promise<T> {
  try {
    return await send(temperature);
  } catch (err) {
    if (temperature !== undefined && isUnsupportedTemperatureError(err)) {
      return await send(undefined);
    }
    throw err;
  }
}
