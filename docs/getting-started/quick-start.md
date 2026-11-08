# Quick start

```bash
npx --yes @monkeytestai/monkeytester@latest --help
```

`--help` prints the commands. No API key, no browser.

## Install, run, read

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

::: info Which version
`npm install @monkeytestai/monkeytester` follows the `latest` dist-tag (the stable channel). These pages describe this repository. Install the pre-release channel with `@monkeytestai/monkeytester@next`. Do not copy a version number into this page. The registry observation, this tree's `package.json` version, and the hosted service are three different things: [Versions](/getting-started/versions).
:::

With an OpenAI key, the default model is `gpt-4o-mini`. Auto-detect otherwise picks the first key it finds: Gemini (`GEMINI_API_KEY` or `GOOGLE_API_KEY`), OpenAI, Anthropic, Mistral, Groq, then `OPENAI_COMPATIBLE_BASE_URL` for Ollama, vLLM, LM Studio, or OpenRouter. You need Node.js 20+, Chromium (`npx playwright install chromium`), and one of those. A missing key exits 2 before the browser starts. Quick pass is usually 1–2 minutes and smaller than the standard-run cost sketch. Those dollars are a sketch, not an invoice: [Cost and depth](/guides/cost-and-depth).

`--depth basic` is Quick pass: 6 pages, 5 LLM flows, page checks outside that budget, 120 second cap. About 10 cases, usually 1–2 minutes.

## Where the files go

| Path | What it is |
| --- | --- |
| `.monkeytest/plan.json` | The plan |
| `.monkeytest/runs/<id>.json` | One run |
| `.monkeytest/shots/` | PNGs and per-flow WebM |

`npx monkeytest report` prints the latest run. `npx monkeytest report --json` prints the stored file. `npx monkeytest open` prints the run file and the local screenshot and WebM paths. `open` is unreleased in this source tree. It is not in the npm packages observed on 8 Nov 2026. It does not upload files and it does not fetch the site. Then `npx monkeytest rerun` replays the stored trace, and `npx monkeytest diff prev latest` compares fingerprints.

Exit `1` means a blocking bug (anything that is not `minor`). Exit `2` means bad arguments or no provider. Exit `3` means the engine failed, including a crawl that opened zero pages.

## No key, from a clone

The smoke script is in the repository, not in the npm package. It is a **stub**, not real-model testing. It crawls `https://example.com` and does not call a provider. The success line is not a model result.

```bash
git clone https://github.com/monkeytestai/monkeytester.git
cd monkeytester
npm install && npm run build
npx playwright install chromium
node scripts/smoke.mjs
```

The success line is `OK — engine pipeline is wired correctly.`

Next: [Installation](/getting-started/installation) · [Your first run](/getting-started/first-run).
