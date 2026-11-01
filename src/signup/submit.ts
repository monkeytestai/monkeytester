/**
 * The sign-up submit control is the button in the same form as the email
 * and password fields. OAuth and social buttons are never that control.
 */

export const OAUTH_TEXT = /\b(continue with|sign[\s-]*in with|sign[\s-]*up with|log[\s-]*in with)\b/i;
export const OAUTH_PROVIDER = /\b(google|facebook|github|apple|microsoft)\b/i;
export const OAUTH_PATH = /\/auth\/(?:google|facebook|github|apple|microsoft|oauth)\b/i;
export const PRIMARY_SUBMIT = /\b(create(?:\s+an?)?\s+account|sign[\s-]*up|signup|register|submit)\b/i;

export function isOauthControl(text: string | undefined, href?: string): boolean {
  const label = (text || '').replace(/\s+/g, ' ').trim();
  const link = href || '';
  if (OAUTH_PATH.test(link) || OAUTH_PATH.test(label)) return true;
  if (/\b(?:continue with|sign[\s-]*in with|sign[\s-]*up with|log[\s-]*in with|use)\s+(?:google|facebook|github|apple|microsoft)\b/i.test(label)) return true;
  if (OAUTH_TEXT.test(label)) return true;
  if (OAUTH_PROVIDER.test(label) && (OAUTH_TEXT.test(label) || /auth/i.test(link))) return true;
  return false;
}

const OAUTH_HOST = /(?:^|\.)(?:accounts\.google\.com|facebook\.com|www\.facebook\.com|github\.com|appleid\.apple\.com|login\.microsoftonline\.com)$/i;

export function isOauthLanding(url: string | undefined): boolean {
  if (!url) return false;
  if (OAUTH_PATH.test(url)) return true;
  try {
    return OAUTH_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Preferred submit label: a non-OAuth primary label, else the first non-OAuth label. */
export function primarySubmitLabel(labels: string[]): string | undefined {
  const usable = labels.map(label => label.trim()).filter(label => label && !isOauthControl(label));
  return usable.find(label => PRIMARY_SUBMIT.test(label)) || usable[0];
}
