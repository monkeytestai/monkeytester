/**
 * axe-core WCAG A/AA.
 *
 * Serious and critical violations fail the step. Moderate and minor hits
 * are info. Missing `autocomplete` on a login field is minor even when axe
 * ranks that rule as serious.
 */

import AxeBuilder from '@axe-core/playwright';
import type { Page } from 'playwright';
import type { Result } from 'axe-core';

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * Common, noisy WCAG hits. They stay bugs, but never above minor, and
 * triage rolls every page into one item per rule.
 */
export const AXE_MINOR_RULES = new Set([
  'color-contrast',
  'scrollable-region-focusable',
]);

export function axeBugSeverity(ruleId: string, impact: string): 'critical' | 'major' | 'minor' {
  if (AXE_MINOR_RULES.has(ruleId)) return 'minor';
  if (impact === 'critical') return 'critical';
  return 'major';
}

export interface AxeJudgement {
  serious: { id: string; impact: string; help: string }[];
  /** Missing autocomplete on login fields. Minor, not serious. */
  autocomplete: string[];
  info: string[];
}

const LOGIN_FIELD = /type=["']?(?:password|email)|name=["']?(?:email|user|login|password)|autocomplete=["']?(?:username|email|current-password|new-password)/i;

export function splitAxeViolations(violations: Result[]): AxeJudgement {
  const serious: AxeJudgement['serious'] = [];
  const autocomplete: string[] = [];
  const info: string[] = [];

  for (const violation of violations) {
    const impact = violation.impact || 'minor';
    const loginAutocomplete = violation.id === 'autocomplete-valid' && violation.nodes.some(node =>
      LOGIN_FIELD.test(`${node.html} ${(node.target || []).join(' ')}`),
    );
    if (loginAutocomplete) {
      autocomplete.push(violation.help || 'Login fields are missing autocomplete.');
      continue;
    }
    if (impact === 'serious' || impact === 'critical') {
      serious.push({
        id: violation.id,
        impact,
        help: violation.help || violation.description || violation.id,
      });
    } else {
      info.push(`${violation.id}: ${violation.help || violation.description || impact}`);
    }
  }
  return { serious, autocomplete, info };
}

export async function runAxe(page: Page): Promise<AxeJudgement> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  return splitAxeViolations(results.violations);
}

/** Login fields with no autocomplete attribute. Axe does not always flag the absence. */
export function readMissingLoginAutocomplete(): string[] {
  const fields: string[] = [];
  for (const node of Array.from(document.querySelectorAll('input'))) {
    const el = node as HTMLInputElement;
    if (el.disabled || el.type === 'hidden' || el.type === 'submit' || el.type === 'button') continue;
    const type = (el.type || '').toLowerCase();
    const name = `${el.getAttribute('name') || ''} ${el.id || ''}`.toLowerCase();
    const login = type === 'password' || type === 'email' || /user|login|email|password/.test(name);
    if (!login) continue;
    if ((el.getAttribute('autocomplete') || '').trim()) continue;
    fields.push(el.getAttribute('name') || el.id || type);
  }
  return fields;
}
