import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('version wording', () => {
  const prose = [
    'README.md',
    'docs/public/llms.txt',
    'docs/index.md',
    'docs/getting-started/introduction.md',
    'docs/getting-started/installation.md',
    'docs/getting-started/quick-start.md',
    'docs/getting-started/versions.md',
  ].map(path => [path, read(path)] as const);

  it('does not call 0.6.1 the latest release', () => {
    for (const [path, text] of prose) {
      expect(text, path).not.toMatch(/latest[`* ]*is[^\n]{0,40}0\.6\.1/);
      expect(text, path).not.toMatch(/0\.6\.1[^\n]{0,40}latest/);
      expect(text, path).not.toContain('0.7.0-beta.3 in this repository');
    }
  });

  it('separates npm channels, this tree, and the hosted service', () => {
    const versions = read('docs/getting-started/versions.md');
    expect(versions).toContain('0.7.1');
    expect(versions).toContain('0.7.2-beta.2');
    expect(versions).toContain('0.7.0');
    expect(versions).toContain('60def87b');
    expect(versions).toContain('10:16 IST');
    expect(versions).toMatch(/not a pin/i);
    expect(versions).toMatch(/unset safety flags/i);
    expect(versions).toMatch(/does not change that service|not that deployment|not live SaaS protection/i);
    expect(versions).not.toMatch(/gate passed/i);
    const llms = read('docs/public/llms.txt');
    expect(llms).toContain('https://docs.monkeytest.ai/robots.txt');
    expect(llms).toContain('https://docs.monkeytest.ai/sitemap.xml');
    expect(llms).toContain('https://docs.monkeytest.ai/getting-started/versions');
  });
});

describe('protected website header', () => {
  it('keeps the docs hero, the README headline, and the docs nav', () => {
    const home = read('docs/index.md');
    expect(home).toContain('name: Bugs your tests didn\'t think to look for.');
    expect(home).toContain('text: Point it at a URL. It finds the bugs, then proves you fixed them.');
    expect(home).toContain('tagline: Open source, AGPL-3.0. Playwright and your LLM. Node.js 20+.');
    const readme = read('README.md');
    expect(readme).toContain('<h1 align="center">Bugs your tests didn\'t think to look for.</h1>');
    expect(readme).toContain('Point it at a URL. It finds the bugs, then proves you fixed them.');
    const config = read('docs/.vitepress/config.mts');
    expect(config).toContain("{ text: 'Get started', link: '/getting-started/quick-start' }");
    expect(config).toContain("{ text: 'Guides', link: '/guides/how-is-this-different', activeMatch: '/guides/' }");
    expect(config).toContain("{ text: 'Reference', link: '/reference/cli', activeMatch: '/reference/' }");
    expect(config).toContain("{ text: 'GitHub', link: 'https://github.com/monkeytestai/monkeytester' }");
    expect(config).toContain("{ text: 'Cloud', link: 'https://monkeytest.ai' }");
    expect(config).toContain('https://github.com/monkeytestai/monkeytester/edit/main/docs/:path');
  });
});
