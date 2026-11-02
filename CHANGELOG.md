# Changelog

All notable changes to **monkeytester** are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.7.2-beta.2] — 2026-11-02

### Fixed

- A browser error page is never a pass. After an action or navigation, if the page URL is `chrome-error://chromewebdata/`, `about:neterror`, `about:certerror`, or `edge-error://`, every outcome check on that page fails to verify. Live runs and replay (`rerun`) use the same rule. A request aborted by our own guard (a sensitive or contact submit, or `net::ERR_BLOCKED_BY_CLIENT`) leaves the flow inconclusive. Any other `net::ERR_*` is a failure, and the evidence names that error. The opening "could not load the starting page" case stays `site_unreachable`.
- A bug's `page_url` is never a `chrome-error://` or other browser-internal URL. It is the last real http(s) page before the action, for example `/help`.
- Replay keeps the recorded role and accessible name when it finds the element by test id. `fingerprintV2` ignores a test id on its own, so the same bug (the empty contact form on `/help`) now hashes the same way on a live run and on replay. Bugs that already had an http(s) location and a role or name keep their `fingerprintV2`. A bug whose location was a browser error URL now uses the last http(s) page, so that hash can change.
- Replay repro steps do not list the same `Open <url>` step twice in a row. The stored opening navigation and the report's opening step are one step.
- A click that asks for a button, or for Search, Submit, Go, or Find, and resolves to a text field, search box, textarea, or combobox no longer counts as a click on that field. The bare target `Search` counts, and so does a description such as `Submit the search form by clicking "Search"`. Verbs include click/clicking/clicked, press/pressing/pressed, tap/tapping/tapped, and hit. Inside a form, the field is submitted with Enter (a textarea or select uses `requestSubmit`). The step says the button was absent and the input was submitted via Enter. Sensitive and contact guards run on that Enter the same way they run on a click. A text field that is not in a form is `locator_mismatch`, so the flow is inconclusive and is not a site bug. A real button is still clicked. This was a false positive on bananabeings.com: `click button Search` hit the header text field, nothing was submitted, and the planner's `url_changed` check then failed because the URL stayed and the page snapshot did not change. That check does not override the 0.7.1 rule. A URL that stays put is still inconclusive when the page changed, and it is still a bug when a real control leaves the page unchanged. The no-op click never reaches that check. If a click still resolves to a text field and the only later miss is that the URL stayed or the snapshot did not change, the flow is inconclusive (`locator_mismatch`), not a bug. A real button that leaves the page unchanged is still a bug.

### Added

- `OutcomeReason` `request_blocked`. Additive. A blocked network request that is not a contact submit. Contact submits stay `contact_submit_blocked`. Existing reason codes are unchanged.

## [0.7.2-beta.1] — 2026-11-02

### Fixed

- The engine no longer submits a contact, enquiry, feedback, support, quote, or get-in-touch message form. Detection uses field names and labels (`message`, `enquiry`, `inquiry`, `subject`, `comments`, `feedback`), button text (`Send message`, `Submit enquiry`, `Contact us`, `Get in touch`), the action URL (`/contact`, `/api/contact`, `/enquiry`, `/feedback`, `/support`), the page URL, and the planner's flow intent. A search box is not a contact form. Analytics beacons are still not sensitive submits.
- The real POST, PUT, or PATCH is aborted, including an empty body. A filled click is refused before it runs. A click that only shows client-side validation, and does not send a request, can still be checked. The flow is inconclusive with `outcome_reason` `contact_submit_blocked`. It is not a pass and not a bug. Live runs and replay (`rerun`) use the same guard. There is no allow flag for this submit.
- An empty contact submit that the flow expected to show a validation message, and that sent no client-side check before the request, is a failed step. The evidence is that monkeytester blocked the request and nothing was sent. The bug keeps the plan's severity. A filled submit stays `contact_submit_blocked`. Replay does not leave the outcome check as passed after a refused contact submit.

### Added

- `OutcomeReason` `contact_submit_blocked`. Additive. Existing reason codes are unchanged.

## [0.7.1] — 2026-11-02

Stable 0.7.1. Same code as 0.7.1-beta.1 (see below). On app.monkeytest.ai and bananabeings.com, false MAJORs on stored-plan replay fell from 25 to 0, with 0% live false positives and no real bugs lost.

## [0.7.1-beta.1] — 2026-11-02

### Fixed

- Stored-plan replay (`monkeytest rerun` and `replayTraces`) uses the same outcome rules as a live run. A page visit that lands on a same-origin sign-in URL passes, and the `auth-redirect` note is recorded once. Sign-in checks (`auth-neg-*`, including a wrong password) and sign-up validation (`signup-val-*`) are executed by the same checks as a live run. Sensitive submits stay blocked, and OAuth is not clicked.
- A recorded locator that no longer matches is inconclusive. The step error stays `locator_mismatch` and the flow's `outcome_reason` is `automation_error`. It is not a confirmed site bug, including when the stored step has no locator and the plan severity is critical or major. Replay tries the step's quoted label, role, or text before giving up. `verify` still reports that miss as blocked, so a later bug is not treated as reproduced.
- A live run no longer lists the `auth-redirect` suggestion twice on the flow. The opening navigation and the planned goto both observe it; the flow keeps one, and so does the step list. The run-level list was already deduped.
- Replay page checks wait for paint the same way a live check does. A 200ms pause judged `/signup` before it rendered and marked a real color-contrast failure as passed.
- Replay keeps each page check's axe findings. Triage rolls them up by rule and applies the same minor caps and fingerprints as a live run, instead of one major bug per page.
- Page checks for accessibility and metadata run only on HTML. The response content-type must be `text/html` or `application/xhtml+xml`. When the content-type is missing, `.xml`, `sitemap*`, `.json`, `.txt`, `.rss`, `.atom`, images, and `.pdf` are skipped. A sitemap such as `/sitemaps/static.xml` is not filed as a missing title or `html-has-lang`.
- A flow whose only miss is that the URL stayed the same is inconclusive. It is still a bug when the page shows an error, a first-party console error or a failed request was recorded, or the DOM and field state did not change after the action.
- A 404 on a URL discovered only from a sitemap is minor. A 404 on a link found in the page stays at the check's severity.
- `POST /__l5e/trackevents` (Lovable analytics) is an analytics beacon, not a sensitive submit.

## [0.7.0] — 2026-11-01

First stable 0.7.0. It bundles 0.7.0-beta.1 through beta.5 with no code changes since beta.5. Highlights:

- Accuracy: on live sites the false-positive rate fell from 56% (beta.3) to 11% (beta.4) to 0 of 12 bugs (beta.5), with no real bugs lost.
- Outcome checks: a flow passes only if its outcome is verified, otherwise it is inconclusive (`no_assertion`, `assertion_unverifiable`).
- Pluggable inbox for email signup (`--inbox`, `--inbox-http`). The engine never defaults to a monkeytest.ai address.
- Safety guards: sensitive submits (reset, OTP, newsletter, payment, account deletion) are blocked unless `allowSensitive` or an inbox allows them. OAuth buttons are never clicked.
- Per-page checks (HTTP, accessibility rolled up per rule, mobile, metadata, console) with real durations, plus `RunResult.suggestions`.
- A wrong-password rejection and a signed-out redirect to sign-in are passes, not bugs.

All API changes since 0.6.1 are additive. See the beta sections below.

## [0.7.0-beta.5] — 2026-11-01

### Fixed

- Analytics and RUM beacons are not sensitive submits. `sendBeacon` and keepalive requests, including `clarity.ms`, `google-analytics.com`, `googletagmanager.com`, `/cdn-cgi/rum`, Segment, Mixpanel, Hotjar, Plausible, PostHog, and Sentry ingest, no longer match words such as payment or reset. A homepage visit or a "Forgot your password?" link is not inconclusive because a third-party body contained those words. Same-origin and form-action `POST`, `PUT`, and `PATCH` submits are still blocked unless `allowSensitive` or an inbox allows them. OAuth navigations are still aborted.
- The demo fixture's fixed pages set `lang="en"`. axe-core `html-has-lang` was still broken after the fixture flipped to fixed, so Live e2e exited 1 with `lingering=1` while the four seeded bugs were fixed. The buggy pages still omit `lang`, and verify clears that finding.
- A page visit that lands on a same-origin login, sign-in, or sign-up URL is a pass. HTTP 3xx and client-side redirects both count. The note is an info suggestion (`auth-redirect`), and the landing page is a public screen. Cross-origin redirects, error pages, redirect loops, and HTTP 4xx/5xx are unchanged.

### Added

- `SuggestionKind` `auth-redirect`.

## [0.7.0-beta.4] — 2026-11-01

### Fixed

- OpenAI, Anthropic, and Mistral calls omit `temperature` for models that reject it (`gpt-5*`, o-series). A 400 that says temperature is unsupported is retried once without the field. Other models still default to 0.2.
- A planner failure is visible. `TestPlan.plannerFallback` and `plannerFallbackReason` are set, and the process logs `planner fallback`. A model that correctly returns no journeys on a login wall is not a failure. The run stays `login_required`.
- Planning has its own budget. On a timed run the checks keep a reserve (45s of the 120s Quick pass, or 40% of a shorter budget). A planner that would eat that reserve is skipped and the grounded plan runs, so the checks are not starved.
- The crawler keeps the trailing slash on the URL it visits. Dedup still ignores the slash. `https://the-internet.herokuapp.com/add_remove_elements/` is no longer requested without the slash (that URL 404s).
- The crawl does not invent the origin root. A root 404 is reported only when the start URL is the root or a page links to it.
- An uncaught page error from a script on a different registrable domain (ads, analytics, tag managers) is a suggestion, not a major or critical bug, and it does not fail navigation. A first-party page error keeps its current severity.
- Missing autocomplete, a missing viewport or meta description, and horizontal overflow on a page with no viewport meta are suggestions. They are not bugs, not failures, and not part of the verdict. Serious accessibility failures (missing labels, contrast, and the rest of axe) stay bugs. A missing title stays a bug. Tiny tap targets stay bugs.
- The planner drops a journey that navigates to any URL the crawl did not see, including a URL on another host.
- `estimateCostUsd` prices each step at that step's model. `gpt-5-mini` and `gpt-5-nano` have price rows. `gpt-4.1-nano` is marked deprecated.
- Explorer model errors are on `SiteMap.warnings` and on the page (`SiteMapPage.warnings`), as well as in the server log. `RunResult.warnings` copies them, plus a line when the planner used the grounded fallback.
- axe-core findings roll up by rule id across pages into one bug with `affectedPages`. `color-contrast` and `scrollable-region-focusable` are minor at most. Other serious or critical rules stay bugs, also one per rule.
- The same HTTP failure (method + path + status) from two flows is one bug. `seenInFlows` lists the flows. Every step gets a `label`, taken from the action and target when the planner omits one.
- A configured inbox (`MonkeyConfig.inbox`, `run.inbox`, or `plan.signupInbox: true`) plans exactly one account sign-up for a detected sign-up form. The "do not create an account" instruction applies only when no inbox is configured. `exploreAndPlan` and `executeAndTriage` pass the flag through.
- A click aimed at `text:Search` prefers `getByRole(button | link | searchbox)`, then label, placeholder, and aria-label, and uses a stored CSS selector first. Hidden and duplicate matches are skipped. Text is the fallback. The recorded role is the element's role, so a link is not replayed as a button.
- Sign-up validation clicks the form's own submit (`type="submit"` or a create-account / sign-up / register label). It does not click the first button, and it does not click OAuth controls (`Use Facebook`, `Continue with`, `Sign in with`, and `/auth/<provider>`). A hidden honeypot is not filled. A fill that fails before submit is `signup_reason` `automation_error` with `signup_started: true`, not a site bug. No sign-up form reports `signup_reason` `no_signup_form`.
- Password-reset, OTP / magic-link / send-code, newsletter, checkout/payment, and account-deletion submits are blocked in the runner and at the network (the POST is aborted) unless the host allows them. An inbox allows OTP, reset, and the one sign-up. Empty validation still runs. `RunnerOptions.allowSensitive` names any extra kinds.
- Navigation to `/auth/<provider>` or a known OAuth host is aborted. The flow is inconclusive.
- Invented success copy is not a failing check. `text_visible` and `text_absent` misses are inconclusive. The planner is told to prefer a URL change, a form that leaves, a `role=alert` / `role=status` region, or the form request's HTTP status. A fill that leaves the field empty is an automation error. A confirm dialog is accepted only when the remaining steps ask for it.
- A page error with no script URL in the stack or the message is a suggestion (`unattributed-error`), not a major bug. When the message names a script, that script decides first-party vs third-party.
- Page checks run before sign-up and model flows, and each check records its own `durationMs`. A check skipped because the run is out of time has `outcome_reason` `budget_exhausted`, not a 0ms couldn't-confirm.
- Sign-in, sign-up, register, and password-reset URLs are public screens, not auth-gated. Two URLs that render the same title, heading, and fields (for example `/` and `/signin`) are one page.
- An input placeholder is not visible text. A placeholder of "Success" does not satisfy a text assertion.
- A wrong-password check passes when the page shows a sign-in error (including "correct login details", "not recognised", or an alert) or the auth request returns 400, 401, 403, or 422 and the URL stays on the login page. An empty field after the fill is an automation error, not a missing error message.
- A sign-in or sign-up URL counts as a public screen even if an older flag still says it is auth-gated. A sign-in form rendered at `/` is a public screen too.
- Page-check `durationMs` is the measured time. A check that finished in under a millisecond is 0.

### Added

- `RunResult.suggestions` and `Suggestion` (`pageUrl`, `title`, `detail`, `kind`, `severity: 'info'`). Group by `pageUrl` for a per-page list. Omitted when empty.
- `BugReport.affectedPages` for a rolled-up axe rule, and `BugReport.seenInFlows` (`{ flowId, name }`) when more than one flow hit the same HTTP failure.
- `TestStep.label`, `StepResult.label`, and `TraceStep.label`.
- `SuggestionKind` `unattributed-error`. `SignupReason` `automation_error`. `OutcomeReason` `budget_exhausted`. `RunResult.signup_started` and `RunResult.pagesExplored`.
- `RunnerOptions.allowSensitive` (`signup`, `reset`, `otp`, `newsletter`, `payment`, `deletion`). An inbox already allows `signup`, `reset`, and `otp`.
- `scripts/bakeoff.ts --runs N`. Each row reports suggestions separately from real bugs, records `plannerFallback`, and prices tokens per step.

## [0.7.0-beta.3] — 2026-11-01

### Fixed

- A flow is no longer `passed` because its steps executed. Every kept flow has an `outcomeCheck`. The runner evaluates it after the last step. A missing check is `inconclusive` with `outcome_reason` `no_assertion`. A check that cannot be decided is `assertion_unverifiable`. Page checks, auth-negative checks, and sign-up validation already assert an observation; replay does the same, and a trace with no check is not a pass.
- The runner refuses to submit a completed sign-up or account-creation form (password plus confirm, create-account / sign-up / register, or a signup URL) unless the caller passed an `InboxProvider`. Without one, the engine runs validation only (empty, invalid email, password mismatch) and sets `signup_status` `not_tested` with `signup_reason` `no_inbox`. That refusal is a hard guard, not a prompt.

### Added

- `TestFlow.outcomeCheck` and `FlowResult.assertion`. `OutcomeReason` gains `no_assertion` and `assertion_unverifiable`.
- `InboxProvider` (`allocate` returns `{ address, expiresAt? }`, `waitFor` accepts `signal` and may return `text` / `html`, optional `release`). One sign-up per run, name "MonkeyTest QA", password only in memory, never phone or payment. `signup_attempted`, `signup_verified`, `signup_status`, and `signup_reason` are set from that attempt. Captcha, phone, payment, timeout, and `cap_reached` are not bugs.
- CLI `--inbox <module>` and `--inbox-http <url>` (`MONKEYTEST_INBOX_TOKEN`). `createHttpInbox` and `loadInboxProvider` are exported. There is no default host.

## [0.7.0-beta.2] — 2026-11-01

### Added

- Deterministic page checks in `src/checks/`, with no model call. One engine flow per check, reserved id `check-*`, kind `accessibility` or `visual`, and one step per crawled page. The five checks are console errors, same-site failed requests and broken links (about 20 link probes), axe-core WCAG A/AA, mobile overflow and tap targets at 375px, and title / description / lang / viewport / h1. They sit outside the LLM flow budget and are not dropped as phantom flows. Serious or critical axe violations are bugs. Missing `autocomplete` on a login field is minor. Title and viewport gaps are minor. Description, lang, and h1 count are info. Console noise from extensions, third parties, and `isOwnAutomationBug` is ignored. Steps record `tool: 'check'`. Replay re-runs a `check` step, or skips it when the check id is missing.
- `BASIC_PRESET` from `depth.ts`: 6 pages, 5 LLM flows, engine caps of 5 checks and 6 auth-negative flows, 10s step timeout, 25s flow timeout, 12s page timeout, and a 120s total budget. Past that budget, remaining page checks are skipped instead of failing the run as a timeout. `--depth basic` uses these numbers.
- The planner asks for a success check and an error or edge check on each form journey. When the plan is thinner than 5 flows and the cap allows it, it asks once more, still only against crawled pages and controls. Quick pass may use a non-submit auth control such as Sign up or Forgot password. Engine flows win when an LLM flow repeats them.
- `--planner-model <id>` and `MonkeyConfig.plannerModel`. Per-page summaries stay on the cheap model (`gpt-4o-mini` for OpenAI). The runner model is unchanged.
- `scripts/bakeoff.ts` compares planner models. Each run writes JSON (case count, real bugs, invented flows, false-positive candidates, planner latency, wall time, tokens, and USD) and the process prints a table. Prices live in `MODEL_PRICES`.

### Changed

- Quick pass plans 5 LLM flows instead of 4. `severityIfFails` is copied onto the flow result so triage uses it. A step may set `severity` when a check finding is minor.

## [0.7.0-beta.1] — 2026-10-31

### Added

- Auth-negative checks for a crawled password field. Reserved flow ids `auth-neg-*`, kind `edge_case`. They do not use the planner flow budget and they are not removed when a model flow names a control the page does not have. The cases are empty submit, invalid email, one wrong-password attempt per run (`monkeytest+<rand>@example.invalid`), password visibility (a missing toggle is info, not a bug), a forgot-password link, and a sign-up link. Sign-up and reset forms are not submitted. Captcha, phone, and payment fields are not handled. The runner fills the scripted values and uses at most one model fallback step per flow.
- Login-only runs set `outcome_reason` to `login_required` when `public_screens` is `0` and at least one page was crawled, including when `outcome` is `clean` or `bugs_found`. `outcome_detail` says deeper journeys need an account. `public_screens` is the number of crawled pages that are not auth-gated.
- `ENGINE_VERSION` on the package entry, read from `package.json`. `RunResult.engine_version` is that string (for example `0.7.0-beta.1`).
- Reserved, unset signup fields for a later inbox provider: `signup_attempted?`, `signup_verified?`, `signup_status?` (`verified` | `unverified` | `not_tested` | `blocked`), `signup_reason?` (`no_inbox` | `captcha` | `phone` | `payment` | `timeout` | `cap_reached` | `no_signup_form`).

### Fixed

- The crawl follows links on an auth-gated page. Auth URLs have a separate budget of 3, so `/?mode=signup` and `/forgot-password` are visited. Auth is detected from a password field or a path/query token (`login`, `signin`, `signup`, `register`, `forgot`, `reset`, `otp`, `auth`, including `?mode=` and hyphen or underscore forms). The model flag is only a secondary signal.
- The crawl seeds the site root, the start URL without its query string, and same-origin URLs from `sitemap.xml` and `robots.txt` when those files exist, within the page cap. `[role=link]` and same-origin `[data-href]` are followed.
- Flows that click the same control on the same page collapse to one. Clicks that leave the site, including "Continue with Google", are dropped. The planner is told to use only crawled pages and controls.
- A login-only site no longer ends `inconclusive` just because the only model journey was `auth_required`. The auth checks above decide `clean` or `bugs_found`.

### Changed

- npm prerelease tags `v*.*.*-beta.*` publish under the dist-tag `next`. Stable tags stay on `latest`.

## [0.6.1] — 2026-10-31

### Fixed

- An unlabeled `<input type="number">` (the inputs example: a heading, the text "Number", and no `<label>`, name, or placeholder) no longer waits out `locator.fill`. Targets such as `label:Number Input` and a bare `number` fall through role, label, placeholder, name, id, `input[type=number]`, the nearest preceding text or heading, and a snapshot ref. The runner acts only when exactly one visible, enabled element matches. Anything else fails immediately with the reason, instead of a 15s timeout.
- Number and tel fields still receive digits. If `fill` rejects that write, the runner clicks the control and types the same digits.
- The planner drops or repairs flows whose controls are not in the crawled DOM. A checkbox or text-input flow is not produced for a page that only has a number input, and a dropped flow is not an inconclusive test. The plan notes name each dropped flow.

### Added

- Optional bug fields for the report page. Nothing already on `BugReport` was renamed or removed. `flow_id` is `FlowResult.flowId` (the same id as `trace.flowId`). `step_index` is the 0-based index of the failing step; `StepResult.index` stays 1-based. None of these fields are inputs to `fingerprint` or `fingerprintV2`.
  - `impact?: string` — one line of user impact. The polish model supplies it when it returns one. Otherwise a short line is built from the failure kind and the element.
  - `page_url?: string` — URL where the step failed.
  - `step_index?: number` — 0-based index of the failing step in the flow.
  - `flow_id?: string` — journey id, the existing `FlowResult.flowId`.
  - `element?: { selector?: string; bounding_box?: { x: number; y: number; width: number; height: number } }` — ring for the screenshot. `boundingBox()` runs on the locator the runner already resolved, with a 250ms timeout. A miss omits the field and does not fail the step.
- `SiteMapPage.inputs` records fillable controls that are not inside a `<form>`, including preceding text, heading, id, and a snapshot ref. Existing sitemap readers can ignore it.

## [0.6.0] — 2026-10-30

### Added

- Run outcome fields on `RunResult`, set by `triage()`: `outcome` (`bugs_found` | `clean` | `inconclusive` | `could_not_test`), `outcome_reason` (machine code), and `outcome_detail` (a sentence plus a next step). The names match the SaaS `audit_run` columns. `could_not_test` means nothing was tested (no pages, no flows, or the site was unreachable). `login_required` is used only when a login wall was actually seen.
- Per-flow `outcome_reason` and `outcome_detail`. Flow status `inconclusive` means every planned step was skipped, or the only failures were the runner's. `stats.flowsInconclusive` counts those flows. Existing statuses keep their meaning.
- `AUTOMATION_FAULT_SIGNATURES`, `isAutomationFault`, `isOwnAutomationBug`, and `matchesClientSoftExploratory`. These are the Playwright and exploratory misses that must not become confirmed bugs. The list is a superset of mtaiclient `confirmedBugs.js`. A host can import it instead of copying the signatures.
- `alignVerdict` / `verdictContradicts`. An optional `planner.verdict` LLM sentence is kept only when it agrees with the filtered bug count. "Worked smoothly" beside a bug, or "major bug" with zero bugs, is replaced by the deterministic `outcome_detail`. When the cause is the runner, the sentence says "Our test couldn't complete".
- Quick pass depth preset. Id `basic`, label "Quick pass": 6 pages, 4 flows, planner focus `forms-search-cta`. CLI `--depth basic` (alias `--depth quick-pass`). `resolveDepthPreset` and `DEPTH_PRESETS` are the same table (`standard`, `deep`, `shallow` included). An explicit `--max` or `--flows` still wins.
- `valueForInput` / `numericText`. Number and tel fields get digits. `555-0100` typed at a number input becomes `5550100`.

### Fixed

- The runner no longer types `555-0100` into `input[type=number]`. Playwright's "Cannot type text into input" error is classified inconclusive, not a High bug.
- Playwright and selector failures (not an `<input>`, InvalidSelector, strict mode, detached nodes, element not found, selector timeouts, and the mtaiclient soft-timeout and page-title rules) are inconclusive. HTTP 5xx, uncaught page errors, disabled controls, and document HTTP 404 are still bugs. Fingerprints for those real bugs are unchanged.
- A flow whose every step was skipped is `inconclusive`, not `passed`.

### Changed

- `new Monkey()` asks the planner model for a one-line verdict and then runs `alignVerdict`. A model failure leaves the deterministic sentence in place. `triage()` itself stays synchronous and does not call a model.

## Notes recorded before 0.6.0

The notes below were already in the tree before 0.6.0 and describe behaviour shipped in 0.5.x.

### Changed

- README and the docs installed from npm as `npm install @monkeytestai/monkeytest-core` (published 0.4.0). A clone remained the contributor path, including the no-key smoke script. 0.5.0 renames that package to `@monkeytestai/monkeytester`.
- The 0.4.0 package name was `@monkeytestai/monkeytest-core` (it was `@mtai/monkeytest-core`; that npm scope is taken). Imports, install docs, CI, and the Docker image used that name. Runtime behavior and the AGPL-3.0 license were unchanged. 0.5.0 replaces it.
- **SaaS migration.** `new Monkey()` now defaults `strictOracles` and `failOn5xx` to **on**. A page error, a document HTTP 404, a disabled control a step tries to use, and a same-origin HTTP ≥500 (document, xhr, or fetch) become a failed step and a blocking bug. Bug counts and `flowsFailed` will rise. To keep the previous counts, pass `strictOracles: false` and `failOn5xx: false` on the constructor, or the same fields on one `run` / `replay` / `verify` call. `www` and the apex host still match. Other ports, third-party hosts, and image/font responses stay evidence only.
- `runPlan`, `replayTraces`, `verifyBugs`, and `triage(run)` still leave those switches off unless the caller passes them, so triaging a run you already built does not rewrite it. `Monkey` passes the constructor values (now on) into the run and into `triage`. `RunResult` fields are unchanged.
- The planner keeps grounded flows, within `maxFlows`, for a crawled public form, one enabled non-submit button, one same-origin link whose target was not crawled, and one disabled non-submit button. Labels and URLs come from the crawl (`SiteMapPage.controls`, optional). Leftover model flows are the ones replaced when the budget is full.
- The runner performs `Click "Save order"` and `Fill the "email" field` itself when that label is on the page. Other steps still go to the runner model.
- `monkeytest run` exits **3** when the explorer visits zero pages, instead of exiting 0 with an empty report.
- The live e2e script starts the CLI as an asynchronous child. `spawnSync` froze the in-process demo server, the homepage timed out, and the buggy fixture exited 0.

### Added

- Multi-stage `Dockerfile` (Node 22, `bookworm-slim`) and [DOCKER.md](./DOCKER.md). `npm ci` and `npm run build` produced `/opt/monkeytest-core` (`dist/`, `package.json`, license files, production dependencies) for a `file:` install or `COPY --from`. 0.5.0 moves that tree to `/opt/monkeytester`. Playwright browsers are not downloaded. Engine audit behavior is unchanged.
- `--fail-on-5xx` (CLI default on, `--no-fail-on-5xx` opts out) fails a passed or skipped step that observed a same-origin HTTP ≥500 on a document, xhr, or fetch, and the triager files it as a critical bug. `new Monkey()` now defaults this **on** as well. Pass `failOn5xx: false` to opt out. `www` and the apex host match. Other ports, third-party hosts, and image/font responses stay evidence only.
- The crawler reserves a few `maxPages` slots for help, contact, support, about, and other form-style links it actually saw, and keeps those links even when they sit past the ordinary link cap. `SiteMapPage.forms` records scraped forms (optional; existing readers can ignore it).
- When the crawl contains a public form and `maxFlows` is at least 1, the planner keeps a form-submit flow grounded in that page's URL, fields, and submit label. A header search box does not take that slot. The model is asked for the same flow; the deterministic pass is the floor.
- Action traces on each flow and on each bug (locator, value, URL, timing, evidence).
- `fingerprintV2` and `fingerprintParts` (version 2) from failure category, URL template, element role + name, and a normalised error signal. `fingerprint` stays the legacy v1 hash so stored bugs still match. Diff and verify use v2 only when both sides have it.
- `monkeytest rerun` replays the stored trace with no LLM calls. `--heal` re-resolves a step whose locator missed and marks that step `healed`.
- `monkeytest verify` replays each bug trace and reports `fixed`, `still_broken`, `flaky`, `healed`, or `blocked`. Exit `1` when any bug is `still_broken` or `flaky`.
- Vitest coverage for fingerprints, trace serialisation, verdicts, and `diffRuns`, plus an integration test. CI runs `npm test`.
- Strict oracles fail a step when the page throws, a document returns HTTP 404, an action returns HTTP 5xx, or the clicked control is disabled. They default **on** for `new Monkey()` and for the CLI. Pass `strictOracles: false` to opt out. Replay uses the same switch. `runPlan` still defaults it off unless the caller passes it.
- Reusable buggy/fixed demo app under `test/fixtures/demo-app`. `npm test` covers it with a stub LLM. `.github/workflows/e2e-live.yml` runs the same app with a real model (manual, nightly, and pushes to `main`).

### Fixed

- The release workflow grants `contents: write` so it can open the GitHub release after npm publish. Provenance still uses `id-token: write`. The release install command uses the package version with the leading `v` removed.
- A valid planner response can no longer drop a public form the crawl already saw. The form-submit flow is a reserved slot: shopping-only plans, and plans whose only submit is a vague "submit" on that page, still include the grounded flow and its action URL (for example `/api/contact`). Fault-surface flows cannot take that slot. Help, contact, and about reads are dropped only after shop flows. `SiteMapForm.inputs` optionally records label, name, placeholder, and type; `fields` is unchanged. Fill steps use that label, then a `name` CSS selector, instead of an invented placeholder such as `placeholder:Email`.
- Replay and verify keep going when a step the original run already marked `skipped` has a locator that still misses. A soft skip (for example a placeholder fill that never matched) no longer becomes `locator_mismatch` and hides a later bug, such as a form POST that returned HTTP 500. A step that originally passed or failed still stops the flow. Fingerprints are unchanged.
- A planner model response that is invalid JSON, fails schema validation, or includes a flow with empty `steps` no longer wipes the plan. Usable model flows are kept. The public-form submit flow and scraped fault-control flows are still added, up to `maxFlows`. `plan()` records the model error on `TestPlan.notes` and emits `engine.error`. `executeAndTriage` runs that plan. An empty plan remains only when the crawl has no public form and no fault control. `RunResult` fields are unchanged. `groundedTestPlan(siteMap, maxFlows)` is the same crawl-only floor, for a host that catches a planner failure itself.
- The per-flow timeout no longer leaves its timer running after the flow finishes, and it closes the browser context when the budget is exceeded.

## [0.5.1] — 2026-10-26

### Fixed

- A model site summary that does not match the schema no longer aborts exploration. `authSurfaces` and `publicJourneys` accept a string or an object with `url` / `label` / `name` / `path` and are stored as `string[]`. The same coercion covers the other structured-output calls (per-page summary, planner salvage, bug polish, runner tool choice): string booleans, one object where an array was asked for, enum case and a few tool aliases, over-long polish fields clipped to the limit, and a single planner flow or step object. When the site summary still cannot be read, the crawl keeps the pages it already visited, fills a basic map from titles and URLs, and continues. `SiteMap.warnings` and the `explore.warning` event carry a short sentence safe to show in a report. The parser error stays in the server log and on `data.detail`. Per-page summary failures use the same warning instead of writing the schema error into the page summary.

## [0.5.0] — 2026-10

### Changed

- **Breaking:** the npm package is `@monkeytestai/monkeytester`. It was `@monkeytestai/monkeytest-core`. Update `npm install` and `import` paths. The CLI binary stays `monkeytest` (`npx monkeytest`). The license stays `AGPL-3.0-only`. `publishConfig.access` stays `public`.
- Repository URLs in this repo now use `https://github.com/monkeytestai/monkeytester` (previously `https://github.com/monkeytestai/monkeytest-core`). The GitHub repository rename follows this release. The homepage stays `https://docs.monkeytest.ai`.
- Docs and other in-repo wording for this package use **monkeytester**. The product name **monkeytest**, the `monkeytest` CLI, and the `.monkeytest/` directory are unchanged.
- The Docker install tree is `/opt/monkeytester` (was `/opt/monkeytest-core`). Example tags are `monkeytester:local` and `monkeytester:ci`. `npm pack` tarballs are named `monkeytestai-monkeytester-<version>.tgz`.
- `monkeytest version`, and the `engine` label on newly saved plans and runs, now report `monkeytester@0.5.0`. On-disk schema stays `1`.

## [0.4.1] — 2026-10

### Fixed

- The crawler compared outbound links with `URL.origin`, so a start URL of `http://shop.example/` that redirects to `https://www.shop.example/` never left the homepage: every rewritten link looked off-origin and the queue stopped. Crawl scope now treats the apex host and `www` as one site, and `http` and `https` as one site. Another subdomain, another host, or another explicit port is still skipped. A redirect that stays on the site is stored as the URL the browser landed on; the caller's `startUrl` is unchanged. The fault-surface link check uses the same site rule, so a homepage "Track order" or "Help" link rewritten onto `https://www` is still eligible when that path was not crawled. The public-form floor is unchanged and still requires the form page in the sitemap. `www` / scheme matching for HTTP 5xx oracles is unchanged.

## [0.4.0] — 2026-05

The bug-finding loop release. The CLI is now a real product surface with
`init`, `run`, `rerun`, `diff`, and `report` subcommands; the engine ships
the primitives those commands stand on (`Monkey.runFromPlan`, `diffRuns`,
plus `savePlan`/`loadPlan`/`saveRun`/`loadRun`).

### Added

- `Monkey.runFromPlan(plan, opts)` — re-execute a stored `TestPlan`
  without re-crawling or re-planning. The deterministic, cheap path for
  verifying that a fix actually landed.
- `diffRuns(prev, current)` — set diff over `BugReport.fingerprint`s plus
  a severity-rank check. Returns `{ newBugs, fixedBugs, persistingBugs,
  regressedBugs, stats }`. `summariseDiff()` for one-line CLI output.
- Persistence module: `savePlan` / `loadPlan` / `saveRun` / `loadRun` /
  `listRuns` with versioned `schema` field. Stable on-disk layout under
  `.monkeytest/{plan.json, runs/<id>.json, shots/}`.
- New CLI subcommands:
  - `monkeytest init` — scaffold `.monkeytest/`.
  - `monkeytest run <url>` — full pipeline + persisted plan + run.
  - `monkeytest rerun [<runId>]` — re-execute the same stored plan.
  - `monkeytest diff <runA> <runB>` — bug-fingerprint diff with shortcuts
    `latest`/`prev`. Exits `1` on new bugs or severity escalations.
  - `monkeytest report [<runId>]` — pretty-print a stored run.
- Consistent CLI exit codes (`0` ok, `1` bugs/regressions, `2` bad args,
  `3` engine error) so CI can gate on results.

### Changed

- CLI rewritten as a subcommand router with per-command help; old
  single-command entrypoint deprecated but `explore` still works.
- Plan / run JSON gain a `schema: 1` field for forwards-compatibility.

### Docs

- New guide: **The bug-finding loop** — explains the find-fix-rerun-diff
  cycle and the SaaS variant.
- New reference page: **CLI** with every subcommand, flag, env var, exit
  code, and the on-disk layout.
- Homepage and README updated to lead with the loop story.

## [0.3.0] — 2026-05

First public npm release.

### Added

- **Anthropic Claude** provider (`provider: 'anthropic'`) with full
  `messages.create` integration and prompted JSON mode.
- **Mistral** provider (`provider: 'mistral'`) using native
  `responseFormat: { type: 'json_object' }`.
- **Groq** provider (`provider: 'groq'`) routing through Groq's
  OpenAI-compatible endpoint for low-latency runner calls.
- **OpenAI-compatible** provider (`provider: 'openai_compatible'`) with
  `baseURL` for Ollama, vLLM, LM Studio, OpenRouter, Together, and any
  other server speaking the OpenAI Chat Completions wire format. JSON mode
  is auto-disabled for `localhost`/`127.0.0.1` endpoints.
- **Per-phase LLM tiers.** `MonkeyLLMConfig` now exposes a dedicated
  `runner?: LLMConfig` slot so the hot-path per-step calls can use a cheap,
  fast model while the planner uses a smarter one.
- **Optional triager polish pass.** Set `MonkeyConfig.llm.triager` to have
  the engine rewrite each bug's `title`, `observed`, `expected`, and
  `triageNotes` from the structured evidence the deterministic triager
  already collected. Per-bug try/catch — a bad LLM response on one bug
  never affects the others, and the deterministic copy is always preserved
  on failure.
- **Prompt caching** for OpenAI (auto, prompt-prefix) and Anthropic
  (`cache_control: { type: 'ephemeral' }` breakpoints on the system block
  and the long stable user block). The planner prompt is restructured into
  `system` + `cacheable` (site map) + `prompt` (per-call constraints) so
  repeat runs against the same site reuse the cached prefix.
- **`LLM.lastUsage`** — token + cache stats from each call
  (`inputTokens`, `cachedInputTokens`, `outputTokens`, `cacheWrite`).
  Surfaced through the `plan.complete` / `triage.complete` events so SaaS
  dashboards can render "saved $X via prompt cache".
- **`autoLLMConfig({ quality })`** ergonomic helper — auto-detects a
  provider from env vars and applies `cheap` / `balanced` / `smart`
  presets. Lets users start in two lines.
- **`detectProviderFromEnv`**, **`CHEAP_FAST_MODEL`**, **`SMART_MODEL`**
  exports for advanced consumers.

### Changed

- Planner prompt restructured for cache friendliness; identical behaviour
  for callers using `Monkey` directly.
- Default Gemini model remains `gemini-flash-lite-latest`. Default OpenAI
  model remains `gpt-4o-mini`. Anthropic defaults to `claude-haiku-4-5`,
  Mistral to `mistral-small-latest`, Groq to `llama-3.3-70b-versatile`.
- `triage()` is unchanged and remains zero-LLM-cost. The new
  `triagePolished()` is a separate async export for callers that want to
  drive the polish pass directly.

### Documentation

- New comprehensive docs site at **docs.monkeytest.ai** with sections:
  Architecture, LLM providers, Cost & depth, Prompt caching, Triager
  polish, Recipes, Use in CI, Troubleshooting.
- Hero image and value-led README.

## [0.2.0] — 2026

### Added

- Explorer, planner, runner, triager pipeline
- Playwright execution with per-step screenshots and optional flow video
- `EventBus` for live activity streams
- OpenAI and Gemini LLM backends

[0.7.0-beta.1]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.7.0-beta.1
[0.6.1]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.6.1
[0.6.0]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.6.0
[0.5.1]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.5.1
[0.5.0]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.5.0
[0.4.1]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.4.1
[0.4.0]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.4.0
[0.3.0]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.3.0
[0.2.0]: https://github.com/monkeytestai/monkeytester/releases/tag/v0.2.0
