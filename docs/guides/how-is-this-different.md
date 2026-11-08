# How is this different?

```bash
npx monkeytest run https://example.com --depth basic
npx monkeytest rerun
npx monkeytest diff prev latest
```

You pass a URL. monkeytester chooses the cases, records an honest outcome, and can run that same plan again.

## Three neighbours

| | What it is | Who supplies the goal | What you keep |
| --- | --- | --- | --- |
| **monkeytester** | Open-source CLI and library | A URL. The crawl and the page checks propose cases | Evidence, a stored plan, `rerun`, fingerprint `diff` |
| **[Playwright Test](https://playwright.dev/docs/intro)** | End-to-end tests you own | You, or [Playwright Test Agents](https://playwright.dev/docs/test-agents), which plan, generate, and heal Playwright tests | Test files and their report |
| **[browser-use](https://github.com/browser-use/browser-use)** | Browser-agent infrastructure | A task you give the agent. It can inspect the page while carrying the task out. That is discovery, aimed at the task | The task result |
| **Recorders and other scripted QA tools** | A session or a script | You, by recording or writing steps | A replay of those steps |

Playwright's introduction describes Playwright Test as an end-to-end test framework. The default scaffold includes a test file you edit and run with `npx playwright test`. Playwright Test Agents also plan, generate, and heal those tests. That is the right tool when you want Playwright tests you can read and keep. It is not "no planning".

browser-use is open-source infrastructure for a browser agent. You give it a task. While it does that task it can look at the page. Calling that "no discovery" would be wrong. monkeytester's job is different: file evidence-backed bugs for a URL, then replay the same plan and diff fingerprints.

Recorders and scripted tools store a session you performed, or a script you authored, and play those steps back.

Nothing here is a score. There is no benchmark on this page. The false-positive gate has not been measured. See [Quality methodology](/guides/quality).

## What monkeytester does with that freedom

It still refuses to invent the page. Flows have to use URLs and controls the crawl saw. On top of the LLM journeys, Quick pass adds deterministic page checks (console, HTTP and broken links, axe-core WCAG A/AA, mobile at 375px, metadata) and, when a password field was crawled, auth-negative cases. Those do not spend the LLM flow budget.

A flow is not `passed` because its steps executed. The runner evaluates `outcomeCheck` after the last step. A missing check is `inconclusive` with `outcome_reason` `no_assertion`. A check that cannot be decided is `assertion_unverifiable`.

`monkeytest rerun` replays the stored trace and does not call the LLM, unless you pass `--heal` or the run has no trace. `monkeytest diff prev latest` compares fingerprints. The process exits 1 when a bug is new or more severe, which is what a CI job needs.

Use a scripted suite for the paths you can name. Use this when you want something to look where those scripts did not, and then to show whether a fix held.
