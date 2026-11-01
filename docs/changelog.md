# Changelog

The full history is [CHANGELOG.md](https://github.com/monkeytestai/monkeytester/blob/main/CHANGELOG.md) in the repository. This page is the recent entries. npm `latest` is 0.6.1. Newer entries below are the pre-release on `main`, published under the npm `next` tag.

## 0.7.1

- Replay of a stored plan uses the same sign-in redirect, sign-in check, sign-up check, and sensitive-submit rules as a live run. A locator that no longer matches is inconclusive (`automation_error`), not a site bug.
- The `auth-redirect` note is listed once on the flow.

## 0.7.0-beta.5

- Analytics beacons (`sendBeacon`, keepalive, clarity, Google Analytics, `/cdn-cgi/rum`, and the other listed collectors) are not sensitive submits. A homepage visit is not inconclusive because a beacon body said "payment" or "reset". Real reset, OTP, newsletter, payment, and account-deletion submits stay blocked unless allowed.
- A page visit that follows a same-origin redirect to sign-in or sign-up passes. The note is an info suggestion. The landing page counts as a public screen. Cross-origin redirects, error pages, loops, and 4xx/5xx still fail.

## 0.7.0-beta.4

- `suggestions` are a separate list (autocomplete, viewport, description, overflow without a viewport, third-party and unattributed page errors). They are not bugs and they are not part of the verdict.
- `warnings` carries model errors. `plan.plannerFallback` is set only when the grounded plan replaced a failed model call.
- Models that reject `temperature` (`gpt-5*`, o-series) omit it. `estimateCostUsd` prices each step at its own model.
- Page checks run before sign-up, each with a real `durationMs`. A skipped check is `budget_exhausted`, not a 0ms failure.
- Sign-up with an inbox is one flow. Password reset, OTP, newsletter, checkout, and account deletion are validation-only unless an inbox (reset and OTP) or `allowSensitive` allows the submit. OAuth clicks and `/auth/<provider>` navigations are inconclusive.
- Sign-in and sign-up URLs are public screens. The same rendered screen is stored once.
- A missing invented success sentence does not fail a flow. An empty field after fill is an automation error.
- A wrong password that the site rejects with an auth HTTP 4xx, or with wording such as "correct login details", is not a bug. Page-check durations are the measured time, including 0.

## 0.7.0-beta.3

- A flow is `passed` only when its outcome check verifies. No check is `inconclusive` with `no_assertion`. A check that cannot be decided is `assertion_unverifiable`.
- The runner does not submit a completed sign-up unless you passed an `InboxProvider`. Without one, `signup_status` is `not_tested` and `signup_reason` is `no_inbox`.
- CLI `--inbox <module>` and `--inbox-http <url>`. No default host. `createHttpInbox` and `loadInboxProvider` are exported.

## 0.7.0-beta.2

- Deterministic page checks, ids `check-*`, outside the LLM flow budget: console, HTTP and broken links, axe-core WCAG A/AA, mobile at 375px, and title / description / lang / viewport / h1.
- `BASIC_PRESET`: 6 pages, 5 LLM flows, caps of 5 checks and 6 auth-negative flows, and a 120 second budget. Past the budget, remaining page checks are skipped.
- `--planner-model` sets the planner only. Page summaries stay on the cheap model.

## 0.7.0-beta.1

- Auth-negative checks for a crawled password field (`auth-neg-*`): empty submit, invalid email, one wrong password, password visibility, forgot-password link, sign-up link. Sign-up and reset forms are not submitted.
- Login-only runs set `outcome_reason` to `login_required` when `public_screens` is `0`, including when `outcome` is `clean` or `bugs_found`.
- `ENGINE_VERSION` is copied onto `RunResult.engine_version`.
- Pre-release tags `v*.*.*-beta.*` publish to npm dist-tag `next`. Stable tags stay on `latest`.

## 0.6.1

- An unlabeled number input no longer waits out `locator.fill`.
- Optional bug fields: `impact`, `page_url`, `step_index`, `flow_id`, `element`. None of them change the fingerprint.
- `SiteMapPage.inputs` records fillable controls that are not inside a form.

## 0.6.0

- `outcome`, `outcome_reason`, and `outcome_detail` on `RunResult`.
- Playwright and selector failures are inconclusive, not confirmed bugs.
- Quick pass added as `--depth basic` (at this version: 6 pages and 4 flows). 0.7.0-beta.2 raises the LLM flow cap to 5 and adds page checks.

Older notes, including the 0.4.0 loop (`init`, `run`, `rerun`, `diff`, `report`) and the 0.5.0 rename to `@monkeytestai/monkeytester`, are in the repository changelog.
