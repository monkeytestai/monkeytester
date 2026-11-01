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

const SETTINGS_URL = /(?:^|[/?#=&._-])(?:settings|profile|security|dashboard|billing)(?=$|[/?#=&._-])/i;
const CREDENTIAL_LABEL = /\b(sign[\s-]*in|log[\s-]*in|login|sign[\s-]*up|register|create(?:\s+an?)?\s+account)\b/i;

/** A sign-in or sign-up form, including one rendered at `/`, is a public screen. */
export function isPublicCredentialForm(input: {
  url?: string;
  labels?: string[];
  hasPassword?: boolean;
  hasEmail?: boolean;
}): boolean {
  if (input.url && isPublicAuthScreen(input.url)) return true;
  if (input.url && SETTINGS_URL.test(input.url)) return false;
  const credential = CREDENTIAL_LABEL.test((input.labels || []).join(' '));
  return credential && Boolean(input.hasPassword || input.hasEmail);
}

export function decideAuthGated(
  url: string,
  hasPassword: boolean,
  modelSays: boolean,
  hints?: { labels?: string[]; hasEmail?: boolean },
): boolean {
  if (isPublicCredentialForm({ url, labels: hints?.labels, hasPassword, hasEmail: hints?.hasEmail })) return false;
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
