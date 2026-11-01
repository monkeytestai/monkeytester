# Cost and depth

```bash
npx monkeytest run https://example.com --depth basic
```

```ts
import { resolveDepthPreset, BASIC_PRESET } from '@monkeytestai/monkeytester';

const quick = resolveDepthPreset('basic');
// quick.label === 'Quick pass'
// quick.maxPages === 6
// quick.maxFlows === 5
// quick.focus === 'forms-search-cta'
// BASIC_PRESET.totalBudgetMs === 120_000
```

Cost follows the page cap, the flow cap, and which model you assign to each phase. Page checks and auth-negative checks do not call the planner. They still open the browser.

## Presets

| Depth | Id | Pages | LLM flows | Also |
| --- | --- | --- | --- | --- |
| Quick pass | `basic` | 6 | 5 | Focus `forms-search-cta`. Up to 5 page checks and 6 auth-negative flows, outside the LLM budget. 10s step, 25s flow, 12s page, 120s total. |
| Shallow | `shallow` | 4 | 3 | Smaller smoke preset |
| Broader pass | `standard` | 8 | 6 | The CLI default caps, when you do not pass `--depth` |
| Deeper dig | `deep` | 16 | 10 | |

`--max` and `--flows` override the page and flow caps. Aliases: `quick-pass`, `broader-pass`, `deeper-dig`.

Quick pass is about 10 cases and usually finishes in 1–2 minutes. The 120 second budget is a hard cap: past it, remaining page checks are skipped instead of failing the run.

## Estimates for a standard run

The figures below are order-of-magnitude estimates for one **standard** run (8 pages, 6 flows, about 6 steps each), using these token assumptions per call:

| Phase | Input | Output |
| --- | --- | --- |
| Explorer, per page | ~2,500 | ~250 |
| Planner, once | ~6,000 | ~1,500 |
| Runner, per step | ~1,500 | ~120 |

That is about 80k input tokens and 8k output tokens. A shallow run is smaller. A deep run is larger. Treat the dollars as a sketch, not an invoice. Provider prices move.

| Provider | Cheap everywhere | Balanced | Smart everywhere |
| --- | --- | --- | --- |
| OpenAI | `gpt-4o-mini` ~$0.02 | `gpt-4o-mini` plus `gpt-4o` planner ~$0.05 | `gpt-4o` ~$0.45 |
| Gemini | `gemini-flash-lite-latest` ~$0.01 | flash-lite plus `gemini-flash-latest` planner ~$0.02 | `gemini-flash-latest` ~$0.05 |
| Anthropic | `claude-haiku-4-5` ~$0.08 | Haiku plus `claude-sonnet-4-5` planner ~$0.18 | `claude-sonnet-4-5` ~$0.90 |
| Mistral | `mistral-small-latest` ~$0.03 | small plus `mistral-large-latest` planner ~$0.06 | `mistral-large-latest` ~$0.18 |
| Groq | `llama-3.3-70b-versatile` ~$0.06 | same model ~$0.06 | same model ~$0.06 |
| Local (Ollama) | electricity | electricity | electricity |

Prompt caching on OpenAI and Anthropic can cut a repeated planner prefix. See [Prompt caching](/guides/prompt-caching). The cheapest lever is a smaller `--max`, then a smaller `--flows`, then a smart planner with a cheap runner.

`MODEL_PRICES` and `estimateCostUsd` are exported if you want to price a model id in your own host. They are not a bill.
