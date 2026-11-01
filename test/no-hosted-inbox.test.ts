import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const EMAIL = /[A-Z0-9._%+-]+@(?:[A-Z0-9.-]+\.)?(?:monkeytest\.ai|monkeytestai\.com)\b/i;

describe('the package does not ship a MonkeyTest inbox address', () => {
  it('has no monkeytest.ai or monkeytestai.com email address under src/', () => {
    const hits: string[] = [];
    for (const file of walk('src')) {
      const text = readFileSync(file, 'utf8');
      if (EMAIL.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) out.push(...walk(path));
    else if (/\.(ts|js|mjs|cjs|json)$/.test(name)) out.push(path);
  }
  return out;
}
