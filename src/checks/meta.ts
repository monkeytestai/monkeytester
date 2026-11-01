/**
 * Title, meta description, lang, viewport, and a single h1.
 *
 * Missing title or viewport is a minor bug (the tab is blank, or the phone
 * lays the page out at desktop width). Description, lang, and h1 count are
 * info: common, and not a broken screen by themselves.
 */

export interface MetaSnapshot {
  title: string;
  description: string;
  lang: string;
  viewport: string;
  h1: number;
}

export interface MetaJudgement {
  /** Minor bugs. Empty when the page only has info-level gaps. */
  bugs: string[];
  info: string[];
}

export function judgeMeta(snapshot: MetaSnapshot): MetaJudgement {
  const bugs: string[] = [];
  const info: string[] = [];
  if (!snapshot.title.trim()) bugs.push('The page has no title.');
  else if (snapshot.title.trim().length < 2) bugs.push('The page title is empty.');
  if (!snapshot.viewport.trim()) bugs.push('The page has no viewport meta tag, so phones use a desktop layout.');
  if (!snapshot.description.trim()) info.push('No meta description.');
  if (!snapshot.lang.trim()) info.push('The document has no lang attribute.');
  if (snapshot.h1 === 0) info.push('The page has no h1.');
  else if (snapshot.h1 > 1) info.push(`The page has ${snapshot.h1} h1 elements.`);
  return { bugs, info };
}

/** Read in the page. Must not close over Node values; Playwright serializes it. */
export function readMetaInPage(): MetaSnapshot {
  const description = document.querySelector('meta[name="description"]');
  const viewport = document.querySelector('meta[name="viewport"]');
  return {
    title: (document.title || '').trim(),
    description: (description?.getAttribute('content') || '').trim(),
    lang: (document.documentElement.getAttribute('lang') || '').trim(),
    viewport: (viewport?.getAttribute('content') || '').trim(),
    h1: document.querySelectorAll('h1').length,
  };
}
