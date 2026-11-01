# Your first run

```bash
export OPENAI_API_KEY="sk-..."
npx monkeytest run https://example.com --depth basic
```

Quick pass (`--depth basic`, also `--depth quick-pass`) uses the numbers in `BASIC_PRESET`:

| | |
| --- | --- |
| Pages | 6 |
| LLM flows | 5 |
| Page checks | up to 5, outside the flow budget |
| Auth-negative flows | up to 6, outside the flow budget, only if a password field was crawled |
| Step / flow / page timeouts | 10s / 25s / 12s |
| Whole run | 120s. Past that, remaining page checks are skipped. |

About 10 cases, usually 1–2 minutes. `--max` and `--flows` still override the page and flow caps. Other presets: `standard` (8 pages, 6 flows), `deep` (16 and 10), `shallow` (4 and 3).

## What prints

The CLI logs each visited URL, then each flow. When it finishes it prints `SiteMap`, `Plan`, and `Run`, including `outcome` and `outcome_detail`, then the paths it wrote:

```text
plan → .monkeytest/plan.json
run  → .monkeytest/runs/<id>.json
```

`run` does not write `sitemap.json`. This does:

```bash
npx monkeytest explore https://example.com --depth basic
```

`explore` crawls and plans. It does not execute the flows.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Finished, and no blocking bug (severity other than `minor`). |
| 1 | `run` or `rerun` found a blocking bug. `diff` found a new bug or a severity increase. `verify` still sees `still_broken` or `flaky`. |
| 2 | Bad arguments, or no provider. The browser does not open. |
| 3 | The engine threw, or the explorer opened zero pages. |

A rejected API key is exit 3, after the crawl. The message is the provider's. `MONKEYTEST_DEBUG=1` adds the stack.

## Local model

Ollama speaks the OpenAI API at `http://127.0.0.1:11434/v1`. JSON mode is turned off for `localhost`, `127.0.0.1`, and URLs that contain `ollama`.

```bash
ollama pull llama3.1:8b
npx monkeytest run https://example.com \
  --provider openai_compatible \
  --base-url http://127.0.0.1:11434/v1 \
  --model llama3.1:8b \
  --depth basic
```

Pass `--model`. The built-in default for `openai_compatible` is `gpt-4o-mini`, which is not an Ollama tag. If a hosted key is also exported, pass `--provider` or auto-detect will prefer that key.

Next: [Reading the report](/getting-started/reading-the-report).
