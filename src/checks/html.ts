/**
 * Page-level checks (axe, title, lang, description) apply to HTML documents.
 *
 * The response content-type decides. Only `text/html` and
 * `application/xhtml+xml` are checked. When the response has no content-type,
 * the URL is the fallback: sitemap files, `.xml`, `.json`, `.txt`, `.rss`,
 * `.atom`, images, and `.pdf` are not HTML pages.
 */

const HTML_MIME = new Set(['text/html', 'application/xhtml+xml']);

const NON_HTML_EXT = /\.(?:xml|json|txt|rss|atom|pdf|png|jpe?g|gif|webp|svg|ico|bmp|avif|apng|tiff?)(?:$|[?#])/i;

export function mimeType(contentType: string | undefined): string {
  return (contentType || '').split(';')[0].trim().toLowerCase();
}

/** True when the URL looks like a non-HTML file and no content-type was sent. */
export function urlLooksNonHtml(url: string): boolean {
  let path = url;
  try { path = new URL(url).pathname; }
  catch { /* keep the raw string */ }
  let decoded = path;
  try { decoded = decodeURIComponent(path); }
  catch { /* keep the pathname */ }
  if (NON_HTML_EXT.test(decoded)) return true;
  const segments = decoded.split('/').filter(Boolean);
  const file = (segments[segments.length - 1] || '').split('?')[0];
  if (/^sitemap/i.test(file)) return true;
  return segments.some(segment => /^sitemaps?$/i.test(segment));
}

/**
 * True when axe and metadata checks should run.
 * A present content-type wins. The URL is used only when it is missing.
 */
export function shouldRunPageLevelChecks(contentType: string | undefined, url: string): boolean {
  const mime = mimeType(contentType);
  if (mime) return HTML_MIME.has(mime);
  return !urlLooksNonHtml(url);
}
