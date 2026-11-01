/**
 * When an inbox is configured, the plan contains exactly one account
 * sign-up for a detected sign-up form. Without an inbox, that flow is absent
 * and the prompt still forbids account creation.
 */

import { describe, expect, it } from 'vitest';
import type { LLM } from '../src/llm/index.js';
import { plan } from '../src/planner/index.js';
import type { SiteMap } from '../src/types.js';

function signupMap(): SiteMap {
  return {
    startUrl: 'https://bananabeings.com/account/register',
    siteType: 'shop',
    summary: 'A shop with account creation.',
    pages: [{
      url: 'https://bananabeings.com/account/register',
      title: 'Create account',
      summary: 'Sign-up form.',
      interactive: [],
      outboundLinks: [],
      authGated: false,
      forms: [{
        action: 'https://bananabeings.com/api/register',
        method: 'post',
        fields: ['email', 'password'],
        inputs: [
          { name: 'email', type: 'email', label: 'Email' },
          { name: 'password', type: 'password', label: 'Password' },
        ],
        submitLabel: 'Create account',
      }],
      controls: [{ kind: 'button', label: 'Create account' }],
    }],
    pendingUrls: [],
    failedUrls: [],
  };
}

function planner(prompts: string[], flows: unknown[] = []): LLM {
  return {
    providerLabel: 'stub',
    async generateJSON(opts) {
      prompts.push(opts.prompt);
      return { flows, notes: 'avoided login/account creation' };
    },
  };
}

describe('inbox sign-up planning', () => {
  it('plans exactly one inbox sign-up when signupInbox is set, and none when it is not', async () => {
    const withInbox: string[] = [];
    const planned = await plan(signupMap(), planner(withInbox, [{
      id: 'model-signup',
      name: 'Create account with Valid Data',
      description: 'Submit sign-up with qa@example.com.',
      kind: 'happy_path',
      startUrl: 'https://bananabeings.com/account/register',
      steps: [{ action: 'Fill email with qa@example.com and click "Create account"', value: 'qa@example.com' }],
      expectation: 'An account is created.',
      outcomeCheck: { kind: 'observable_response' },
      severityIfFails: 'major',
    }]), { maxFlows: 5, minFlows: 0, signupInbox: true });

    const live = planned.flows.filter(flow => flow.steps.some(step => step.signupCheck === 'inbox_verify'));
    expect(live).toHaveLength(1);
    expect(planned.flows.some(flow => flow.id === 'model-signup')).toBe(false);
    expect(withInbox[0]).toMatch(/An inbox is configured/);
    expect(withInbox[0]).toMatch(/exactly one sign-up flow/);
    expect(live[0]?.steps[0]?.label).toMatch(/inbox|account/i);

    const without: string[] = [];
    const skipped = await plan(signupMap(), planner(without), { maxFlows: 5, minFlows: 0, signupInbox: false });
    expect(skipped.flows.some(flow => flow.steps.some(step => step.signupCheck === 'inbox_verify'))).toBe(false);
    expect(without[0]).toMatch(/No inbox is configured/);
    expect(without[0]).toMatch(/Do not plan a completed sign-up/);
  });
});
