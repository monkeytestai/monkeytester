# Config

```ts
import { Monkey, autoLLMConfig } from '@monkeytestai/monkeytester';

const monkey = new Monkey({
  llm: autoLLMConfig({ quality: 'balanced' }),
});
```

Three surfaces: the `Monkey` constructor, the options on `executeAndTriage`, and environment variables. `monkeytest init` writes `.monkeytest/config.json`. The CLI does not load that file. Delete it, or keep it as notes. Its `$schema` URL is not a published JSON Schema.

## Quality

| `quality` | Explorer | Planner | Runner |
| --- | --- | --- | --- |
| `cheap` | cheap | cheap | cheap |
| `balanced` (default) | cheap | smart | cheap |
| `smart` | smart | smart | smart |

```ts
autoLLMConfig({
  quality: 'balanced',
  overrides: { runner: { provider: 'groq', model: 'llama-3.3-70b-versatile' } },
});
```

Omit `runner` and the planner model is reused for runner calls. Omit `triager` and triage stays deterministic. Model ids are on [LLM providers](/guides/llm-providers).

`LLMConfig` is `{ provider, model?, apiKey?, baseURL?, temperature? }`. `temperature` defaults to 0.2 for JSON calls. Models that reject a custom temperature (`gpt-5*`, o-series) omit the field, and a 400 that says temperature is unsupported is retried once without it. `provider` is `openai`, `gemini`, `anthropic`, `mistral`, `groq`, or `openai_compatible`. Do not select `gpt-4.1-nano`. It is deprecated. `estimateCostUsd` prices each step at that step's model. `gpt-5-mini` and `gpt-5-nano` have price rows.

## `executeAndTriage`

```ts
const { siteMap, plan, run } = await monkey.executeAndTriage(url, {
  explore: { maxPages: 6, screenshotsDir: '.monkeytest/shots' },
  plan: { maxFlows: 5 },
  run: { screenshotsDir: '.monkeytest/shots', headless: true },
});
```

### Explore

| Option | Default | Meaning |
| --- | --- | --- |
| `maxPages` | 8 | Crawl cap. Quick pass sets 6. |
| `pageTimeoutMs` | 20000 | Per-page navigation. Quick pass sets 12000. |
| `headless` | true | |
| `screenshotsDir` | | Viewport PNG per page, stored on the page |
| `onPage` | | Called with each crawled page |

### Plan

| Option | Default | Meaning |
| --- | --- | --- |
| `maxFlows` | 6 | LLM flow cap. Quick pass sets 5. |
| `includeAuthFlows` | true | Keep flows the model tagged `auth_required` |
| `focus` | | `forms-search-cta` on Quick pass |
| `signupInbox` | false | Plan exactly one sign-up when a sign-up form was crawled. `true` on its own does not submit. Pass `inbox` as well. |

### Run

| Option | Default | Meaning |
| --- | --- | --- |
| `screenshotsDir` | required | Step PNGs and per-flow WebM |
| `stepTimeoutMs` | 15000 | Quick pass sets 10000 |
| `flowTimeoutMs` | 180000 | Quick pass sets 25000 |
| `headless` | true | |
| `strictOracles` | on via `new Monkey()` | Page error, document HTTP 404, action HTTP ≥500, or a disabled control fails the step |
| `failOn5xx` | on via `new Monkey()` | A same-origin HTTP ≥500 on document, xhr, or fetch fails the step |
| `inbox` | | `InboxProvider`. Allows the one sign-up, plus OTP and password-reset submits. |
| `allowSensitive` | | Extra final submits: `newsletter`, `payment`, `deletion`. `signup`, `reset`, and `otp` are already allowed when `inbox` is set. |

`runPlan`, `replayTraces`, and a direct `triage(run)` leave `strictOracles` and `failOn5xx` off unless the caller passes them. `new Monkey()` turns both on and passes them through.

Depth presets are `resolveDepthPreset('basic' | 'standard' | 'deep' | 'shallow')` and `BASIC_PRESET`. CLI flags for the same knobs are in the [CLI reference](/reference/cli).

## Environment

| Variable | Purpose |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI |
| `OPENAI_MODEL` | Optional default OpenAI model id |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | Gemini |
| `ANTHROPIC_API_KEY` | Anthropic |
| `MISTRAL_API_KEY` | Mistral |
| `GROQ_API_KEY` | Groq |
| `OPENAI_COMPATIBLE_BASE_URL` | OpenAI-compatible server |
| `OPENAI_COMPATIBLE_API_KEY` | Key for that server |
| `PLAYWRIGHT_BROWSERS_PATH` | Chromium location |
| `MONKEYTEST_INBOX_TOKEN` | Bearer token for `--inbox-http` |
| `MONKEYTEST_DEBUG` | Stack traces |

Sign-up configuration is [Sign-up testing](/guides/signup). `new Monkey({ inbox })` is the library form of `--inbox`.
