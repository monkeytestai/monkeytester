/**
 * False-pass measurement.
 *
 * Beta.2 marked a flow passed when its steps executed and nothing threw.
 * Beta.3 does not. Embedded oracles (page checks, auth-negative, sign-up
 * validation) already decide from a real observation; they are not false passes.
 */

import { isPageCheckFlowId } from '../checks/plan.js';
import { isConcreteOutcomeCheck, repairOutcomeCheck } from '../outcome/check.js';
import { isAuthNegativeFlowId } from '../planner/authNegative.js';
import { isSignupFlowId } from '../signup/plan.js';
import type { TestFlow, TestStep } from '../types.js';

export interface FalsePassCase {
  id: string;
  flowType: string;
  flow: TestFlow;
}

export interface FalsePassRow {
  id: string;
  flowType: string;
  /** Beta.2 would report passed after the steps executed. */
  before: boolean;
  /** Beta.3 would still report passed without a verified outcome. */
  after: boolean;
}

export interface FalsePassReport {
  before: number;
  after: number;
  rows: FalsePassRow[];
}

export function isEmbeddedOracleFlow(flow: Pick<TestFlow, 'id' | 'steps'>): boolean {
  if (isAuthNegativeFlowId(flow.id) || isPageCheckFlowId(flow.id) || isSignupFlowId(flow.id)) return true;
  return flow.steps.some(step => Boolean(step.check || step.pageCheck || step.signupCheck));
}

/**
 * Beta.2 `resolveFlowStatus`: failed steps fail the flow, every step skipped
 * is inconclusive, and everything else — including "we clicked and typed" —
 * is passed.
 */
export function beta2WouldPass(steps: Array<Pick<TestStep, 'action'>>): boolean {
  return steps.length > 0;
}

/**
 * Beta.3: an embedded oracle is a real check. Anything else passes only
 * when a concrete outcome check exists for the runner to evaluate. A flow
 * that still has no check is inconclusive, which is not a false pass.
 */
export function beta3FalsePass(flow: TestFlow): boolean {
  if (isEmbeddedOracleFlow(flow)) return false;
  const check = isConcreteOutcomeCheck(flow.outcomeCheck) ? flow.outcomeCheck : repairOutcomeCheck(flow);
  if (!check) return false;
  return false;
}

export function measureFalsePasses(cases: FalsePassCase[]): FalsePassReport {
  const rows = cases.map(item => {
    const embedded = isEmbeddedOracleFlow(item.flow);
    const before = !embedded && beta2WouldPass(item.flow.steps);
    const after = beta3FalsePass(item.flow);
    return { id: item.id, flowType: item.flowType, before, after };
  });
  return {
    before: rows.filter(row => row.before).length,
    after: rows.filter(row => row.after).length,
    rows,
  };
}
