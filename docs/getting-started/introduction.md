# Introduction

```bash
npx monkeytest run https://example.com --depth basic
```

You give it a URL. It opens Chromium with Playwright, decides what a person might try, runs those cases, and writes a report. A flow counts as `passed` only when an outcome check verifies. After you fix something, `monkeytest rerun` replays the same trace and `monkeytest diff` tells you what changed.

The package is [`@monkeytestai/monkeytester`](https://www.npmjs.com/package/@monkeytestai/monkeytester). The binary is `monkeytest`. It needs Node.js 20 or newer. The license is AGPL-3.0-only.

npm dist-tag `latest` is the stable channel. npm dist-tag `next` is the pre-release channel. These pages describe this repository. The engine version is `package.json`, not the hosted product. Channels, the 8 Nov 2026 registry observation, and the hosted 0.7.0 service are separated in [Versions](/getting-started/versions).

## What a run is

Four phases, then a file you can keep:

1. **Explore.** Crawl up to a page cap. Same-site links only (`www` and the apex match, and so do `http` and `https`).
2. **Plan.** An LLM proposes flows from what the crawl actually saw. Page checks and auth-negative checks are added by the engine and do not spend that flow budget.
3. **Run.** Playwright performs the steps. Screenshots land in `.monkeytest/shots/`.
4. **Triage.** Confirmed site bugs are fingerprinted. Playwright's own misses stay inconclusive.

`RunResult.outcome` is `bugs_found`, `clean`, `inconclusive`, or `could_not_test`.

## What it is not

It does not replace a script you already trust for a checkout or a login. [Playwright Test](https://playwright.dev/docs/intro) is the framework for those tests, and Playwright Test Agents plan, generate, and heal them. monkeytester looks for cases the script did not name, then stores a plan you can rerun. It is not a hosted REST API and it does not ship an MCP server. See [How is this different?](/guides/how-is-this-different).

It is not a load tester. axe-core runs as one page check (WCAG A/AA). That check is not a full accessibility audit.

Next: [Quick start](/getting-started/quick-start).
