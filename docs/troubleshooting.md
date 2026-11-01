# FAQ and troubleshooting

```bash
npx monkeytest run https://example.com --depth basic
```

If that exits before the browser opens, it is almost always the provider. If it exits after a page was visited, it is almost always the key or Chromium.

## No provider (exit 2)

```text
No LLM provider configured. Set one of: GEMINI_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY, or OPENAI_COMPATIBLE_BASE_URL — or pass --provider explicitly.
```

Export the variable in the same shell, or pass `--provider` and `--api-key`. `node scripts/smoke.mjs` does not go through this check.

## The key is rejected (exit 3)

A present but invalid key is not checked up front. The crawl can print a visited URL and write a PNG under `.monkeytest/shots/` before the site summary fails. `plan.json` is not written. The message is the provider's body, for example Gemini's `API key not valid`. `MONKEYTEST_DEBUG=1` adds the stack. Fix the key and run again.

## Chromium is missing

```bash
npx playwright install chromium
```

In CI use `npx playwright install --with-deps chromium`. If you set `PLAYWRIGHT_BROWSERS_PATH`, set it for both the install step and the run step.

## Why is a finished journey not `passed`?

Steps executing is not a pass. The runner evaluates `outcomeCheck` after the last step. No check is `inconclusive` with `no_assertion`. A check that cannot be decided is `assertion_unverifiable`. Playwright errors (bad selector, strict mode, detached node, typing into the wrong input) are inconclusive, not site bugs.

## Why does a login page say `login_required` even when checks passed?

`public_screens` is `0`: every crawled page was auth-gated. `outcome` can still be `clean` or `bugs_found`. `outcome_detail` says deeper journeys need an account. There is no flag for a real password. See [Auth](/guides/auth).

## Sign-up did not create an account

Without `--inbox` or `--inbox-http`, status is `not_tested` and reason is `no_inbox`. The runner will not submit a completed sign-up form. See [Sign-up testing](/guides/signup).

## `dist/` has declarations and no `.js`

On older commits a leftover `.tsbuildinfo` made `tsc` emit `.d.ts` only. Current `npm run build` deletes that file first. If `dist/cli.js` is missing:

```bash
npm run clean && npm run build
test -f dist/cli.js && test -f dist/index.js
```

## The crawl opened nothing

Exit 3, `pages` 0. Common causes: the URL did not load, a bot wall, or a timeout. `headless: false` (`--no-headless`) shows the window. `outcome_reason` may be `site_unreachable` or `blocked_by_bot_protection`.

## Gemini model 404 or 503

Pinned ids can 404 for a new key. Use `gemini-flash-lite-latest` or `gemini-flash-latest`. A 503 is the provider saying the model is busy. Retry, or move the planner to another provider.

## Ollama returns bad JSON

JSON mode is off when the base URL contains `ollama`, `localhost`, or `127.0.0.1`. Pass `--model` as the tag you pulled. A hosted key in the environment wins auto-detect unless you pass `--provider openai_compatible`.

## Screenshots in your own UI

`screenshotPath` is an absolute path on the runner. Turn it into a URL before a browser fetches it. Serve the directory with the CORS headers your page needs.

## Events arrive late

Attach `bus.on` before `executeAndTriage`. Listeners added after the call miss everything that already fired. Listeners must not throw.

Still stuck: [open an issue](https://github.com/monkeytestai/monkeytester/issues) with `monkeytest version`, `node -v`, the provider and model, and the `engine.error` message.
