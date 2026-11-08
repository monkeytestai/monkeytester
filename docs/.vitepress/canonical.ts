/** Production docs origin. The site is built from this repository's docs/. */
export const DOCS_ORIGIN = 'https://docs.monkeytest.ai';

/**
 * Canonical URL for a VitePress page path.
 * Clean URLs, no `.html`, no trailing slash except the site root.
 * `index.md` and `index` are the root.
 */
export function docsCanonical(page: string): string {
  let path = page.trim().replace(/\\/g, '/');
  path = path.replace(/^https?:\/\/docs\.monkeytest\.ai/i, '');
  path = path.replace(/^\.\//, '');
  path = path.replace(/^\//, '');
  path = path.split('#')[0]?.split('?')[0] ?? '';
  path = path.replace(/\.md$/i, '');
  path = path.replace(/\.html$/i, '');
  path = path.replace(/\/index$/, '');
  if (path === 'index') path = '';
  path = path.replace(/\/+$/, '');
  if (!path) return `${DOCS_ORIGIN}/`;
  return `${DOCS_ORIGIN}/${path}`;
}
