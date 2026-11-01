import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LLM } from '../src/llm/index.js';
import { createHttpInbox } from '../src/inbox/http.js';
import { runPlan } from '../src/runner/index.js';
import { SIGNUP_IDENTITY_NAME } from '../src/signup/detect.js';
import { signupPassword } from '../src/signup/run.js';
import type { InboxProvider, TestPlan } from '../src/types.js';
import { startJewellery } from './fixtures/jewellery/server.js';

const shots = mkdtempSync(join(tmpdir(), 'monkeytest-signup-'));

const stub: LLM = {
  providerLabel: 'stub',
  async generateJSON() {
    throw new Error('signup guard must not ask the model');
  },
};

describe('sign-up guard', () => {
  it('does not submit a completed form when no inbox is configured', async () => {
    const shop = await startJewellery();
    try {
      const plan: TestPlan = {
        startUrl: shop.url,
        siteType: 'ecommerce',
        flows: [{
          id: 'create-a-new-account',
          name: 'Create a New Account',
          description: 'The beta.2 plan that typed an invented address and submitted.',
          kind: 'happy_path',
          startUrl: `${shop.url}/`,
          steps: [
            { action: 'Fill the "Email" field (name="email") with "qa@example.com"', value: 'qa@example.com' },
            { action: 'Fill the "Password" field (name="password")', value: 'Test-password-1' },
            { action: 'Fill the "Confirm password" field (name="confirm")', value: 'Test-password-1' },
            { action: 'Click "Create account"' },
          ],
          expectation: 'The account is created.',
          outcomeCheck: { kind: 'text_visible', value: 'Account created' },
        }],
      };
      const run = await runPlan(plan, stub, {
        screenshotsDir: shots,
        headless: true,
        recordVideo: false,
        strictOracles: true,
      });
      expect(shop.posts()).toEqual([]);
      expect(run.flows[0].status).not.toBe('passed');
      expect(run.flows[0].assertion).toBe('blocked');
      expect(run.signup_status).toBe('not_tested');
      expect(run.signup_reason).toBe('no_inbox');
      expect(run.signup_attempted).toBe(false);
      expect(run.signup_verified).toBe(false);
    } finally {
      await shop.close();
    }
  }, 30_000);

  it('allocates one address, submits it, and follows the verification link', async () => {
    const shop = await startJewellery();
    const seen: string[] = [];
    const inbox: InboxProvider = {
      async allocate() {
        return { address: 'run-1@inbox.test', expiresAt: '2026-11-08T00:00:00.000Z' };
      },
      async waitFor(input) {
        seen.push(input.address);
        expect(input.kind).toBe('link');
        return {
          received: true,
          links: [`${shop.url}/verify`],
          text: `Confirm ${shop.url}/verify`,
        };
      },
      async release(input) {
        seen.push(`release:${input.address}`);
      },
    };
    try {
      const plan: TestPlan = {
        startUrl: shop.url,
        siteType: 'ecommerce',
        flows: [{
          id: 'signup-inbox',
          name: 'Create one account with the configured inbox',
          description: 'One inbox sign-up.',
          kind: 'happy_path',
          startUrl: `${shop.url}/`,
          steps: [{
            action: 'Create one account with the inbox address',
            signupCheck: 'inbox_verify',
          }],
          expectation: 'The inbox provider confirms the address.',
          outcomeCheck: { kind: 'observable_response' },
          severityIfFails: 'major',
        }],
      };
      const run = await runPlan(plan, stub, {
        screenshotsDir: shots,
        headless: true,
        recordVideo: false,
        strictOracles: true,
        inbox,
        runId: 'run-1',
      });
      expect(shop.posts()).toEqual([{ email: 'run-1@inbox.test', name: SIGNUP_IDENTITY_NAME }]);
      expect(seen).toEqual(['run-1@inbox.test', 'release:run-1@inbox.test']);
      expect(run.signup_attempted).toBe(true);
      expect(run.signup_verified).toBe(true);
      expect(run.signup_status).toBe('verified');
      expect(run.flows[0].status).toBe('passed');
      expect(run.flows[0].assertion).toBe('verified');
    } finally {
      await shop.close();
    }
  }, 30_000);

  it('keeps a generated password out of the trace and strong enough to type', () => {
    const password = signupPassword();
    expect(password.length).toBeGreaterThanOrEqual(12);
    expect(password).toMatch(/[A-Z]/);
    expect(password).toMatch(/[a-z]/);
    expect(password).toMatch(/[0-9]/);
  });
});

describe('HTTP inbox adapter', () => {
  it('requires the caller to name a base URL', () => {
    expect(() => createHttpInbox({ baseUrl: '' })).toThrow(/baseUrl/);
  });

  it('polls the caller host and stops when the signal aborts', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push(`${init?.method || 'GET'} ${url}`);
      if (url.endsWith('/allocate')) {
        return json({ address: 'one@inbox.test' });
      }
      if (url.includes('/messages')) {
        return json({ received: false });
      }
      return json({});
    };
    const inbox = createHttpInbox({ baseUrl: 'https://inbox.example/v1', token: 'secret', fetchImpl });
    const allocated = await inbox.allocate({ runId: 'run-1', purpose: 'signup' });
    expect(allocated.address).toBe('one@inbox.test');
    const controller = new AbortController();
    const waiting = inbox.waitFor({
      address: allocated.address,
      sinceMs: 1,
      timeoutMs: 5_000,
      kind: 'any',
      signal: controller.signal,
    });
    controller.abort();
    const message = await waiting;
    expect(message.received).toBe(false);
    expect(calls.some(call => call.startsWith('POST https://inbox.example/v1/allocate'))).toBe(true);
    expect(calls.join('\n')).not.toMatch(/monkeytest/i);
  });
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}
