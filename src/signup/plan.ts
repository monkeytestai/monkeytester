/**
 * Sign-up flows that never submit a completed, valid account form unless
 * the caller has an inbox. Without one, the engine plans validation only:
 * empty required fields, an invalid email, and a password mismatch.
 */

import type { SiteMap, SiteMapPage, TestFlow, TestStep } from '../types.js';
import {
  INVALID_SIGNUP_EMAIL,
  MISMATCH_SIGNUP_EMAIL,
  detectSignupPage,
  type SignupSurface,
} from './detect.js';

export const SIGNUP_FLOW_PREFIX = 'signup-';

export function isSignupFlowId(id: string): boolean {
  return id.startsWith(SIGNUP_FLOW_PREFIX);
}

const SIGNUP_CHECK_BY_ID: Record<string, NonNullable<TestStep['signupCheck']>> = {
  'signup-val-empty': 'empty_submit',
  'signup-val-blocked': 'empty_submit',
  'signup-val-invalid-email': 'invalid_email',
  'signup-val-mismatch': 'password_mismatch',
  'signup-inbox': 'inbox_verify',
};

/**
 * Engine sign-up check for a reserved `signup-val-*` or `signup-inbox` id.
 * Model flows such as `signup-page-navigation` are not in this map.
 */
export function signupCheckForFlowId(id: string): NonNullable<TestStep['signupCheck']> | undefined {
  return SIGNUP_CHECK_BY_ID[id];
}

export interface SignupPlan {
  flows: TestFlow[];
  note?: string;
}

/**
 * One sign-up page per plan. `inbox` adds a single live flow the runner
 * executes only when an InboxProvider is actually passed. The plan itself
 * does not contain an address.
 */
export function buildSignupFlows(siteMap: SiteMap, opts: { inbox?: boolean } = {}): SignupPlan {
  const page = siteMap.pages
    .map(candidate => ({ page: candidate, surface: detectSignupPage(candidate) }))
    .find(item => item.surface);
  if (!page?.surface) return { flows: [] };

  const { surface } = page;
  const flows: TestFlow[] = [];
  if (surface.blocked) {
    return {
      flows: [{
        id: 'signup-val-blocked',
        name: `Sign-up asks for ${surface.blocked}`,
        description: `The sign-up form at ${page.page.url} asks for ${surface.blocked}. It is not submitted.`,
        kind: 'edge_case',
        startUrl: page.page.url,
        steps: [{
          action: `Do not submit the sign-up form because it asks for ${surface.blocked}`,
          expectation: `The form is left unsubmitted because it asks for ${surface.blocked}.`,
          signupCheck: 'empty_submit',
        }],
        expectation: `Sign-up is blocked because the form asks for ${surface.blocked}.`,
        outcomeCheck: { kind: 'observable_response' },
        severityIfFails: 'minor',
      }],
      note: `Sign-up was not submitted because the form asks for ${surface.blocked}.`,
    };
  }

  const submit = surface.submitLabels[0] || 'Create account';
  if (surface.email || surface.password) {
    flows.push(validationFlow(page.page, {
      id: 'signup-val-empty',
      name: 'Submit the sign-up form empty',
      description: `Submit the sign-up form at ${page.page.url} with no values. Does not create an account.`,
      expectation: 'Empty submit shows validation and does not create an account.',
      signupCheck: 'empty_submit',
      action: `Click "${submit}" without filling the sign-up form`,
    }));
  }
  if (surface.email) {
    flows.push(validationFlow(page.page, {
      id: 'signup-val-invalid-email',
      name: 'Reject an invalid sign-up email',
      description: `Type an invalid email into the sign-up form at ${page.page.url}. Does not create an account.`,
      expectation: 'An invalid email is rejected by validation and no account is created.',
      signupCheck: 'invalid_email',
      action: `Fill the sign-up email with "${INVALID_SIGNUP_EMAIL}" and click "${submit}"`,
      value: INVALID_SIGNUP_EMAIL,
    }));
  }
  if (surface.password && surface.confirm) {
    flows.push(validationFlow(page.page, {
      id: 'signup-val-mismatch',
      name: 'Reject a mismatched sign-up password',
      description: `Submit the sign-up form at ${page.page.url} with passwords that do not match. Does not create an account.`,
      expectation: 'Mismatched passwords are rejected and no account is created.',
      signupCheck: 'password_mismatch',
      action: `Fill the sign-up form with "${MISMATCH_SIGNUP_EMAIL}" and two different passwords, then click "${submit}"`,
      value: MISMATCH_SIGNUP_EMAIL,
    }));
  }
  if (opts.inbox) {
    flows.push({
      id: 'signup-inbox',
      name: 'Create one account with the configured inbox',
      description: `Allocate one inbox address, submit the sign-up form at ${page.page.url} as MonkeyTest QA, and open the verification link. At most one sign-up per run.`,
      kind: 'happy_path',
      startUrl: page.page.url,
      steps: [{
        action: `Create one account with the inbox address and the name "MonkeyTest QA", then open the verification link`,
        expectation: 'The inbox receives a verification message and the link confirms the address.',
        signupCheck: 'inbox_verify',
      }],
      expectation: 'The inbox provider confirms the address after one sign-up.',
      outcomeCheck: { kind: 'observable_response' },
      severityIfFails: 'major',
    });
  }

  if (flows.length === 0) return { flows: [] };
  const mode = opts.inbox ? 'plus one inbox sign-up' : 'validation only, no inbox';
  return {
    flows,
    note: `Added ${flows.length} sign-up check${flows.length === 1 ? '' : 's'} (${mode}).`,
  };
}

function validationFlow(page: SiteMapPage, spec: {
  id: string;
  name: string;
  description: string;
  expectation: string;
  signupCheck: TestStep['signupCheck'];
  action: string;
  value?: string;
}): TestFlow {
  return {
    id: spec.id,
    name: spec.name.slice(0, 80),
    description: spec.description,
    kind: 'edge_case',
    startUrl: page.url,
    steps: [{
      action: spec.action,
      expectation: spec.expectation,
      signupCheck: spec.signupCheck,
      ...(spec.value ? { value: spec.value } : {}),
    }],
    expectation: spec.expectation,
    outcomeCheck: { kind: 'validation_visible', also: [{ kind: 'url_unchanged' }] },
    severityIfFails: 'major',
  };
}
