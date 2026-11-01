<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/public/banner-dark.svg" />
    <img alt="monkeytester. Bugs your tests didn't think to look for. Point it at a URL. It finds the bugs, then proves you fixed them." src="docs/public/banner-light.svg" width="1280" />
  </picture>
</p>

<h1 align="center">Bugs your tests didn't think to look for.</h1>

<p align="center">
  Point it at a URL. It finds the bugs, then proves you fixed them.<br />
  Open source. Playwright and your LLM. Node.js 20+.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@monkeytestai/monkeytester"><img src="https://img.shields.io/npm/v/@monkeytestai/monkeytester" alt="npm @monkeytestai/monkeytester" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js 20+" /></a>
  <a href="https://docs.monkeytest.ai"><img src="https://img.shields.io/badge/docs-docs.monkeytest.ai-7c3aed" alt="Documentation" /></a>
  <a href="https://github.com/monkeytestai/monkeytester/actions/workflows/ci.yml"><img src="https://github.com/monkeytestai/monkeytester/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="https://github.com/monkeytestai/monkeytester/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPL--3.0-64748b" alt="AGPL-3.0" /></a>
</p>

<p align="center">
  <a href="https://docs.monkeytest.ai/getting-started/quick-start">Quick start</a> ·
  <a href="https://docs.monkeytest.ai/guides/how-is-this-different">How is this different?</a> ·
  <a href="https://docs.monkeytest.ai/reference/cli">CLI</a> ·
  <a href="https://docs.monkeytest.ai/guides/llm-providers">LLM providers</a> ·
  <a href="https://monkeytest.ai">Cloud</a>
</p>

`@monkeytestai/monkeytester` is an AGPL-3.0 TypeScript engine. The CLI is `monkeytest`. npm `latest` is **0.6.1**. Pre-release builds, including the tree on `main`, publish under the **`next`** tag.

## Quick start

### 1. npx

```bash
npx --yes @monkeytestai/monkeytester@latest --help
```

That prints the commands. It does not need an API key or a browser.

### 2. Install

```bash
npm install @monkeytestai/monkeytester
npx playwright install chromium
```

pnpm, yarn, and bun install the same package (`pnpm add`, `yarn add`, `bun add`). Playwright downloads its own Chromium. These docs match `main`. For that build:

```bash
npm install @monkeytestai/monkeytester@next
```

### 3. First run

```bash
export OPENAI_API_KEY="sk-..."
npx monkeytest run https://example.com --depth basic
```

With an OpenAI key, the default model is `gpt-4o-mini`. If several keys are set, auto-detect uses the first of: `GEMINI_API_KEY` or `GOOGLE_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, then `OPENAI_COMPATIBLE_BASE_URL`.

`--depth basic` is Quick pass: 6 pages, 5 LLM flows, page checks outside that budget, and a 120 second cap. About 10 cases, usually 1–2 minutes. `--max` and `--flows` override the page and flow caps.

### 4. Read the report

```bash
npx monkeytest report
```

| Path | What it is |
| --- | --- |
| `.monkeytest/plan.json` | The plan. `rerun` replays its trace. |
| `.monkeytest/runs/<id>.json` | The run: flows, bugs, outcome. |
| `.monkeytest/shots/` | Page and step PNGs, and one WebM per flow. |

Exit `0` when no blocking bug remains (`minor` does not fail the process). Exit `1` when `run` or `rerun` found a blocking bug, when `diff` found a new or more severe bug, or when `verify` still sees a bug firing. Exit `2` is bad arguments or no provider. Exit `3` is an engine error, including a crawl that opened no pages.

## Demo

> **Not a recording.** A capture of a real `monkeytest run` is not in this repository yet. When it is added, it will be a real run (for example against [bananabeings.com](https://bananabeings.com)). The figure below is a diagram of the loop.

<p align="center">
  <img alt="Diagram: monkeytest run, you fix the site, monkeytest rerun replays the same trace, monkeytest diff reports what changed. Not a captured session." src="docs/public/loop.svg" width="720" />
</p>

## What you get

Page checks run without a model call. The five are console errors, same-site failed requests and broken links, axe-core WCAG A/AA, mobile overflow and tap targets at 375px, and title / description / lang / viewport / h1. Serious or critical axe violations are bugs. A flow is `passed` only when its outcome check verifies. No check is `inconclusive` with reason `no_assertion`. A check that cannot be decided is `assertion_unverifiable`.

The contributor smoke script stubs the LLM and crawls `https://example.com`. It does not call a provider. From a clone, after `npm run build` and `npx playwright install chromium`:

```bash
node scripts/smoke.mjs
```

This is the output of `node scripts/smoke.mjs` on this repository after `npm run build`. The duration is from that run.

```text
  · visited https://example.com/ — Static placeholder page used as the canonical example domain.

[explore] done in 1.1 s
  pages: 1 failures: 0
  siteType: placeholder

[plan] flows: 6
  - [happy_path] Visit the example.com homepage (2 steps)
  - [visual] Console errors on load (1 steps)
  - [visual] Broken requests and links (1 steps)
  - [accessibility] WCAG A and AA (1 steps)
  - [visual] Mobile layout (1 steps)
  - [accessibility] Page metadata (1 steps)

OK — engine pipeline is wired correctly.
```

When one confirmed bug is filed, the engine's `outcome_detail` is this sentence (asserted by the outcome tests, not a sample report):

```text
Found 1 confirmed bug. Open the top one and confirm it on the site before treating this run as healthy.
```

On a login-only crawl (`public_screens` is `0`) the same case says deeper journeys need an account, and `outcome_reason` is `login_required`.

## How is this different?

| | Who chooses the cases | What comes back |
| --- | --- | --- |
| **monkeytester** | The engine, from the pages it crawled | A stored plan, an honest outcome, then `rerun` and `diff` |
| **[Playwright](https://playwright.dev/docs/intro)** | You do. Playwright Test is an end-to-end framework for the tests you write. | A report for those scripts |
| **[browser-use](https://github.com/browser-use/browser-use)** | You do. Its README describes an open-source browser agent that carries out a task you give it. | The result of that task |
| **Recorders and other scripted QA tools** | You do, by recording a session or writing the steps | A replay of those steps |

monkeytester decides what to try. A pass requires a verified outcome check, otherwise the result is `inconclusive`. `monkeytest rerun` replays the stored trace, and `monkeytest diff` compares fingerprints. More on the [comparison page](https://docs.monkeytest.ai/guides/how-is-this-different).

## Find, fix, rerun, diff

```bash
npx monkeytest run https://example.com --depth basic
# you ship a fix
npx monkeytest rerun
npx monkeytest diff prev latest
```

`rerun` replays the action trace and does not call the LLM. `--heal` may call the model when a stored locator misses. Runs saved before traces existed fall back to re-executing the plan with the LLM. `diff prev latest` compares the previous run to the newest one. The printer's line is `N new, N fixed, N still broken, N regressed (net ±N)`. It exits 1 when a bug is new or more severe.

`monkeytest verify` replays each known bug and prints `fixed`, `still_broken`, `flaky`, `healed`, or `blocked`.

The same loop from the library:

```ts
import { Monkey, autoLLMConfig, savePlan, saveRun, loadPlan, diffRuns } from '@monkeytestai/monkeytester';

const monkey = new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });
const { plan, run: first } = await monkey.executeAndTriage('https://example.com', {
  run: { screenshotsDir: '.monkeytest/shots' },
});
savePlan(plan, { dir: '.monkeytest' });
saveRun(first, { dir: '.monkeytest' });

const stored = loadPlan('.monkeytest');
const { run: second } = await monkey.runFromPlan(stored.plan, {
  run: { screenshotsDir: '.monkeytest/shots' },
});
saveRun(second, { dir: '.monkeytest' });
console.log(diffRuns(first, second).stats);
```

## CI

`run` already exits 1 on a blocking bug, so the job fails without a wrapper. Pass your preview URL in. The step below does not wait on a host for you.

```yaml
name: monkeytest
on: [workflow_dispatch]
jobs:
  monkeytest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install @monkeytestai/monkeytester
      - run: npx playwright install --with-deps chromium
      - run: npx monkeytest run "$PREVIEW_URL" --depth basic
        env:
          PREVIEW_URL: https://example.com
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

Upload `.monkeytest/shots/` and `.monkeytest/runs/` as artifacts when you want the evidence. The longer recipe is in the [CI guide](https://docs.monkeytest.ai/guides/ci).

## LLM providers

One provider per phase, or the same one everywhere. `autoLLMConfig({ quality: 'balanced' })` uses the cheap model for explore and run, and the smart model for the single planning call.

| Provider | Flag | Key | Cheap model | Smart model |
| --- | --- | --- | --- | --- |
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-4o-mini` | `gpt-4o` |
| Gemini | `gemini` | `GEMINI_API_KEY` or `GOOGLE_API_KEY` | `gemini-flash-lite-latest` | `gemini-flash-latest` |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` | `claude-sonnet-4-5` |
| Mistral | `mistral` | `MISTRAL_API_KEY` | `mistral-small-latest` | `mistral-large-latest` |
| Groq | `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | `llama-3.3-70b-versatile` |
| OpenAI-compatible | `openai_compatible` | `OPENAI_COMPATIBLE_BASE_URL` | `gpt-4o-mini` | `gpt-4o` |

Ollama, vLLM, LM Studio, and OpenRouter use `openai_compatible` and `--base-url`. Model ids are the defaults in `CHEAP_FAST_MODEL` and `SMART_MODEL`. Details, including a local Ollama command: [LLM providers](https://docs.monkeytest.ai/guides/llm-providers).

## Docs

[docs.monkeytest.ai](https://docs.monkeytest.ai)

- [Quick start](https://docs.monkeytest.ai/getting-started/quick-start)
- [Your first run](https://docs.monkeytest.ai/getting-started/first-run) and [reading the report](https://docs.monkeytest.ai/getting-started/reading-the-report)
- [How is this different?](https://docs.monkeytest.ai/guides/how-is-this-different)
- [Rerun and diff](https://docs.monkeytest.ai/guides/rerun-and-diff)
- [Auth and login-only sites](https://docs.monkeytest.ai/guides/auth)
- [Sign-up testing with your own inbox](https://docs.monkeytest.ai/guides/signup)
- [Cost and depth](https://docs.monkeytest.ai/guides/cost-and-depth)
- [CLI](https://docs.monkeytest.ai/reference/cli), [config](https://docs.monkeytest.ai/reference/config), [API](https://docs.monkeytest.ai/reference/api), [report fields](https://docs.monkeytest.ai/reference/report)

Hosted runs of the same engine: [monkeytest.ai](https://monkeytest.ai).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](./CONTRIBUTING.md) and [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Report vulnerabilities in private using [SECURITY.md](./SECURITY.md).

## License

[AGPL-3.0-only](./LICENSE). `SPDX-License-Identifier: AGPL-3.0-only`. You can run and self-host it. If you modify the engine and serve that modification as a network service, the Affero terms apply. Summary: [License](https://docs.monkeytest.ai/guides/license).
