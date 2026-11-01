/**
 * The fixed demo pages must not keep axe html-has-lang. That finding stayed
 * still_broken after Live e2e flipped the fixture to fixed.
 */

import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { runAxe } from '../src/checks/axe.js';
import { startDemoServer } from './fixtures/demo-app/server.js';

describe('demo fixture axe', () => {
  it('reports html-has-lang only while buggy, and the fixed pages are clean', async () => {
    const demo = await startDemoServer({ mode: 'buggy' });
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      for (const path of ['/', '/contact', '/checkout']) {
        await page.goto(demo.url + path);
        const buggy = await runAxe(page);
        expect(buggy.serious.map(item => item.id)).toContain('html-has-lang');
      }
      const flipped = await fetch(`${demo.url}/__monkeytest/mode`, { method: 'POST', body: 'fixed' });
      expect(flipped.status).toBe(204);
      for (const path of ['/', '/contact', '/checkout', '/tracking']) {
        await page.goto(`${demo.url}${path}?fixed=1`);
        const html = await page.content();
        expect(html).toMatch(/<html[^>]*lang="en"/i);
        const fixed = await runAxe(page);
        expect(fixed.serious.map(item => item.id)).toEqual([]);
      }
    } finally {
      await browser.close();
      await demo.close();
    }
  }, 30_000);
});
