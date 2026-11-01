/**
 * Recorded plans used to measure the beta.2 false-pass rate.
 * The jewellery case is the one that filed a pass after typing an invented
 * address into Create account. The other rows are the same shape for
 * crawl, smoke, and the-internet-style forms. None of these are live calls.
 */

import type { TestFlow } from '../types.js';
import type { FalsePassCase } from './falsePass.js';

function flow(partial: Pick<TestFlow, 'id' | 'name' | 'steps' | 'expectation'> & Partial<TestFlow>): TestFlow {
  return {
    description: partial.name,
    kind: 'happy_path',
    startUrl: 'https://shop.example/',
    severityIfFails: 'major',
    ...partial,
  };
}

export const FALSE_PASS_CASES: FalsePassCase[] = [
  {
    id: 'jewellery-create-account',
    flowType: 'llm',
    flow: flow({
      id: 'create-a-new-account',
      name: 'Create a New Account',
      startUrl: 'https://jeweller.example/account/register',
      steps: [
        { action: 'Fill the "Email" field with "qa@example.com"' },
        { action: 'Fill the "Password" field with "Test-password-1"' },
        { action: 'Fill the "Confirm password" field with "Test-password-1"' },
        { action: 'Click "Create account"' },
      ],
      expectation: 'The account is created.',
    }),
  },
  {
    id: 'llm-contact-no-check',
    flowType: 'llm',
    flow: flow({
      id: 'contact-us',
      name: 'Contact us',
      steps: [
        { action: 'Fill the "Email" field' },
        { action: 'Click "Send message"' },
      ],
      expectation: 'The journey completes.',
    }),
  },
  {
    id: 'crawl-public-form',
    flowType: 'crawl',
    flow: flow({
      id: 'public-form-submit',
      name: 'Submit the form on Contact',
      startUrl: 'https://shop.example/contact',
      steps: [
        { action: 'Fill the "Email" field', expectation: 'The Email field accepts a value.' },
        { action: 'Click "Send message"', expectation: 'The form submits and the site does not return a server error.' },
      ],
      expectation: 'The public form submits without a server error.',
    }),
  },
  {
    id: 'crawl-fault-click',
    flowType: 'crawl',
    flow: flow({
      id: 'fault-button-save-order',
      name: 'Use Save order',
      steps: [{ action: 'Click "Save order"', expectation: 'The "Save order" control runs without a page error.' }],
      expectation: 'The "Save order" control runs without a page error.',
    }),
  },
  {
    id: 'smoke-read-home',
    flowType: 'smoke',
    flow: flow({
      id: 'read-home',
      name: 'Read the homepage',
      steps: [{ action: 'Read the introductory paragraph', expectation: 'The page loads.' }],
      expectation: 'The homepage loads.',
    }),
  },
  {
    id: 'the-internet-login',
    flowType: 'llm',
    flow: flow({
      id: 'the-internet-login',
      name: 'Log in',
      startUrl: 'https://the-internet.herokuapp.com/login',
      steps: [
        { action: 'Fill the "Username" field with "tomsmith"' },
        { action: 'Fill the "Password" field' },
        { action: 'Click "Login"' },
      ],
      expectation: 'The user is logged in.',
    }),
  },
  {
    id: 'the-internet-forgot-password',
    flowType: 'llm',
    flow: flow({
      id: 'the-internet-forgot',
      name: 'Retrieve password',
      startUrl: 'https://the-internet.herokuapp.com/forgot_password',
      steps: [
        { action: 'Fill the "E-mail" field with "qa@example.com"' },
        { action: 'Click "Retrieve password"' },
      ],
      expectation: 'The form submits.',
    }),
  },
  {
    id: 'auth-neg-empty',
    flowType: 'auth-neg',
    flow: flow({
      id: 'auth-neg-empty-submit',
      name: 'Submit the sign-in form empty',
      kind: 'edge_case',
      steps: [{
        action: 'Click "Sign in" without filling the form',
        expectation: 'The page shows a validation message.',
        check: 'empty_submit',
      }],
      expectation: 'Empty submit shows validation.',
    }),
  },
  {
    id: 'check-console',
    flowType: 'page-check',
    flow: flow({
      id: 'check-console',
      name: 'Console errors on load',
      kind: 'visual',
      steps: [{ action: 'Check console errors on https://shop.example/', pageCheck: 'console', url: 'https://shop.example/' }],
      expectation: 'The page loads without a first-party console error.',
    }),
  },
  {
    id: 'signup-val-empty',
    flowType: 'signup',
    flow: flow({
      id: 'signup-val-empty',
      name: 'Submit the sign-up form empty',
      kind: 'edge_case',
      startUrl: 'https://jeweller.example/account/register',
      steps: [{
        action: 'Click "Create account" without filling the sign-up form',
        signupCheck: 'empty_submit',
      }],
      expectation: 'Empty submit shows validation and does not create an account.',
    }),
  },
  {
    id: 'rerun-no-check',
    flowType: 'replay',
    flow: flow({
      id: 'replay-create-account',
      name: 'Replay create account',
      steps: [
        { action: 'Fill the "Email" field with "qa@example.com"' },
        { action: 'Click "Create account"' },
      ],
      expectation: 'The account is created.',
    }),
  },
];
