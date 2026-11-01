/**
 * 375px viewport: horizontal overflow and tap-target size.
 *
 * A scrollbar is about 15px, so overflow under 32px is ignored. Inline
 * links in a sentence are not tap targets (WCAG 2.5.8 exempts them). A
 * control is a bug only when both width and height are under 24px and it
 * has an accessible name. A row of tiny icons is info, not a pile of bugs.
 */

export const MOBILE_VIEWPORT = { width: 375, height: 812 };

export interface TapTarget {
  name: string;
  width: number;
  height: number;
  tag: string;
}

export interface MobileSnapshot {
  overflow: number;
  targets: TapTarget[];
}

export interface MobileJudgement {
  bugs: string[];
  info: string[];
}

const OVERFLOW_BUG_PX = 32;
const TAP_MIN_PX = 24;

export function judgeMobile(snapshot: MobileSnapshot): MobileJudgement {
  const bugs: string[] = [];
  const info: string[] = [];
  if (snapshot.overflow > OVERFLOW_BUG_PX) {
    bugs.push(`The page is ${Math.round(snapshot.overflow)}px wider than the 375px screen.`);
  } else if (snapshot.overflow > 8) {
    info.push(`Horizontal overflow is ${Math.round(snapshot.overflow)}px, within the scrollbar allowance.`);
  }

  const tiny = snapshot.targets.filter(target =>
    target.width > 0
    && target.height > 0
    && target.width < TAP_MIN_PX
    && target.height < TAP_MIN_PX
    && target.name.trim().length >= 2,
  );
  if (tiny.length > 8) {
    info.push(`${tiny.length} controls are under ${TAP_MIN_PX}px. Too many to call each one a bug.`);
  } else if (tiny.length > 0) {
    const sample = tiny.slice(0, 3).map(target => `"${target.name}" (${Math.round(target.width)}×${Math.round(target.height)})`).join(', ');
    bugs.push(`Tap targets under ${TAP_MIN_PX}px: ${sample}.`);
  }
  return { bugs, info };
}

/** Read in the page. Must not close over Node values; Playwright serializes it. */
export function readMobileInPage(): MobileSnapshot {
  const doc = document.documentElement;
  const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);
  const nodes = document.querySelectorAll('a, button, input, select, textarea, [role="button"]');
  const targets: TapTarget[] = [];
  for (const node of Array.from(nodes)) {
    const el = node as HTMLElement;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    if (el.tagName === 'A' && style.display === 'inline') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight + 40) continue;
    const name = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('value') || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    targets.push({ name, width: rect.width, height: rect.height, tag: el.tagName.toLowerCase() });
  }
  return { overflow, targets };
}
