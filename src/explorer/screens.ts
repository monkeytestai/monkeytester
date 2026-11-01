/**
 * Sign-in and sign-up screens are public. A visitor can open them without
 * an existing session. A password field on a dashboard is still gated.
 */

import { looksLikeAuthUrl } from './queue.js';

const PUBLIC_AUTH = /(?:^|[/?#=&._-])(?:log[-_]?in|sign[-_]?in|sign[-_]?up|register|create[-_]?account|forgot(?:[-_]?password)?|reset(?:[-_]?password)?)(?=$|[/?#=&._-])/i;

export function isPublicAuthScreen(url: string): boolean {
  try {
    const parsed = new URL(url);
    return PUBLIC_AUTH.test(`${parsed.pathname}${parsed.search}`);
  } catch {
    return PUBLIC_AUTH.test(url);
  }
}

export function decideAuthGated(url: string, hasPassword: boolean, modelSays: boolean): boolean {
  if (isPublicAuthScreen(url)) return false;
  return hasPassword || looksLikeAuthUrl(url) || modelSays;
}

/** Same title, heading, and fields means one screen rendered at two URLs. */
export function screenFingerprint(input: { title?: string; heading?: string; fields: string[] }): string | undefined {
  const fields = input.fields.map(field => field.trim().toLowerCase()).filter(Boolean).sort();
  if (fields.length === 0) return undefined;
  const title = (input.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const heading = (input.heading || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return `${title}|${heading}|${fields.join(';')}`;
}
