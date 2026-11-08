/**
 * Internal link check for the docs site and the README.
 * Does not fetch the network. docs.monkeytest.ai URLs must match a file
 * in this repository, a VitePress redirect in vercel.json, or the
 * generated sitemap (configured, emitted at build).
 *
 *   node scripts/check-docs-links.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const docsDir = join(root, 'docs');
const origin = 'https://docs.monkeytest.ai';

const failures = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === '.vitepress' || name === 'node_modules' || name === 'dist') continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (name.endsWith('.md')) out.push(abs);
  }
  return out;
}

function stripFences(text) {
  return text.replace(/```[\s\S]*?```/g, '');
}

function linksIn(text) {
  const found = [];
  const source = stripFences(text);
  const pattern = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<((?:https?:\/\/)[^>\s]+)>|\b(?:href|src)="([^"]+)"/g;
  let match;
  while ((match = pattern.exec(source))) {
    found.push(match[1] || match[2] || match[3]);
  }
  return found;
}

function redirects() {
  const file = join(root, 'vercel.json');
  const json = JSON.parse(readFileSync(file, 'utf8'));
  const sources = new Set();
  const destinations = new Set();
  for (const rule of json.redirects || []) {
    if (typeof rule.source === 'string') sources.add(rule.source.replace(/\/$/, '') || '/');
    if (typeof rule.destination === 'string' && rule.destination.startsWith('/')) {
      destinations.add(rule.destination.replace(/\/$/, '') || '/');
    }
  }
  return { sources, destinations };
}

const redirect = redirects();

function pageFile(urlPath) {
  const clean = urlPath.replace(/\/$/, '') || '/';
  if (clean === '/') return join(docsDir, 'index.md');
  const rel = clean.replace(/^\//, '');
  const md = join(docsDir, `${rel}.md`);
  if (existsSync(md)) return md;
  const index = join(docsDir, rel, 'index.md');
  if (existsSync(index)) return index;
  const pub = join(docsDir, 'public', rel);
  if (existsSync(pub)) return pub;
  return null;
}

function acceptSitePath(urlPath) {
  const clean = (urlPath.split('#')[0] || '').split('?')[0];
  const pathOnly = clean.replace(/\/$/, '') || '/';
  if (pathOnly === '/sitemap.xml') return true;
  if (redirect.sources.has(pathOnly)) return true;
  return Boolean(pageFile(pathOnly));
}

function checkHref(href, from) {
  if (!href || href.startsWith('#') || href.startsWith('mailto:')) return;
  const hashless = href.split('#')[0];
  if (!hashless) return;
  if (hashless.startsWith('http://') || hashless.startsWith('https://')) {
    let url;
    try { url = new URL(hashless); }
    catch { failures.push(`${relative(root, from)}: bad URL ${href}`); return; }
    if (url.origin !== origin) return;
    if (!acceptSitePath(url.pathname)) {
      failures.push(`${relative(root, from)}: no docs page for ${href}`);
    }
    return;
  }
  if (hashless.startsWith('/')) {
    if (!acceptSitePath(hashless)) failures.push(`${relative(root, from)}: missing ${href}`);
    return;
  }
  const abs = normalize(resolve(dirname(from), hashless));
  if (!existsSync(abs)) failures.push(`${relative(root, from)}: missing file ${href}`);
}

const files = [...walk(docsDir), join(root, 'README.md'), join(root, 'CONTRIBUTING.md')];
for (const file of files) {
  for (const href of linksIn(readFileSync(file, 'utf8'))) checkHref(href, file);
}

const llms = readFileSync(join(docsDir, 'public', 'llms.txt'), 'utf8');
for (const href of llms.match(/https?:\/\/[^\s)]+/g) || []) {
  checkHref(href.replace(/[.,]$/, ''), join(docsDir, 'public', 'llms.txt'));
}

if (!existsSync(join(docsDir, 'public', 'robots.txt'))) {
  failures.push('docs/public/robots.txt is missing');
}

const config = readFileSync(join(docsDir, '.vitepress', 'config.mts'), 'utf8');
if (!config.includes('sitemap') || !config.includes(origin)) {
  failures.push('docs/.vitepress/config.mts does not set the docs sitemap hostname');
}
if (!config.includes('rel: \'canonical\'') && !config.includes('rel: "canonical"')) {
  failures.push('docs/.vitepress/config.mts does not emit a canonical link');
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}
console.log(`OK — ${files.length} files, internal docs links resolve.`);
