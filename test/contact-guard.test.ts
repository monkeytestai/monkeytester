/**
 * Contact, enquiry, feedback, support, and quote submits are never sent.
 * The flow is inconclusive (`contact_submit_blocked`), not a pass and not a bug.
 * Search submits and analytics beacons stay allowed.
 */

import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chromium } from 'playwright';
import type { LLM } from '../src/llm/index.js';
import { evaluateOutcomeCheck } from '../src/outcome/check.js';
import { executeAction } from '../src/runner/actions.js';
import { runPlan } from '../src/runner/index.js';
import { replayTraces } from '../src/runner/replay.js';
import {
  installSubmissionGuards,
  isAnalyticsBeaconUrl,
  isContactRequest,
  isContactSubmit,
  isUserFormSubmission,
  plansDisallowedSensitiveSubmit,
  setStepIntent,
  submissionPolicy,
} from '../src/runner/sensitive.js';
import { triage } from '../src/triager/index.js';
import type { FlowTrace, TestPlan } from '../src/types.js';

const allowAll = {
  inbox: true,
  allow: ['signup', 'reset', 'otp', 'newsletter', 'payment', 'deletion'] as const,
};

describe('contact submit detection', () => {
  it('recognises labels, buttons, action URLs, page context, and flow intent', () => {
    expect(isContactSubmit({
      inForm: true,
      fields: 'note textarea Message What do you need?',
      button: 'Submit',
      actionUrl: 'https://shop.example/send',
    })).toBe(true);
    expect(isContactSubmit({
      inForm: true,
      fields: 'email email Email',
      button: 'Send message',
      actionUrl: 'https://shop.example/send',
    })).toBe(true);
    expect(isContactSubmit({
      inForm: true,
      fields: 'email email Email',
      button: 'Submit',
      actionUrl: 'https://shop.example/api/contact',
    })).toBe(true);
    expect(isContactSubmit({
      inForm: true,
      fields: 'email email Email',
      button: 'Submit',
      actionUrl: 'https://shop.example/send',
      pageUrl: 'https://shop.example/contact',
    })).toBe(true);
    expect(isContactSubmit({
      inForm: true,
      fields: 'email email Email',
      button: 'Submit',
      actionUrl: 'https://shop.example/send',
      pageUrl: 'https://shop.example/about',
      intent: 'Submit the enquiry form',
    })).toBe(true);
    expect(isContactSubmit({
      inForm: true,
      fields: 'q search Search',
      button: 'Search',
      actionUrl: 'https://shop.example/search',
      pageUrl: 'https://shop.example/contact',
      intent: 'Submit the search form',
    })).toBe(false);
    expect(isContactSubmit({
      inForm: false,
      tag: 'a',
      button: 'Contact us',
      pageUrl: 'https://shop.example/',
    })).toBe(false);
  });

  it('does not treat an analytics beacon as a contact submit', () => {
    const url = 'https://www.clarity.ms/collect';
    expect(isAnalyticsBeaconUrl(url)).toBe(true);
    expect(isUserFormSubmission({
      url,
      method: 'POST',
      pageUrl: 'https://shop.example/',
      resourceType: 'fetch',
    })).toBe(false);
    expect(isContactRequest({ url, body: 'message=feedback&subject=hello' })).toBe(false);
    expect(isContactRequest({
      url: 'https://shop.example/search',
      body: 'q=how+do+I+contact+support',
    })).toBe(false);
    expect(isContactRequest({
      url: 'https://shop.example/api/note',
      body: 'message=hello',
    })).toBe(true);
    expect(isContactRequest({
      url: 'https://shop.example/api/contact',
      body: 'email=',
    })).toBe(true);
    for (const path of ['/enquiry', '/feedback', '/support', '/quote', '/get-in-touch']) {
      expect(isContactRequest({ url: `https://shop.example${path}`, body: 'email=' })).toBe(true);
    }
    expect(isContactSubmit({
      inForm: true,
      fields: 'subject text Subject',
      button: 'Submit',
      actionUrl: 'https://shop.example/send',
    })).toBe(true);
    expect(isContactSubmit({
      inForm: true,
      fields: 'comments textarea Comments',
      button: 'Submit feedback',
      actionUrl: 'https://shop.example/send',
    })).toBe(true);
  });

  it('drops a planned contact submit and keeps search and empty validation', () => {
    const policy = { inbox: true, allow: [...allowAll.allow] };
    expect(plansDisallowedSensitiveSubmit({
      name: 'Send a note',
      description: 'Submit the enquiry form',
      steps: [
        { action: 'Fill the "Message" field', value: 'hello' },
        { action: 'Click "Send message"' },
      ],
    }, policy)).toBe(true);
    expect(plansDisallowedSensitiveSubmit({
      name: 'Empty enquiry',
      description: 'Click Send message without filling',
      steps: [{ action: 'Click "Send message" without filling' }],
    }, policy)).toBe(false);
    expect(plansDisallowedSensitiveSubmit({
      name: 'Search the catalogue',
      description: 'Submit the search form',
      steps: [
        { action: 'Fill the "Search" field', value: 'hats' },
        { action: 'Click "Search"' },
      ],
    }, policy)).toBe(false);
  });
});

describe('contact submit guard', () => {
  it('blocks filled submits detected by label, button, or action URL, and still posts search', async () => {
    const site = await startSite();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await installSubmissionGuards(page, { inbox: true, allow: [...allowAll.allow] });

      await page.goto(`${site.url}/by-label`);
      await page.fill('#note', 'hello from the engine');
      const byLabel = await executeAction(page, { tool: 'click', locator: 'text', target: 'Submit' }, 5_000);
      expect(byLabel.status).toBe('skipped');
      expect(byLabel.error).toBe('sensitive-submit');
      expect(byLabel.observation).toContain('contact_submit_blocked');

      await page.goto(`${site.url}/by-button`);
      await page.fill('#email', 'you@example.com');
      const byButton = await executeAction(page, { tool: 'click', locator: 'text', target: 'Send message' }, 5_000);
      expect(byButton.status).toBe('skipped');
      expect(byButton.error).toBe('sensitive-submit');

      await page.goto(`${site.url}/by-action`);
      await page.fill('#email', 'you@example.com');
      const byAction = await executeAction(page, { tool: 'click', locator: 'text', target: 'Submit' }, 5_000);
      expect(byAction.status).toBe('skipped');
      expect(byAction.error).toBe('sensitive-submit');

      await page.goto(`${site.url}/contact`);
      await page.fill('#email', 'you@example.com');
      const byPage = await executeAction(page, { tool: 'click', locator: 'text', target: 'Submit' }, 5_000);
      expect(byPage.error).toBe('sensitive-submit');

      await page.goto(`${site.url}/about`);
      setStepIntent(page, 'Submit the enquiry form\nClick "Submit"');
      await page.fill('#email', 'you@example.com');
      const byIntent = await executeAction(page, { tool: 'click', locator: 'text', target: 'Submit' }, 5_000);
      expect(byIntent.error).toBe('sensitive-submit');

      await page.goto(`${site.url}/find`);
      const opened = await executeAction(page, { tool: 'click', locator: 'text', target: 'Contact us' }, 5_000);
      expect(opened.error).not.toBe('sensitive-submit');
      expect(opened.status).toBe('passed');

      await page.goto(`${site.url}/find`);
      await page.fill('#q', 'hats');
      const search = await executeAction(page, { tool: 'click', locator: 'text', target: 'Search' }, 5_000);
      expect(search.error).not.toBe('sensitive-submit');
      expect(search.status).toBe('passed');

      expect(site.posts['/api/contact'] || []).toEqual([]);
      expect(site.posts['/send'] || []).toEqual([]);
      expect(site.posts['/search']?.length).toBe(1);
    } finally {
      await browser.close();
      await site.close();
    }
  });

  it('aborts an empty contact POST and still lets a client-side required check show', async () => {
    const site = await startSite();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await installSubmissionGuards(page, {});
      await page.goto(`${site.url}/by-label`);
      const emptyFetch = await page.evaluate(async (origin) => {
        try {
          const response = await fetch(`${origin}/api/contact`, { method: 'POST', body: 'email=' });
          return response.status;
        } catch {
          return 0;
        }
      }, site.url);
      expect(emptyFetch).toBe(0);
      expect(submissionPolicy(page)?.blocked).toMatch(/^contact-empty /);
      expect(site.posts['/api/contact'] || []).toEqual([]);

      const policy = submissionPolicy(page);
      if (policy) policy.blocked = undefined;
      await page.goto(`${site.url}/required`);
      const clicked = await executeAction(page, { tool: 'click', locator: 'text', target: 'Send message' }, 5_000);
      expect(clicked.error).not.toBe('sensitive-submit');
      expect(await page.locator('#message').evaluate(el => (el as HTMLTextAreaElement).validity.valueMissing)).toBe(true);
      const verdict = await evaluateOutcomeCheck(page, { kind: 'validation_visible' }, { startUrl: page.url() });
      expect(verdict.state).toBe('verified');
      expect(site.posts['/api/contact'] || []).toEqual([]);
    } finally {
      await browser.close();
      await site.close();
    }
  });

  it('does not let a homepage beacon that mentions a message block the visit', async () => {
    const site = await startSite();
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await installSubmissionGuards(page, {});
      const opened = await executeAction(page, { tool: 'goto', target: `${site.url}/home` }, 5_000);
      expect(opened.status).toBe('passed');
      expect(opened.error).toBeUndefined();
      expect(submissionPolicy(page)?.blocked).toBeUndefined();
      expect(site.posts['/api/contact'] || []).toEqual([]);
    } finally {
      await browser.close();
      await site.close();
    }
  });

  it('marks a live contact submit inconclusive and does not file a bug', async () => {
    const site = await startSite();
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-contact-live-'));
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        throw new Error('contact guard test must not call the model');
      },
    };
    try {
      const plan: TestPlan = {
        startUrl: `${site.url}/by-label`,
        siteType: 'fixture',
        flows: [{
          id: 'send-note',
          name: 'Send a message',
          description: 'Submit the contact form.',
          kind: 'happy_path',
          startUrl: `${site.url}/by-label`,
          steps: [
            { action: 'Fill the "Message" field with "hello from the engine"' },
            { action: 'Click "Submit"' },
          ],
          expectation: 'The message is sent.',
          outcomeCheck: { kind: 'observable_response' },
          severityIfFails: 'critical',
        }],
      };
      const run = triage(await runPlan(plan, llm, {
        screenshotsDir: shots,
        headless: true,
        recordVideo: false,
        strictOracles: true,
        failOn5xx: true,
        stepTimeoutMs: 8_000,
        inbox: {
          async allocate() { return { address: 'qa@example.com' }; },
          async waitFor() { return { text: '' }; },
        },
        allowSensitive: [...allowAll.allow],
      }));
      expect(site.posts['/api/contact'] || []).toEqual([]);
      expect(site.posts['/send'] || []).toEqual([]);
      expect(run.bugs).toEqual([]);
      expect(run.flows[0].status).toBe('inconclusive');
      expect(run.flows[0].status).not.toBe('passed');
      expect(run.flows[0].outcome_reason).toBe('contact_submit_blocked');
      expect(run.flows[0].steps.find(step => /expected outcome/i.test(step.action))?.status).not.toBe('passed');
      expect(run.outcome).not.toBe('bugs_found');
    } finally {
      await site.close();
    }
  }, 30_000);

  it('files a bug when an empty novalidate contact form shows no validation, and sends nothing', async () => {
    const site = await startSite();
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-contact-empty-'));
    const llm: LLM = {
      providerLabel: 'stub',
      async generateJSON() {
        throw new Error('contact guard test must not call the model');
      },
    };
    try {
      const plan: TestPlan = {
        startUrl: `${site.url}/novalidate`,
        siteType: 'fixture',
        flows: [{
          id: 'empty-contact',
          name: 'Empty contact validation',
          description: 'Submit the empty contact form and expect a validation message.',
          kind: 'edge_case',
          startUrl: `${site.url}/novalidate`,
          steps: [{
            action: 'Click "Submit"',
            expectation: 'A validation message is shown.',
          }],
          expectation: 'Submitting the empty contact form shows a validation message.',
          outcomeCheck: { kind: 'validation_visible' },
          severityIfFails: 'major',
        }],
      };
      const run = triage(await runPlan(plan, llm, {
        screenshotsDir: shots,
        headless: true,
        recordVideo: false,
        strictOracles: true,
        failOn5xx: true,
        stepTimeoutMs: 8_000,
      }));
      expect(site.posts['/api/contact'] || []).toEqual([]);
      expect(run.flows[0].status).toBe('failed');
      expect(run.flows[0].outcome_reason).not.toBe('contact_submit_blocked');
      expect(run.flows[0].steps.some(step => step.error === 'sensitive-submit')).toBe(false);
      expect(run.flows[0].steps.some(step => /no client-side validation/i.test(step.observation))).toBe(true);
      expect(run.bugs).toHaveLength(1);
      expect(run.bugs[0].severity).toBe('major');
      expect(run.bugs[0].observed).toMatch(/no client-side validation/i);
      expect(run.bugs[0].observed).toMatch(/nothing sent/i);
      expect(run.outcome).toBe('bugs_found');
    } finally {
      await site.close();
    }
  }, 30_000);

  it('blocks the same contact submit on replay', async () => {
    const site = await startSite();
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-contact-replay-'));
    try {
      const trace: FlowTrace = {
        version: 1,
        flowId: 'send-note',
        name: 'Send a message',
        description: 'Submit the enquiry form.',
        kind: 'happy_path',
        startUrl: `${site.url}/by-button`,
        expectation: 'The message is sent.',
        outcomeCheck: { kind: 'observable_response' },
        severityIfFails: 'critical',
        steps: [
          {
            index: 0,
            action: `Open ${site.url}/by-button`,
            tool: 'goto',
            status: 'passed',
            locator: { strategy: 'css', target: `${site.url}/by-button` },
          },
          {
            index: 1,
            action: 'Fill the "Email" field with "you@example.com"',
            tool: 'fill',
            status: 'passed',
            value: 'you@example.com',
            locator: { strategy: 'label', target: 'Email', label: 'Email', role: 'textbox', name: 'Email' },
          },
          {
            index: 2,
            action: 'Click "Send message"',
            tool: 'click',
            status: 'passed',
            locator: { strategy: 'role', target: 'button:Send message', role: 'button', name: 'Send message' },
          },
        ],
      };
      const run = triage(await replayTraces([trace], {
        screenshotsDir: shots,
        headless: true,
        recordVideo: false,
        strictOracles: true,
        failOn5xx: true,
        stepTimeoutMs: 8_000,
        allowSensitive: [...allowAll.allow],
      }));
      expect(site.posts['/send'] || []).toEqual([]);
      expect(site.posts['/api/contact'] || []).toEqual([]);
      expect(run.bugs).toEqual([]);
      expect(run.flows[0].status).toBe('inconclusive');
      expect(run.flows[0].status).not.toBe('passed');
      expect(run.flows[0].outcome_reason).toBe('contact_submit_blocked');
      expect(run.flows[0].steps.some(step => step.error === 'sensitive-submit')).toBe(true);
      expect(run.flows[0].steps.find(step => /expected outcome/i.test(step.action))?.status).not.toBe('passed');
      expect(run.outcome).not.toBe('bugs_found');
    } finally {
      await site.close();
    }
  }, 30_000);

  it('replays an empty novalidate contact form as a bug and a validating form as a pass', async () => {
    const site = await startSite();
    const shots = mkdtempSync(join(tmpdir(), 'monkeytest-contact-replay-empty-'));
    try {
      const empty = triage(await replayTraces([emptyContactTrace(site.url)], {
        screenshotsDir: shots,
        headless: true,
        recordVideo: false,
        strictOracles: true,
        failOn5xx: true,
        stepTimeoutMs: 8_000,
      }));
      expect(site.posts['/api/contact'] || []).toEqual([]);
      expect(empty.flows[0].status).toBe('failed');
      expect(empty.flows[0].outcome_reason).not.toBe('contact_submit_blocked');
      expect(empty.bugs).toHaveLength(1);
      expect(empty.bugs[0].severity).toBe('major');
      expect(empty.bugs[0].observed).toMatch(/nothing sent/i);
      expect(empty.outcome).toBe('bugs_found');

      const validated = triage(await replayTraces([requiredContactTrace(site.url)], {
        screenshotsDir: shots,
        headless: true,
        recordVideo: false,
        strictOracles: true,
        failOn5xx: true,
        stepTimeoutMs: 8_000,
      }));
      expect(site.posts['/api/contact'] || []).toEqual([]);
      expect(validated.bugs).toEqual([]);
      expect(validated.flows[0].status).toBe('passed');
      expect(validated.flows[0].outcome_reason).not.toBe('contact_submit_blocked');
    } finally {
      await site.close();
    }
  }, 30_000);
});

function emptyContactTrace(origin: string): FlowTrace {
  const startUrl = `${origin}/novalidate`;
  return {
    version: 1,
    flowId: 'empty-contact',
    name: 'Empty contact validation',
    description: 'Submit the empty contact form and expect a validation message.',
    kind: 'edge_case',
    startUrl,
    expectation: 'Submitting the empty contact form shows a validation message.',
    outcomeCheck: { kind: 'validation_visible' },
    severityIfFails: 'major',
    steps: [
      {
        index: 0,
        action: `Open ${startUrl}`,
        tool: 'goto',
        status: 'passed',
        locator: { strategy: 'css', target: startUrl },
      },
      {
        index: 1,
        action: 'Click "Submit"',
        expectation: 'A validation message is shown.',
        tool: 'click',
        status: 'passed',
        locator: { strategy: 'role', target: 'button:Submit', role: 'button', name: 'Submit' },
      },
    ],
  };
}

function requiredContactTrace(origin: string): FlowTrace {
  const startUrl = `${origin}/required`;
  return {
    version: 1,
    flowId: 'required-contact',
    name: 'Required contact validation',
    description: 'Submit the empty contact form and expect a validation message.',
    kind: 'edge_case',
    startUrl,
    expectation: 'Submitting the empty contact form shows a validation message.',
    outcomeCheck: { kind: 'validation_visible' },
    severityIfFails: 'major',
    steps: [
      {
        index: 0,
        action: `Open ${startUrl}`,
        tool: 'goto',
        status: 'passed',
        locator: { strategy: 'css', target: startUrl },
      },
      {
        index: 1,
        action: 'Click "Send message"',
        expectation: 'A validation message is shown.',
        tool: 'click',
        status: 'passed',
        locator: { strategy: 'role', target: 'button:Send message', role: 'button', name: 'Send message' },
      },
    ],
  };
}

function startSite(): Promise<{
  url: string;
  posts: Record<string, string[]>;
  close: () => Promise<void>;
}> {
  const posts: Record<string, string[]> = {};
  const server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const list = posts[url.pathname] || [];
        list.push(body);
        posts[url.pathname] = list;
        res.writeHead(204);
        res.end();
      });
      return;
    }
    const pages: Record<string, string> = {
      '/by-label': `<form method="post" action="/send">
        <label for="note">Message</label>
        <textarea id="note" name="note"></textarea>
        <button type="submit">Submit</button>
      </form>`,
      '/by-button': `<form method="post" action="/send">
        <label for="email">Email</label>
        <input id="email" name="email" type="email">
        <button type="submit">Send message</button>
      </form>`,
      '/by-action': `<form method="post" action="/api/contact">
        <label for="email">Email</label>
        <input id="email" name="email" type="email">
        <button type="submit">Submit</button>
      </form>`,
      '/contact': `<form method="post" action="/send">
        <label for="email">Email</label>
        <input id="email" name="email" type="email">
        <button type="submit">Submit</button>
      </form>`,
      '/about': `<form method="post" action="/send">
        <label for="email">Email</label>
        <input id="email" name="email" type="email">
        <button type="submit">Submit</button>
      </form>`,
      '/required': `<form method="post" action="/api/contact">
        <label for="message">Message</label>
        <textarea id="message" name="message" required></textarea>
        <button type="submit">Send message</button>
      </form>`,
      '/novalidate': `<form method="post" action="/api/contact" novalidate>
        <input type="hidden" name="csrf" value="token-123">
        <label for="note">Message</label>
        <textarea id="note" name="message"></textarea>
        <button type="submit">Submit</button>
      </form>`,
      '/find': `<form method="post" action="/search">
        <label for="q">Search</label>
        <input id="q" name="q" type="search">
        <button type="submit">Search</button>
      </form>
      <p><a href="/next">Contact us</a></p>`,
      '/next': '<p>Next page</p>',
      '/home': `<p>Home</p><script>
        navigator.sendBeacon('https://clarity.ms/collect', 'message=feedback&subject=hello');
      </script>`,
    };
    const html = pages[url.pathname];
    if (!html) {
      res.writeHead(404);
      res.end('missing');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>${url.pathname}</title>${html}`);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('contact site did not bind'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        posts,
        close: () => new Promise((done, fail) => server.close(err => err ? fail(err) : done())),
      });
    });
  });
}
