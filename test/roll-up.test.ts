/**
 * Banana Beings beta.3 run: axe rules were one high bug per page, and
 * POST /api/contact 500 was filed twice. Roll-up keeps one item per axe
 * rule and one HTTP bug per method + path + status.
 */

import { describe, expect, it } from 'vitest';
import { triage } from '../src/triager/index.js';
import { humanStepLabel } from '../src/trace/stepLabel.js';
import type { FlowResult, RunResult, StepResult } from '../src/types.js';

function step(partial: Partial<StepResult> & Pick<StepResult, 'index' | 'action' | 'status'>): StepResult {
  return {
    observation: partial.observation || partial.action,
    ...partial,
  };
}

function flow(id: string, name: string, steps: StepResult[], startUrl = 'https://bananabeings.com/'): FlowResult {
  return {
    flowId: id,
    name,
    description: name,
    kind: 'happy_path',
    startUrl,
    status: 'failed',
    steps,
    durationMs: 10,
    bugIds: [],
    severityIfFails: 'critical',
  };
}

function run(flows: FlowResult[]): RunResult {
  return {
    startUrl: 'https://bananabeings.com/',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    flows,
    bugs: [],
    stats: {
      flowsTotal: flows.length, flowsPassed: 0, flowsFailed: flows.length, flowsBlocked: 0,
      stepsTotal: flows.reduce((sum, item) => sum + item.steps.length, 0),
      stepsPassed: 0, stepsFailed: flows.reduce((sum, item) => sum + item.steps.length, 0),
      bugsCritical: 0, bugsMajor: 0, bugsMinor: 0,
    },
  };
}

describe('axe roll-up and HTTP dedupe', () => {
  it('rolls color-contrast and scrollable-region-focusable into one minor bug each, and keeps one contact 500', () => {
    const pages = [
      'https://bananabeings.com/',
      'https://bananabeings.com/shop',
      'https://bananabeings.com/help',
      'https://bananabeings.com/about',
    ];
    const axeSteps = pages.map((url, index) => step({
      index: index + 1,
      action: `Check WCAG A and AA on ${url}`,
      status: 'failed',
      target: url,
      tool: 'check',
      error: 'axe:color-contrast',
      observation: 'serious color-contrast: Elements must meet minimum color contrast ratio thresholds',
      axeRules: [{
        id: 'color-contrast',
        impact: 'serious',
        help: 'Elements must meet minimum color contrast ratio thresholds',
        pageUrl: url,
      }],
    }));
    axeSteps.push(step({
      index: 5,
      action: 'Check WCAG A and AA on https://bananabeings.com/cart',
      status: 'failed',
      target: 'https://bananabeings.com/cart',
      tool: 'check',
      error: 'axe:scrollable-region-focusable',
      axeRules: [{
        id: 'scrollable-region-focusable',
        impact: 'serious',
        help: 'Scrollable region must have keyboard access',
        pageUrl: 'https://bananabeings.com/cart',
      }, {
        id: 'button-name',
        impact: 'critical',
        help: 'Buttons must have discernible text',
        pageUrl: 'https://bananabeings.com/cart',
      }],
    }));

    const contact = (index: number): StepResult => step({
      index,
      action: index === 1 ? 'Click "Send message"' : '',
      status: 'failed',
      tool: 'click',
      target: 'text:Send message',
      error: 'http-500',
      observation: 'Clicked role:button:Send message. POST https://www.bananabeings.com/api/contact returned HTTP 500.',
      networkFailures: [{
        url: 'https://www.bananabeings.com/api/contact',
        method: 'POST',
        status: 500,
        resourceType: 'fetch',
      }],
    });

    const before = 6 + 2;
    const triaged = triage(run([
      flow('check-axe', 'WCAG A and AA', axeSteps, pages[0]),
      flow('public-form-submit', 'Submit the form on Help', [contact(1)]),
      flow('llm-contact', 'Send a message', [contact(2)]),
    ]));

    const contrast = triaged.bugs.filter(bug => bug.title.includes('color-contrast'));
    const scrollable = triaged.bugs.filter(bug => bug.title.includes('scrollable-region-focusable'));
    const buttonName = triaged.bugs.filter(bug => bug.title.includes('button-name'));
    const http = triaged.bugs.filter(bug => (bug.seenInFlows?.length ?? 0) > 1);

    expect(contrast).toHaveLength(1);
    expect(contrast[0]?.severity).toBe('minor');
    expect(contrast[0]?.affectedPages).toEqual(pages);
    expect(scrollable).toHaveLength(1);
    expect(scrollable[0]?.severity).toBe('minor');
    expect(scrollable[0]?.affectedPages).toEqual(['https://bananabeings.com/cart']);
    expect(buttonName).toHaveLength(1);
    expect(buttonName[0]?.severity).toBe('critical');
    expect(http).toHaveLength(1);
    expect(http[0]?.seenInFlows?.map(item => item.flowId)).toEqual(['public-form-submit', 'llm-contact']);
    expect(triaged.bugs.filter(bug => bug.severity === 'critical' || bug.severity === 'major').map(bug => bug.title)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/color-contrast|scrollable-region-focusable/)]),
    );
    expect(triaged.bugs).toHaveLength(4);
    expect(before).toBe(8);
    const unlabeled = triaged.flows.find(item => item.flowId === 'llm-contact')?.steps[0];
    expect(unlabeled?.label).toBe('Click Send message');
    expect(humanStepLabel({ action: '', tool: 'click', target: 'text:Search' })).toBe('Click Search');
  });
});
