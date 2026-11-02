# Reading the report

```bash
npx monkeytest report
npx monkeytest report --json
```

`report` prints the latest file in `.monkeytest/runs/`. Pass a run id to print an older one.

## The outcome line

`outcome` is one of `bugs_found`, `clean`, `inconclusive`, `could_not_test`.

`could_not_test` means nothing was tested (no pages, no flows, or the site could not be opened). `inconclusive` means the site was reached and a real check did not finish. A Playwright error from the runner is inconclusive, not a bug in the site.

A flow is `passed` only when its outcome check verifies. These two reasons are never paired with `passed`:

| `outcome_reason` | Meaning |
| --- | --- |
| `no_assertion` | The journey had no outcome to verify. Steps running is not a pass. |
| `assertion_unverifiable` | A check was present and could not be decided. A missing invented success sentence is this, not a failed flow. |
| `budget_exhausted` | The run finished its time budget before this check. Not a failure to confirm the page. |
| `contact_submit_blocked` | A contact, enquiry, feedback, support, quote, or get-in-touch message was not sent. Not a pass and not a bug. |

When one confirmed bug is filed, `outcome_detail` is:

```text
Found 1 confirmed bug. Open the top one and confirm it on the site before treating this run as healthy.
```

That sentence is the engine's text. A clean run says the completed journeys had no confirmed bugs. When the cause is the runner, the sentence says "Our test couldn't complete".

`login_required` is set when a login wall was seen. It is also set on `clean` and `bugs_found` when `public_screens` is `0`: every crawled page was auth-gated, and deeper journeys need an account.

## Other fields worth reading first

| Field | What it tells you |
| --- | --- |
| `public_screens` | Crawled pages that are not auth-gated. `0` is a login-only site. Omitted when the run did not crawl. |
| `engine_version` | Package version that wrote the run (`ENGINE_VERSION`). |
| `stats` | Flow and bug counts. `bugsCritical`, `bugsMajor`, `bugsMinor`. |
| `bugs[]` | Confirmed site bugs. `minor` does not fail the CLI. |
| `signup_status` | Set when a sign-up form was seen. Without your inbox: `not_tested` / `no_inbox`. |
| `suggestions` | Separate from bugs. Missing autocomplete, viewport, or description, overflow on a page with no viewport, third-party page errors, and page errors with no script URL. Group by `pageUrl`. Not in the bug count or the verdict. |
| `warnings` | Model errors, and a line when `plan.plannerFallback` replaced a failed planner call. A login wall that returns no journeys does not set the flag. |

The field list is the [report reference](/reference/report). Blocking bugs are every severity except `minor`. That is also what makes `run` exit 1.

## Screenshots

| File | When |
| --- | --- |
| `.monkeytest/shots/page-*.png` | One viewport per crawled page |
| `.monkeytest/shots/flow-*-step-*-*.png` | One PNG per step |
| `.monkeytest/shots/flow-*.webm` | One video per flow |

`StepResult.screenshotPath` is an absolute path on the machine that ran the test. There is no `.monkeytest/screenshots/` directory.

Next: [Rerun and diff](/guides/rerun-and-diff).
