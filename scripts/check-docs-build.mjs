/**
 * Assert the VitePress build emitted canonicals, a page sitemap, and a
 * robots sitemap pointer. Each check names itself on failure.
 *
 * The sitemap lists page <loc> values. It does not contain its own URL.
 * That URL belongs in robots.txt.
 *
 *   node scripts/check-docs-build.mjs [repo-root]
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] || new URL('..', import.meta.url).pathname);
const dist = join(root, 'docs', '.vitepress', 'dist');

const checks = [
  { name: 'sitemap file exists', kind: 'file', file: join(dist, 'sitemap.xml') },
  { name: 'robots file exists', kind: 'file', file: join(dist, 'robots.txt') },
  {
    name: 'home canonical',
    kind: 'includes',
    file: join(dist, 'index.html'),
    needle: 'rel="canonical" href="https://docs.monkeytest.ai/"',
  },
  {
    name: 'quick-start canonical',
    kind: 'includes',
    file: join(dist, 'getting-started', 'quick-start.html'),
    needle: 'rel="canonical" href="https://docs.monkeytest.ai/getting-started/quick-start"',
  },
  {
    name: 'sitemap lists quick-start',
    kind: 'includes',
    file: join(dist, 'sitemap.xml'),
    needle: '<loc>https://docs.monkeytest.ai/getting-started/quick-start</loc>',
  },
  {
    name: 'robots sitemap pointer',
    kind: 'includes',
    file: join(dist, 'robots.txt'),
    needle: 'Sitemap: https://docs.monkeytest.ai/sitemap.xml',
  },
];

let failed = 0;
for (const check of checks) {
  if (!existsSync(check.file)) {
    failed += 1;
    console.error(`FAIL ${check.name}`);
    console.error(`  missing ${check.file}`);
    continue;
  }
  if (check.kind === 'file') {
    console.log(`ok   ${check.name}`);
    continue;
  }
  const text = readFileSync(check.file, 'utf8');
  if (text.includes(check.needle)) {
    console.log(`ok   ${check.name}`);
    continue;
  }
  failed += 1;
  console.error(`FAIL ${check.name}`);
  console.error(`  file: ${check.file}`);
  console.error(`  missing: ${check.needle}`);
  console.error(`  excerpt: ${text.slice(0, 280).replace(/\s+/g, ' ')}`);
}

if (failed) {
  console.error(`${failed} docs build assertion${failed === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log(`OK — ${checks.length} docs build assertions`);
