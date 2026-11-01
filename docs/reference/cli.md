# CLI

```bash
npx monkeytest --help
npx monkeytest version
```

The binary ships in `@monkeytestai/monkeytester`. From a clone it is `node dist/cli.js`. Everything writes to `./.monkeytest` unless you pass `--dir`.

`monkeytest init` prints:

```text
✓ Initialised .monkeytest/
  Tracked:    config.json, plan.json (after first run)
  Ignored:    shots/, runs/
```

`config.json` is a starter file. The CLI does not read it. Flags and environment variables are what take effect. The `$schema` URL in that file is not published.

## Commands

| Command | What it does |
| --- | --- |
| `init` | Creates `.monkeytest/` with `config.json`, `runs/`, `shots/`, and a `.gitignore`. Idempotent. |
| `explore <url>` | Crawl and plan. Writes `plan.json` and `sitemap.json`. Does not run the flows. |
| `run <url>` | Explore, plan, run, triage. Writes `plan.json`, `runs/<id>.json`, and `shots/`. |
| `rerun [runId]` | Replays the stored trace. No LLM unless `--heal`, or the run has no trace. |
| `verify [run]` | Replays each bug trace. Verdicts: `fixed`, `still_broken`, `flaky`, `healed`, `blocked`. |
| `diff <a> <b>` | Fingerprint diff. `latest` and `prev` are shortcuts. |
| `report [runId]` | Prints a stored run. Defaults to `latest`. |
| `help [command]` | Top-level or per-command help. |
| `version` | Prints `monkeytester@<version>`. |

```bash
npx monkeytest run https://example.com --depth basic
npx monkeytest rerun
npx monkeytest diff prev latest
npx monkeytest report --json
```

`diff` prints `N new, N fixed, N still broken, N regressed (net ±N)` and exits 1 when a bug is new or more severe. The sections under that line are "New bugs", "Regressed bugs", "Fixed bugs", and "Still broken", each with severity, title, and fingerprint. Those titles come from the runs on disk.

## Flags

| Flag | Default | What |
| --- | --- | --- |
| `-d, --dir <path>` | `.monkeytest` | Working directory |
| `--provider <id>` | auto-detect | `openai`, `gemini`, `anthropic`, `mistral`, `groq`, `openai_compatible` |
| `--model <id>` | provider default | Runner model. Also the planner, unless `--planner-model` is set. Page summaries stay on the cheap model. |
| `--planner-model <id>` | | Planner only |
| `--api-key <key>` | env | Overrides the env key |
| `--base-url <url>` | | Required for `openai_compatible` when the env URL is unset |
| `--quality <preset>` | `balanced` | `cheap`, `balanced`, `smart` |
| `--depth <preset>` | | `basic` (Quick pass), `standard`, `deep`, `shallow`. Aliases: `quick-pass`, `broader-pass`, `deeper-dig`. |
| `-m, --max <n>` | 8, or the preset | Page cap. Wins over `--depth` when you pass it. |
| `--flows <n>` | 6, or the preset | LLM flow cap. Wins over `--depth` when you pass it. |
| `--no-headless` | headless | Show the browser |
| `--label <text>` | | Saved on the plan and the run |
| `--json` | text | Machine-readable output for `run`, `diff`, `report`, `verify` |
| `--fail-on-5xx` / `--no-fail-on-5xx` | on | A same-origin HTTP ≥500 (document, xhr, or fetch) becomes a blocking bug |
| `--heal` | off | On `rerun` and `verify`, re-resolve a missed locator |
| `--repeat <n>` | 1 | How many times `verify` replays each bug |
| `--bug <fingerprint>` | | `verify` one bug |
| `--inbox <module>` | | Your `InboxProvider` module. No hosted inbox. |
| `--inbox-http <url>` | | Your HTTP inbox. Token: `MONKEYTEST_INBOX_TOKEN`. |

`--depth basic` is 6 pages, 5 LLM flows, up to 5 page checks and 6 auth-negative flows outside that budget, and a 120 second cap. See [Your first run](/getting-started/first-run).

## Environment

| Variable | Used for |
| --- | --- |
| `GEMINI_API_KEY`, `GOOGLE_API_KEY` | Gemini. Checked first. |
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Anthropic |
| `MISTRAL_API_KEY` | Mistral |
| `GROQ_API_KEY` | Groq |
| `OPENAI_COMPATIBLE_BASE_URL` | Ollama, vLLM, LM Studio, OpenRouter |
| `OPENAI_COMPATIBLE_API_KEY` | Optional key for that endpoint |
| `MONKEYTEST_INBOX_TOKEN` | Bearer token for `--inbox-http` |
| `MONKEYTEST_DEBUG` | Stack traces on failure |

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success, or no blocking bug |
| 1 | Blocking bugs, a bad `diff`, or `verify` still firing |
| 2 | Bad arguments or no provider |
| 3 | Engine error. Also when `run` opens zero pages. |

## On disk

```text
.monkeytest/
├── config.json          # written by init, not read by the CLI
├── plan.json            # schema 1
├── sitemap.json         # explore only
├── runs/<id>.json       # schema 1
└── shots/               # page-*.png, flow-*-step-*.png, flow-*.webm
```

A file whose `schema` is newer than this build is rejected instead of being misread.
