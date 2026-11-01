# Introduction

```bash
npx monkeytest run https://example.com --depth basic
```

You give it a URL. It opens Chromium with Playwright, decides what a person might try, runs those cases, and writes a report. A flow counts as `passed` only when an outcome check verifies. After you fix something, `monkeytest rerun` replays the same trace and `monkeytest diff` tells you what changed.

The package is [`@monkeytestai/monkeytester`](https://www.npmjs.com/package/@monkeytestai/monkeytester). The binary is `monkeytest`. It needs Node.js 20 or newer. The license is AGPL-3.0-only.

npm `latest` is **0.6.1**. Pre-release builds publish on the **`next`** tag. These pages describe `main` (currently `0.7.0-beta.3` in this repository).

## What a run is

Four phases, then a file you can keep:

1. **Explore.** Crawl up to a page cap. Same-site links only (`www` and the apex match, and so do `http` and `https`).
2. **Plan.** An LLM proposes flows from what the crawl actually saw. Page checks and auth-negative checks are added by the engine and do not spend that flow budget.
3. **Run.** Playwright performs the steps. Screenshots land in `.monkeytest/shots/`.
4. **Triage.** Confirmed site bugs are fingerprinted. Playwright's own misses stay inconclusive.

`RunResult.outcome` is `bugs_found`, `clean`, `inconclusive`, or `could_not_test`.

## What it is not

It does not replace a script you already trust for a checkout or a login. [Playwright](https://playwright.dev/docs/intro) is the framework for those tests. monkeytester looks for the cases the script did not name. See [How is this different?](/guides/how-is-this-different).

It is not a load tester. axe-core runs as one page check (WCAG A/AA). That check is not a full accessibility audit.

Next: [Quick start](/getting-started/quick-start).
