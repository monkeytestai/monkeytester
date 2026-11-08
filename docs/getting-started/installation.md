# Installation

```bash
npm install @monkeytestai/monkeytester
npx playwright install chromium
```

Node.js 20 or newer (`node -v`). The package is ESM and ships TypeScript declarations. The binary is `monkeytest`.

::: code-group

```bash [npm]
npm install @monkeytestai/monkeytester
npx playwright install chromium
```

```bash [pnpm]
pnpm add @monkeytestai/monkeytester
pnpm exec playwright install chromium
```

```bash [yarn]
yarn add @monkeytestai/monkeytester
yarn playwright install chromium
```

```bash [bun]
bun add @monkeytestai/monkeytester
bunx playwright install chromium
```

:::

| Tag | Install | What you get |
| --- | --- | --- |
| `latest` | `npm install @monkeytestai/monkeytester` | Stable channel. The tag moves. See [Versions](/getting-started/versions). |
| `next` | `npm install @monkeytestai/monkeytester@next` | Pre-release channel. This tree is that line when `package.json` is a pre-release. |

Playwright's Chromium is a separate download. In CI, add the system libraries:

```bash
npx playwright install --with-deps chromium
```

A global install puts `monkeytest` on your `PATH`:

```bash
npm install -g @monkeytestai/monkeytester
```

## Providers

Set one key in the same shell you use to run. A missing key exits **2** before Chromium starts. A key the provider rejects exits **3** after the crawl has started.

| Variable | Provider |
| --- | --- |
| `GEMINI_API_KEY` or `GOOGLE_API_KEY` | Gemini. Checked first. |
| `OPENAI_API_KEY` | OpenAI. Default model `gpt-4o-mini`. |
| `ANTHROPIC_API_KEY` | Anthropic |
| `MISTRAL_API_KEY` | Mistral |
| `GROQ_API_KEY` | Groq |
| `OPENAI_COMPATIBLE_BASE_URL` | Ollama, vLLM, LM Studio, OpenRouter. `OPENAI_COMPATIBLE_API_KEY` is optional on a local server. |

## From a clone

```bash
git clone https://github.com/monkeytestai/monkeytester.git
cd monkeytester
npm install && npm run build
npx playwright install chromium
node dist/cli.js --help
```

`npm run build` writes `dist/cli.js`. Contributors run `node dist/cli.js` instead of `npx monkeytest`. The no-key check is `node scripts/smoke.mjs`.

Next: [Your first run](/getting-started/first-run).
