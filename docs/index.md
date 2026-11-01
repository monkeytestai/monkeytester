---
layout: home
title: monkeytester
titleTemplate: false

hero:
  name: Bugs your tests didn't think to look for.
  text: Point it at a URL. It finds the bugs, then proves you fixed them.
  tagline: Open source, AGPL-3.0. Playwright and your LLM. Node.js 20+.
  image:
    src: /hero.svg
    alt: Diagram of a page being explored. Not a screenshot of a run.
  actions:
    - theme: brand
      text: Quick start
      link: /getting-started/quick-start
    - theme: alt
      text: How is this different?
      link: /guides/how-is-this-different

features:
  - title: It picks the cases
    details: You pass a URL. The crawl, the planner, and the built-in page checks decide what to try. You do not write the script.
  - title: A pass is a checked outcome
    details: A flow is passed only when its outcome check verifies. Otherwise the result is inconclusive, with reason no_assertion or assertion_unverifiable.
  - title: The same plan, again
    details: monkeytest rerun replays the stored trace. monkeytest diff compares bug fingerprints and exits 1 when something new or more severe shows up.
  - title: Quick pass
    details: "--depth basic is 6 pages, 5 LLM flows, page checks outside that budget, and a 120 second cap. About 10 cases, usually 1–2 minutes."
  - title: Your model
    details: OpenAI (default gpt-4o-mini), Gemini, Anthropic, Mistral, Groq, or any OpenAI-compatible endpoint. One model per phase if you want.
  - title: Page checks, no model
    details: Console errors, failed requests and broken links, axe-core WCAG A/AA, mobile layout at 375px, and title, description, lang, viewport, and h1.
---

## Thirty seconds

Install the package, install Chromium, run Quick pass, then print the report. `latest` on npm is 0.6.1. These pages match `main`. Install `@next` for that build.

::: code-group

```bash [npm]
npm install @monkeytestai/monkeytester
npx playwright install chromium
export OPENAI_API_KEY="sk-..."
npx monkeytest run https://example.com --depth basic
npx monkeytest report
```

```bash [pnpm]
pnpm add @monkeytestai/monkeytester
pnpm exec playwright install chromium
export OPENAI_API_KEY="sk-..."
pnpm exec monkeytest run https://example.com --depth basic
pnpm exec monkeytest report
```

```bash [yarn]
yarn add @monkeytestai/monkeytester
yarn playwright install chromium
export OPENAI_API_KEY="sk-..."
yarn monkeytest run https://example.com --depth basic
yarn monkeytest report
```

```bash [bun]
bun add @monkeytestai/monkeytester
bunx playwright install chromium
export OPENAI_API_KEY="sk-..."
bunx monkeytest run https://example.com --depth basic
bunx monkeytest report
```

:::

The full path, including a no-key `npx` of `--help`, is the [quick start](/getting-started/quick-start). Hosted runs of the same engine are at [monkeytest.ai](https://monkeytest.ai).
