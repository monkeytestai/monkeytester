# Report

```bash
npx monkeytest report --json
```

The file under `.monkeytest/runs/` is a stored run: `{ schema, id, createdAt, engine, planRef?, run }`. `schema` is `1`. `run` is a `RunResult`.

## `RunResult`

| Field | Values |
| --- | --- |
| `outcome` | `bugs_found`, `clean`, `inconclusive`, `could_not_test` |
| `outcome_reason` | `login_required`, `blocked_by_bot_protection`, `site_unreachable`, `invalid_url`, `llm_error`, `all_flows_skipped`, `timeout`, `automation_error`, `not_attempted`, `nothing_tested`, `no_assertion`, `assertion_unverifiable` |
| `outcome_detail` | One or two sentences that match the bug count, plus a next step |
| `public_screens` | Crawled pages that are not auth-gated. Omitted when the run did not crawl. |
| `engine_version` | `ENGINE_VERSION`, for example the package version |
| `signup_attempted`, `signup_verified` | Booleans from the one sign-up attempt |
| `signup_status` | `verified`, `unverified`, `not_tested`, `blocked` |
| `signup_reason` | `no_inbox`, `captcha`, `phone`, `payment`, `timeout`, `cap_reached`, `no_signup_form` |
| `flows` | `FlowResult[]` |
| `bugs` | `BugReport[]`. Confirmed site bugs only. |
| `stats` | `flowsTotal`, `flowsPassed`, `flowsFailed`, `flowsBlocked`, `flowsInconclusive`, step counts, `bugsCritical`, `bugsMajor`, `bugsMinor` |

`could_not_test` means nothing was tested. `inconclusive` means the site was reached and a real check did not finish. `login_required` is also set when `outcome` is `clean` or `bugs_found` and `public_screens` is `0`.

When one confirmed bug is filed and the site is not login-only, `outcome_detail` is:

```text
Found 1 confirmed bug. Open the top one and confirm it on the site before treating this run as healthy.
```

## `FlowResult`

| Field | Meaning |
| --- | --- |
| `status` | `passed`, `failed`, `blocked`, `error`, `inconclusive` |
| `outcome_reason`, `outcome_detail` | Set when this flow did not produce a confirmed site bug |
| `assertion` | Outcome-check result. `verified` is required for `passed` on runs from 0.7.0-beta.3. |
| `steps` | Each step has `status`, `observation`, `screenshotPath`, console and network evidence |
| `trace` | What `rerun` replays. Absent on runs recorded before traces existed. |
| `videoPath` | WebM for the flow |
| `bugIds` | Bugs produced from this flow |
| `severityIfFails` | Copied from the plan so triage can rank a bug |

`passed` is not "the steps ran". `no_assertion` and `assertion_unverifiable` are never paired with `passed`.

## `BugReport`

| Field | Meaning |
| --- | --- |
| `title`, `severity`, `observed`, `expected` | `severity` is `critical`, `major`, or `minor` |
| `fingerprint` | Legacy id. Still written so older hosts keep matching. |
| `fingerprintV2`, `fingerprintParts` | Stable id from category, URL template, role, name, and error signal. Not an LLM tool name. |
| `reproSteps` | Steps to repeat |
| `evidence` | `screenshots`, `consoleErrors`, `networkFailures`, optional `domSnapshot` |
| `trace` | Actions from the start of the flow through the failing step |
| `impact` | One line. The polish model may supply it. Otherwise the engine writes a short line. Omitted before 0.6.1. |
| `page_url` | URL where the step failed. Omitted before 0.6.1. |
| `step_index` | 0-based index of the failing step. Omitted before 0.6.1. |
| `flow_id` | `FlowResult.flowId`. Omitted before 0.6.1. |
| `element` | Optional `selector` and `bounding_box` (`x`, `y`, `width`, `height`) for a ring on the screenshot. A miss omits the field. |

`fingerprint` and `fingerprintV2` do not include `impact`, `page_url`, `step_index`, `flow_id`, or `element`. The CLI treats every severity except `minor` as blocking.

How to read a run without the field table: [Reading the report](/getting-started/reading-the-report).
