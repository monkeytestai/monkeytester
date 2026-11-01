# How is this different?

```bash
npx monkeytest run https://example.com --depth basic
npx monkeytest rerun
npx monkeytest diff prev latest
```

You pass a URL. monkeytester chooses the cases, records an honest outcome, and can run that same plan again.

## Three neighbours

| | Who chooses the cases | What you get back |
| --- | --- | --- |
| **monkeytester** | The engine, from the crawl | A stored plan, a run whose `passed` means a verified outcome check, then `rerun` and `diff` |
| **[Playwright](https://playwright.dev/docs/intro)** | You do | A report for the tests you wrote |
| **[browser-use](https://github.com/browser-use/browser-use)** | You do | The result of the task you gave the agent |
| **Recorders and other scripted QA tools** | You do, by recording a session or writing steps | A replay of those steps |

Playwright's own introduction describes Playwright Test as an end-to-end test framework for modern web apps. The default project scaffold includes a test file you edit and run with `npx playwright test`. That is the right tool when you already know the path that must keep working.

browser-use's README describes an open-source browser agent. The Python quickstart constructs an agent with a `task` string you write, then runs it. You are assigning work. monkeytester is not that. It is pointed at a site and asked what is broken.

Recorders and scripted tools store a session you performed, or a script you authored, and play those steps back. The case list is yours.

Nothing here is a score. There is no benchmark on this page.

## What monkeytester does with that freedom

It still refuses to invent the page. Flows have to use URLs and controls the crawl saw. On top of the LLM journeys, Quick pass adds deterministic page checks (console, HTTP and broken links, axe-core WCAG A/AA, mobile at 375px, metadata) and, when a password field was crawled, auth-negative cases. Those do not spend the LLM flow budget.

A flow is not `passed` because its steps executed. The runner evaluates `outcomeCheck` after the last step. A missing check is `inconclusive` with `outcome_reason` `no_assertion`. A check that cannot be decided is `assertion_unverifiable`.

`monkeytest rerun` replays the stored trace and does not call the LLM, unless you pass `--heal` or the run has no trace. `monkeytest diff prev latest` compares fingerprints. The process exits 1 when a bug is new or more severe, which is what a CI job needs.

Use a scripted suite for the paths you can name. Use this when you want something to look where those scripts did not, and then to show whether a fix held.
