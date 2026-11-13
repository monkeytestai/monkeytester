/**
 * Planner phase
 *
 * Converts a SiteMap into a TestPlan: a list of TestFlows that a real user
 * would care about. The planner is told which pages the explorer found, what
 * each one does, what's interactive on it — and asked to pick the most
 * impactful flows to verify.
 *
 * It does NOT generate exhaustive test cases. The runner (next phase) is
 * adversarial and will discover edge cases by behaviour. The planner only
 * needs to give it well-shaped happy paths to anchor the exploration.
 */

import { z } from 'zod';
import type { LLM } from '../llm/index.js';
import type { SiteMap, SiteMapFormInput, SiteMapPage, TestPlan, TestFlow } from '../types.js';
import { type EventBus, noopBus } from '../events.js';
import { ensurePublicFormFlow } from './forms.js';
import { ensureFaultSurfaceFlows } from './faults.js';
import { applyFormsSearchCtaFocus } from './focus.js';
import { reconcileModelFlows } from './inventory.js';
import { salvageModelFlows } from './salvage.js';
import { buildAuthNegativeFlows, isAuthNegativeFlowId } from './authNegative.js';
import { dedupePlannedFlows } from './dedupe.js';
import { buildPageCheckFlows, isPageCheckFlowId } from '../checks/plan.js';
import { buildSignupFlows } from '../signup/plan.js';
import { humanStepLabel } from '../trace/stepLabel.js';
import { plansCompleteSignup } from '../signup/detect.js';
import { plansDisallowedSensitiveSubmit } from '../runner/sensitive.js';
import { MODEL_CREDENTIAL_RULE, signedInPlanRules } from '../auth/contract.js';
import { BASIC_PRESET, type PlanFocus } from '../depth.js';

export interface PlannerOptions {
  /** Soft cap on flows per plan. Default 6. */
  maxFlows?: number;
  /** Include flows that require auth (the runner will surface them as "needs creds"). Default true. */
  includeAuthFlows?: boolean;
  /** A customer session is already signed in. The prompt must not include secrets. */
  signedIn?: boolean;
  /**
   * `forms-search-cta` is the Quick pass (`--depth basic`): keep a public
   * form, a search box, and primary buttons, and do not spend the budget on
   * a disabled control.
   */
  focus?: PlanFocus;
  /**
   * Add reserved `check-*` flows. Default true. They do not consume `maxFlows`.
   */
  pageChecks?: boolean;
  /** Slice page checks to this many crawled pages. Default: every page in the sitemap. */
  maxPages?: number;
  /**
   * When true, add one inbox sign-up flow. The runner still refuses to
   * submit it unless an InboxProvider is passed. Default false.
   */
  signupInbox?: boolean;
  /**
   * When the model returns fewer journeys than this and `maxFlows` allows it,
   * ask once more for at least this many flows. `0` disables the follow-up.
   */
  minFlows?: number;
  /** Optional live event bus. Receives planner lifecycle events. */
  events?: EventBus;
}

/**
 * Accept a partial model payload. One empty `steps` array must not reject
 * the sibling flows. Broken JSON still throws from `generateJSON`; `plan`
 * catches that and continues with the grounded flows.
 */
const LoosePlanSchema = z.object({
  flows: z.unknown().optional(),
  notes: z.unknown().optional(),
}).passthrough();

export async function plan(
  siteMap: SiteMap,
  llm: LLM,
  opts: PlannerOptions = {}
): Promise<TestPlan> {

  const maxFlows = opts.maxFlows ?? 6;
  const includeAuth = opts.includeAuthFlows ?? true;
  const events = opts.events ?? noopBus();
  const started = Date.now();

  if (siteMap.pages.length === 0){
    events.emit({
      phase: 'planner', type: 'plan.skipped',
      message: 'Planner skipped: no pages were successfully explored.',
    });
    return {
      startUrl: siteMap.startUrl,
      siteType: siteMap.siteType,
      flows: [],
      notes: 'Planner skipped: no pages were successfully explored.',
    };
  }

  events.emit({
    phase: 'planner', type: 'plan.start',
    message: `Generating test plan from ${siteMap.pages.length} page${siteMap.pages.length === 1 ? '' : 's'}…`,
    data: { pages: siteMap.pages.length, siteType: siteMap.siteType },
  });

  // Prompt is intentionally split into THREE parts to maximise prompt-cache
  // hits across runs against the same site:
  //
  //   1. `system`     — never changes. Identical across every planner call
  //                     in the engine's lifetime. Anthropic caches it via
  //                     a system-block ephemeral breakpoint; OpenAI caches
  //                     it as part of the message-prefix hash.
  //   2. `cacheable`  — the long stable site-map dump. Identical across all
  //                     calls against the same site. This is by far the
  //                     largest token block in the prompt — caching it has
  //                     the most impact.
  //   3. `prompt`     — the small per-call instructions (maxFlows, auth
  //                     toggle, schema reminder). Tiny, cheap to re-send.
  //
  // Order matters: providers cache by *prefix*, so the dynamic bit goes LAST.
  const system = `You are a senior QA architect. You have just been handed a structured crawl of a real website. Your job is to design a small set of high-quality user journeys — the kind a staff engineer would put on a release checklist — not a pile of brittle UI assertions.

How to think:
  1. First understand the product: who is the visitor, what jobs can they complete without an account, what is marketing vs. application vs. legal.
  2. Then pick DISTINCT journeys that protect the most user value (apply, shop, compare, contact, read a key page, complete a public form).
  3. Each flow must be a realistic anonymous-visitor path using ONLY controls the crawl actually saw.

Hard rules:
  - Plan ONLY against pages and controls in the crawl. startUrl must be one of the visited page URLs.
  - Do NOT invent search boxes, menus, buttons, forms, pages, or journeys the crawl did not show. "View pricing" is not a flow unless that control and page were crawled.
  - Do NOT click a control that leaves the site. OAuth and social buttons ("Continue with Google", "Sign in with Apple") are out of scope.
  - Do NOT repeat the same control label on the same page in two flows.
  - Do NOT assert exact document titles. Titles vary and are not user-critical.
  - Prefer visible labels from the crawl ("Apply now", "Check eligibility") over CSS selectors.
  - Steps must be executable by a Playwright agent with no human, OTP, phone number, or payment card.
  - Do NOT invent an email address (including @example.com). The engine owns sign-up. When an inbox is configured it adds exactly one account-creation flow for a detected sign-up form. When no inbox is configured it adds validation only and does not create an account. Do not add your own completed sign-up. Empty, invalid-email, and password-mismatch checks are allowed.
  - One goal per flow. Do not duplicate the same journey with different wording.
  - Prefer 4–7 concrete steps. Skip "look at the page" filler.
  - Every flow MUST include outcomeCheck. A flow that only says the steps ran is invalid. Prefer a structural check: url_changed, url_unchanged, element_absent when the form leaves, validation_visible, or observable_response (the URL changes, the form resets or disappears, a role=alert or role=status region appears, or the form request returns 2xx or 4xx). Do NOT invent the exact success sentence the page will show ("Thanks for subscribing", "Check your inbox"). text_visible and text_absent are weak and only for words the crawl already showed. A missing invented sentence must not be the reason a flow fails.
  - outcomeCheck.kind is one of text_visible, text_absent, url_changed, url_includes, url_unchanged, element_visible, element_absent, validation_visible, observable_response. text_visible, text_absent, url_includes, element_visible, and element_absent require value.
  - For each form journey, include a success check and an error or edge check (empty submit, invalid value, or a boundary) when the budget allows. Both use only crawled fields and the crawled submit control. Neither check is a completed account sign-up, password reset, OTP or magic-link send, newsletter subscribe, checkout, account deletion, or a contact, enquiry, feedback, support, quote, or get-in-touch message. Empty or invalid validation on those forms is allowed. Do not plan the final submit. The engine never sends a contact message.
  - severityIfFails = critical only if a real user cannot complete a core job (apply, pay, submit, checkout). Visual polish is minor.
  - Do NOT emit kind "auth_required". The engine adds sign-in checks itself. If every crawled page is an auth wall, return "flows": [].
  - ${MODEL_CREDENTIAL_RULE}

Each flow has the shape:
  {
    "id": kebab-case unique within the plan, e.g. "homepage-cta",
    "name": short human title (max 80 chars),
    "description": one sentence of what this flow tests and why it matters,
    "kind": "happy_path" | "edge_case" | "auth_required" | "destructive" | "accessibility" | "visual",
    "startUrl": absolute URL — usually one of the visited pages,
    "steps": array of { "action": "...", "expectation"?: "..." }, 1–8 items,
    "expectation": one-sentence success criterion for the whole flow,
    "outcomeCheck": { "kind": "text_visible" | "text_absent" | "url_changed" | "url_includes" | "url_unchanged" | "element_visible" | "element_absent" | "validation_visible" | "observable_response", "value"?: "text, url fragment, or accessible name" },
    "severityIfFails": "critical" | "major" | "minor"
  }`;

  const journeys = (siteMap.publicJourneys || []).filter(Boolean);
  const authSurfaces = (siteMap.authSurfaces || []).filter(Boolean);

  const cacheable = `Site:        ${siteMap.startUrl}
Product:     ${siteMap.productName || '(not named)'}
Site type:   ${siteMap.siteType}
Description: ${siteMap.summary}
Public journeys a visitor can complete:
${journeys.length ? journeys.map(j => `  - ${j}`).join('\n') : '  (none inferred — infer carefully from pages below)'}
Login / account surfaces noticed (do not enter unless instructed):
${authSurfaces.length ? authSurfaces.map(s => `  - ${s}`).join('\n') : '  (none)'}

Pages explored:
${siteMap.pages.map(p => `
  - URL: ${p.url}
    title: ${p.title}
    summary: ${p.summary}
    auth-gated: ${p.authGated}
    interactive:
      ${p.interactive.length === 0 ? '(none)' : p.interactive.map(i => `${i.kind} "${i.label}"`).join(', ')}
    forms:
      ${p.forms?.length
        ? p.forms.map(f => `${(f.method || 'get').toUpperCase()} ${f.action || '(no action)'} fields=[${f.fields.join(', ') || 'none'}] submit="${f.submitLabel || ''}"`).join(' | ')
        : '(none)'}
    inputs:
      ${formatInputs(p)}
    controls:
      ${p.controls?.length
        ? p.controls.slice(0, 12).map(c => `${c.kind}${c.disabled ? ' disabled' : ''} "${c.label}"${c.href ? ` -> ${c.href}` : ''}`).join(', ')
        : '(none)'}
`).join('')}`;

  const prompt = `Now produce the test plan.

Per-call constraints:
  - Produce AT MOST ${maxFlows} flows total. When the crawl has enough distinct controls, produce at least ${Math.min(5, maxFlows)}. Do not pad with a page or control that is not listed above.
  - Fill the quota with executable public journeys first. A form journey should have a success check and an error or edge check when both fit.
  - Every step must name a control or content that appears in the crawl above. If you cannot, return no flows.
  - ${includeAuth
      ? 'Do NOT add kind="auth_required" flows and do NOT invent credentials. Sign-in and password-reset checks are added by the engine from crawled password fields. If the crawl has no public control, return "flows": [].'
      : 'Do NOT include login, sign-in, OTP, password-reset, or any flow that needs an existing account. Skip auth-gated pages. Fill the plan with public journeys only.'}
  - ${opts.signupInbox
      ? 'An inbox is configured. A detected sign-up form must be tested. The engine adds exactly one sign-up flow for it. Do not skip that form, and do not add a second completed sign-up or invent an email address.'
      : 'No inbox is configured. Do not plan a completed sign-up or account creation. The engine adds validation checks only (empty, invalid email, password mismatch) and will not create an account.'}
  - If a crawled page lists a public form under "forms:", the engine reserves one flow that starts on that page and submits that form when the flow budget is at least 1, even if every other flow is a shopping journey. Prefer a POST contact, help, support, or feedback form over a search box. Use only the scraped fields and submit label. Do not invent a form URL or a field the crawl did not list. A flow that merely says "submit" on that page does not replace the reserved one.
  - Scraped "controls:" are real buttons and links. The engine also keeps grounded flows for an enabled button, a link whose target was not crawled, and a disabled button when the budget allows. Do not invent a control that is not listed.
${opts.focus === 'forms-search-cta' ? `  - This is a Quick pass. Bias the journeys to public forms, search, and primary calls to action. Do not spend a slot on a disabled control.\n` : ''}${opts.signedIn ? `  - ${signedInPlanRules(true)}\n` : ''}
Reply with JSON:
{
  "flows": [ ... ],
  "notes": "(optional: what you understood about the site and what you deliberately skipped)"
}`;

  let modelNotes: string | undefined;
  let modelProblem: string | undefined;
  let discardedModel = false;
  let plannerFallback = false;
  let flows: TestFlow[] = [];
  const loginWall = isLoginWall(siteMap);
  try {
    const result = await llm.generateJSON({
      label: 'planner.generate',
      system,
      cacheable,
      prompt,
      schema: LoosePlanSchema,
    });
    const salvaged = salvageModelFlows(result.flows);
    flows = dedupeFlowIds(salvaged.flows).filter(flow => !isAuthNegativeFlowId(flow.id) && !isPageCheckFlowId(flow.id));
    const unsafeSignup = flows.filter(plansCompleteSignup);
    if (unsafeSignup.length > 0) {
      flows = flows.filter(flow => !plansCompleteSignup(flow));
      const names = unsafeSignup.map(flow => flow.name).join(', ');
      modelProblem = [modelProblem, `Dropped sign-up submit flow${unsafeSignup.length === 1 ? '' : 's'} that would create an account (${names}).`].filter(Boolean).join(' ');
    }
    const sensitivePolicy = { inbox: opts.signupInbox === true };
    const unsafeSensitive = flows.filter(flow => plansDisallowedSensitiveSubmit(flow, sensitivePolicy));
    if (unsafeSensitive.length > 0) {
      flows = flows.filter(flow => !plansDisallowedSensitiveSubmit(flow, sensitivePolicy));
      const names = unsafeSensitive.map(flow => flow.name).join(', ');
      modelProblem = [modelProblem, `Dropped sensitive submit flow${unsafeSensitive.length === 1 ? '' : 's'} (${names}). Validation-only checks remain.`].filter(Boolean).join(' ');
    }
    modelNotes = typeof result.notes === 'string' ? result.notes : undefined;
    const rawCount = Array.isArray(result.flows)
      ? result.flows.length
      : (result.flows && typeof result.flows === 'object' ? 1 : 0);
    if (rawCount === 0 && loginWall) {
      modelNotes = [modelNotes, 'Every crawled page is a login wall, so the planner returned no journeys.'].filter(Boolean).join(' ');
    } else if (rawCount === 0 || salvaged.flows.length === 0) {
      modelProblem = rawCount > 0
        ? `Planner model returned ${rawCount} flow${rawCount === 1 ? '' : 's'} and none had a usable step.`
        : 'Planner model returned no flow list.';
      discardedModel = true;
      plannerFallback = true;
    } else if (salvaged.dropped > 0) {
      modelProblem = `Dropped ${salvaged.dropped} planner flow${salvaged.dropped === 1 ? '' : 's'} that had no usable steps.`;
    }
  } catch (err) {
    modelProblem = err instanceof Error ? err.message : String(err);
    discardedModel = true;
    plannerFallback = true;
    flows = [];
  }

  if (!includeAuth){
    const publicOnly = flows.filter(f => !looksLikeLoginFlow(f));
    if (publicOnly.length > 0) flows = publicOnly;
  }

  const floor = opts.minFlows === 0
    ? 0
    : (opts.minFlows ?? (maxFlows >= 5 ? Math.min(5, maxFlows) : 0));
  if (!discardedModel && !loginWall && floor > flows.length) {
    try {
      const more = await llm.generateJSON({
        label: 'planner.expand',
        system,
        cacheable,
        prompt: expandPrompt(flows, floor, maxFlows),
        schema: LoosePlanSchema,
      });
      const extra = salvageModelFlows(more.flows).flows
        .filter(flow => !isAuthNegativeFlowId(flow.id) && !isPageCheckFlowId(flow.id))
        .filter(flow => !plansCompleteSignup(flow))
        .filter(flow => !plansDisallowedSensitiveSubmit(flow, { inbox: opts.signupInbox === true }));
      flows = mergeById(flows, extra);
    } catch {
      // The thin plan is still usable. Grounding adds the crawl floor.
    }
  }

  const reconciled = reconcileModelFlows(flows, siteMap);
  flows = reconciled.flows;

  const grounded = groundFlows(siteMap, flows, maxFlows, opts.focus, opts.pageChecks !== false, opts.maxPages, opts.signupInbox === true);
  flows = grounded.flows;
  if (plannerFallback && modelProblem) {
    const kept = flows.length > 0
      ? 'grounded flows were kept'
      : 'the crawl had no public form or fault control to keep';
    const reason = truncate(modelProblem, 400);
    console.warn(`[monkeytester] planner fallback: ${reason}`);
    events.emit({
      phase: 'planner', type: 'engine.error',
      message: `Planner model response was unusable; ${kept}.`,
      data: { error: modelProblem, plannerFallback: true },
    });
  }
  const notes = [
    modelNotes,
    modelProblem ? `Planner model response could not be used in full. ${truncate(modelProblem, 400)}` : '',
    reconciled.note,
    grounded.note,
  ].filter(Boolean).join(' ') || undefined;

  // Surface prompt-cache stats so the SaaS can display "saved $X" tooltips.
  const usage = llm.lastUsage;
  events.emit({
    phase: 'planner', type: 'plan.complete',
    message: [
      `Plan ready: ${flows.length} flow${flows.length === 1 ? '' : 's'} to execute.`,
      reconciled.note || '',
    ].filter(Boolean).join(' '),
    data: {
      flows: flows.length,
      flowNames: flows.map(f => f.name),
      ...(reconciled.dropped.length ? { droppedFlows: reconciled.dropped } : {}),
      ...(usage ? { usage } : {}),
    },
  });

  return {
    startUrl: siteMap.startUrl,
    siteType: siteMap.siteType,
    flows: flows.map(labelFlow),
    notes,
    ...(reconciled.dropped.length ? { droppedFlows: reconciled.dropped } : {}),
    plannerLatencyMs: Date.now() - started,
    ...(plannerFallback ? {
      plannerFallback: true,
      plannerFallbackReason: truncate(modelProblem || 'Planner model response could not be used.', 400),
    } : {}),
  };

}

/**
 * Plan made only from the crawl: public form submit plus scraped fault
 * controls, capped at `maxFlows`. Used when the planner model throws before
 * `plan()` can finish, so `executeAndTriage` still has flows to run.
 */
export function groundedTestPlan(siteMap: SiteMap, maxFlows: number, preface?: string, focus?: PlanFocus, pageChecks = true): TestPlan {
  const grounded = groundFlows(siteMap, [], maxFlows, focus, pageChecks);
  return {
    startUrl: siteMap.startUrl,
    siteType: siteMap.siteType,
    flows: grounded.flows.map(labelFlow),
    notes: [preface, grounded.note].filter(Boolean).join(' ') || undefined,
  };
}

function labelFlow(flow: TestFlow): TestFlow {
  return {
    ...flow,
    steps: flow.steps.map(step => step.label?.trim() ? step : { ...step, label: humanStepLabel(step) }),
  };
}

function expandPrompt(flows: TestFlow[], floor: number, maxFlows: number): string {
  const have = flows.length
    ? flows.map(flow => `- ${flow.id}: ${flow.name} @ ${flow.startUrl}`).join('\n')
    : '(none)';
  return `The plan has ${flows.length} flow${flows.length === 1 ? '' : 's'}. That is thin.

Already planned:
${have}

Add journeys until there are at least ${floor} and at most ${maxFlows}.
Use ONLY crawled pages and controls from the site map above.
Each new flow must name a control or field that appears there.
Do not invent a page, button, field, or URL.
Do not repeat a journey already planned.
For a form, prefer a success check and an error or edge check when both are still missing.
Every new flow needs outcomeCheck. Do not plan a completed sign-up submit or invent an email address.
Return the full list, including the flows already planned.

Reply with JSON:
{
  "flows": [ ... ],
  "notes": "(optional)"
}`;
}

function mergeById(base: TestFlow[], extra: TestFlow[]): TestFlow[] {
  const byId = new Map(base.map(flow => [flow.id, flow]));
  for (const flow of extra) {
    if (!byId.has(flow.id)) byId.set(flow.id, flow);
  }
  return [...byId.values()];
}

function groundFlows(
  siteMap: SiteMap,
  modelFlows: TestFlow[],
  maxFlows: number,
  focus?: PlanFocus,
  pageChecks = true,
  maxPages?: number,
  signupInbox = false,
): { flows: TestFlow[]; note?: string } {
  const capped = modelFlows.slice(0, Math.max(0, maxFlows));
  const ensured = ensurePublicFormFlow(capped, siteMap, maxFlows);
  const faults = ensureFaultSurfaceFlows(ensured.flows, siteMap, maxFlows);
  const focused = focus === 'forms-search-cta'
    ? applyFormsSearchCtaFocus(faults.flows, siteMap, maxFlows)
    : undefined;
  const budgeted = focused ? focused.flows : faults.flows;
  const auth = buildAuthNegativeFlows(siteMap);
  const authFlows = auth.flows.slice(0, BASIC_PRESET.engineFlowCaps.authNegative);
  const signup = buildSignupFlows(siteMap, { inbox: signupInbox });
  const checks = pageChecks ? buildPageCheckFlows(siteMap, maxPages) : { flows: [], note: undefined as string | undefined };
  const deduped = dedupePlannedFlows([...budgeted, ...authFlows, ...signup.flows, ...checks.flows], siteMap);
  const added = focused
    ? faults.added.filter(label => deduped.flows.some(flow =>
      flow.steps.some(step => step.action.toLowerCase().includes(label.toLowerCase())),
    ))
    : faults.added;
  const note = [
    ensured.injected ? 'Added a form-submit flow for a public form found in the crawl.' : '',
    added.length
      ? `Added fault-surface flows for controls the crawl saw (${added.join(', ')}).`
      : '',
    focused?.note || '',
    auth.note || '',
    signup.note || '',
    checks.note || '',
    deduped.dropped.length
      ? `Dropped duplicate or off-site flows (${deduped.dropped.join(', ')}).`
      : '',
  ].filter(Boolean).join(' ') || undefined;
  return { flows: deduped.flows, note };
}

function dedupeFlowIds(flows: TestFlow[]): TestFlow[] {
  const seen = new Set<string>();
  return flows.map((flow, index) => {
    let id = flow.id;
    if (seen.has(id)) id = `${id}-${index + 1}`;
    seen.add(id);
    return id === flow.id ? flow : { ...flow, id };
  });
}

function formatInputs(page: Pick<SiteMapPage, 'inputs' | 'forms'>): string {
  const list: SiteMapFormInput[] = page.inputs?.length
    ? page.inputs
    : (page.forms ?? []).flatMap(form => form.inputs ?? []);
  if (list.length === 0) {
    const tokens = (page.forms ?? []).flatMap(form => form.fields);
    return tokens.length ? tokens.join(', ') : '(none)';
  }
  return list.map(input => [
    input.type,
    input.label && `label="${input.label}"`,
    input.name && `name="${input.name}"`,
    input.placeholder && `placeholder="${input.placeholder}"`,
    input.id && `id="${input.id}"`,
    input.preceding && `preceding="${input.preceding}"`,
    input.heading && `heading="${input.heading}"`,
    input.ref && `ref=${input.ref}`,
  ].filter(Boolean).join(' ')).join(' | ');
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function isLoginWall(siteMap: SiteMap): boolean {
  return siteMap.pages.length > 0 && siteMap.pages.every(page => page.authGated);
}

function looksLikeLoginFlow(f: { kind: string; name: string; description: string; steps: { action: string }[] }): boolean {
  if (f.kind === 'auth_required') return true;
  const text = [f.name, f.description, ...f.steps.map(s => s.action)].join(' ').toLowerCase();
  return /\b(log\s?in|sign\s?in|sign\s?up|register|create an account|otp|one[- ]time (code|password)|password reset|forgot password|verify (your )?(phone|email)|enter (your )?otp)\b/.test(text);
}
