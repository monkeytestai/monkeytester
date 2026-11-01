import { describe, expect, it } from 'vitest';
import { FALSE_PASS_CASES } from '../src/audit/cases.js';
import { measureFalsePasses } from '../src/audit/falsePass.js';
import { repairOutcomeCheck } from '../src/outcome/check.js';
import { resolveFlowStatus } from '../src/runner/flowStatus.js';
import { triage } from '../src/triager/index.js';
import type { FlowResult, RunResult, StepResult } from '../src/types.js';

describe('false-pass rate', () => {
  const report = measureFalsePasses(FALSE_PASS_CASES);

  it('counts beta.2 execution-only passes and leaves none in beta.3', () => {
    expect(report.before).toBe(8);
    expect(report.after).toBe(0);
    expect(report.before).toBeGreaterThan(report.after);
    const jewellery = report.rows.find(row => row.id === 'jewellery-create-account');
    expect(jewellery).toMatchObject({ before: true, after: false, flowType: 'llm' });
    expect(report.rows.filter(row => row.flowType === 'auth-neg' || row.flowType === 'page-check' || row.flowType === 'signup').every(row => !row.before)).toBe(true);
  });

  it('repairs a created-account sentence into a check and does not pass without one', () => {
    const jewellery = FALSE_PASS_CASES.find(item => item.id === 'jewellery-create-account')!.flow;
    expect(repairOutcomeCheck(jewellery)?.kind).toBe('observable_response');
    const steps: StepResult[] = jewellery.steps.map((step, index) => ({
      index: index + 1,
      action: step.action,
      status: 'passed',
      observation: 'Executed.',
    }));
    expect(resolveFlowStatus(steps, false, undefined)).toBe('passed');
    expect(resolveFlowStatus(steps, false, 'missing')).toBe('inconclusive');
    expect(resolveFlowStatus(steps, false, 'unverifiable')).toBe('inconclusive');
    expect(resolveFlowStatus(steps, false, 'verified')).toBe('passed');

    const run = triage(passed(steps, 'missing'));
    expect(run.flows[0].status).toBe('inconclusive');
    expect(run.flows[0].outcome_reason).toBe('no_assertion');
    expect(run.bugs).toHaveLength(0);
    expect(run.outcome).not.toBe('clean');
  });
});

function passed(steps: StepResult[], assertion: FlowResult['assertion']): RunResult {
  return {
    startUrl: 'https://jeweller.example/account/register',
    startedAt: '2026-11-01T00:00:00.000Z',
    finishedAt: '2026-11-01T00:00:01.000Z',
    bugs: [],
    stats: {
      flowsTotal: 1,
      flowsPassed: 1,
      flowsFailed: 0,
      flowsBlocked: 0,
      stepsTotal: steps.length,
      stepsPassed: steps.length,
      stepsFailed: 0,
      bugsCritical: 0,
      bugsMajor: 0,
      bugsMinor: 0,
    },
    flows: [{
      flowId: 'create-a-new-account',
      name: 'Create a New Account',
      description: 'Sign up.',
      kind: 'happy_path',
      startUrl: 'https://jeweller.example/account/register',
      status: 'passed',
      assertion,
      steps,
      durationMs: 10,
      bugIds: [],
    }],
  };
}
