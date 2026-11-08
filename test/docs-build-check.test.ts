import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function layout(root: string, sitemap: string, robots: string, home = '<link rel="canonical" href="https://docs.monkeytest.ai/">', quick = '<link rel="canonical" href="https://docs.monkeytest.ai/getting-started/quick-start">') {
  const dist = join(root, 'docs', '.vitepress', 'dist');
  mkdirSync(join(dist, 'getting-started'), { recursive: true });
  writeFileSync(join(dist, 'sitemap.xml'), sitemap);
  writeFileSync(join(dist, 'robots.txt'), robots);
  writeFileSync(join(dist, 'index.html'), home);
  writeFileSync(join(dist, 'getting-started', 'quick-start.html'), quick);
}

function run(root: string) {
  return spawnSync(process.execPath, ['scripts/check-docs-build.mjs', root], { encoding: 'utf8' });
}

describe('docs build assertions', () => {
  it('accepts page locs plus a robots sitemap pointer, and names a missing one', () => {
    const good = mkdtempSync(join(tmpdir(), 'docs-ok-'));
    layout(
      good,
      '<urlset><url><loc>https://docs.monkeytest.ai/getting-started/quick-start</loc></url></urlset>',
      'Sitemap: https://docs.monkeytest.ai/sitemap.xml\n',
    );
    const ok = run(good);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('ok   sitemap lists quick-start');
    expect(ok.stdout).toContain('ok   robots sitemap pointer');

    const bad = mkdtempSync(join(tmpdir(), 'docs-bad-'));
    layout(
      bad,
      '<urlset><url><loc>https://docs.monkeytest.ai/sitemap.xml</loc></url></urlset>',
      'User-agent: *\n',
    );
    const failed = run(bad);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('FAIL sitemap lists quick-start');
    expect(failed.stderr).toContain('FAIL robots sitemap pointer');
    expect(failed.stderr).toContain('missing:');
  });
});
