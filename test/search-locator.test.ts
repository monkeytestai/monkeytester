/**
 * Search on Banana Beings timed out clicking `text:Search`. The control is
 * an icon button whose accessible name is aria-label, and a heading also
 * contains the word Search.
 */

import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import { executeAction } from '../src/runner/actions.js';

const HTML = `<!doctype html>
<html><body>
  <h1>Search the catalogue</h1>
  <span hidden>Search</span>
  <form role="search">
    <input type="search" placeholder="Find products" aria-label="Search query">
    <button type="submit" id="go" aria-label="Search" style="width:44px;height:44px"><svg aria-hidden="true"></svg></button>
  </form>
  <script>
    document.querySelector('form').addEventListener('submit', (event) => event.preventDefault());
    document.getElementById('go').addEventListener('click', () => { window.__clicked = 'button'; });
    document.querySelector('h1').addEventListener('click', () => { window.__clicked = 'heading'; });
  </script>
</body></html>`;

describe('search icon button', () => {
  it('clicks the aria-label button instead of waiting on text:Search', async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(HTML);
      const started = Date.now();
      const outcome = await executeAction(page, {
        tool: 'click',
        locator: 'text',
        target: 'Search',
      }, 10_000);
      expect(Date.now() - started).toBeLessThan(3_000);
      expect(outcome.status).toBe('passed');
      expect(outcome.observation).toMatch(/button:Search|aria-label/i);
      expect(await page.evaluate(() => (window as unknown as { __clicked?: string }).__clicked)).toBe('button');
    } finally {
      await browser.close();
    }
  });
});