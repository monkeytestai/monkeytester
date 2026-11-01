/**
 * A step the planner left unlabeled still needs a name a report can show.
 * Prefer an explicit label, then the action, then the tool and target.
 */

export function humanStepLabel(step: {
  label?: string;
  action?: string;
  tool?: string;
  target?: string;
}): string {
  const given = clean(step.label);
  if (given) return given;
  const action = clean(step.action);
  const target = readableTarget(step.target);
  if (action && target && !action.toLowerCase().includes(target.toLowerCase())) {
    return clip(`${action} (${target})`);
  }
  if (action) return action;
  const verb = verbFor(step.tool);
  if (target) return clip(`${verb} ${target}`);
  return verb;
}

function readableTarget(target: string | undefined): string {
  const raw = clean(target);
  if (!raw) return '';
  const named = raw.match(/^(?:button|link|searchbox|textbox|text|label|placeholder|role|css)\s*:\s*(.+)$/i);
  if (named) return clean(named[1]);
  return raw;
}

function verbFor(tool: string | undefined): string {
  switch ((tool || '').toLowerCase()) {
    case 'click': return 'Click';
    case 'fill': return 'Fill';
    case 'goto': return 'Open';
    case 'press': return 'Press';
    case 'wait': return 'Wait for';
    case 'assert_text': return 'Check';
    case 'check': return 'Check';
    case 'noop': return 'Skip';
    default: return 'Do';
  }
}

function clean(value: string | undefined): string {
  return clip((value || '').replace(/\s+/g, ' ').trim());
}

function clip(value: string): string {
  return value.length > 160 ? `${value.slice(0, 159)}…` : value;
}
