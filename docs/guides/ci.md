# CI

```yaml
- run: npm install @monkeytestai/monkeytester
- run: npx playwright install --with-deps chromium
- run: npx monkeytest run "$PREVIEW_URL" --depth basic
  env:
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
```

`run` exits 1 when any bug is not `minor`, so the job fails on its own. Put the preview URL in `PREVIEW_URL`. This snippet does not discover that URL for you.

## GitHub Actions

`workflow_dispatch` keeps the example runnable without a deployment event. On a pull request, set `PREVIEW_URL` from whatever your host already exports.

```yaml
name: monkeytest
on: [workflow_dispatch]
jobs:
  monkeytest:
    runs-on: ubuntu-latest
    timeout-minutes: 15
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
      - if: always()
        uses: actions/upload-artifact@v4
        with:
          name: monkeytest
          path: |
            .monkeytest/shots/**
            .monkeytest/runs/**
            .monkeytest/plan.json
          if-no-files-found: ignore
```

`--depth basic` caps the run at 120 seconds plus the crawl limits in [Your first run](/getting-started/first-run). Cache the Playwright browser directory if you want to skip the download. `headless` is already the default.

After a fix lands, `monkeytest rerun` replays the trace with no LLM call, and `monkeytest diff prev latest` exits 1 on a new or more severe bug. Keep `.monkeytest/plan.json` between jobs if you want that second command. `runs/` and `shots/` are local artifacts.

## From the library

Same gate, if the job should choose models per phase:

```ts
import { Monkey, autoLLMConfig } from '@monkeytestai/monkeytester';

const url = process.env.PREVIEW_URL;
if (!url) process.exit(2);

const { run } = await new Monkey({
  llm: autoLLMConfig({ quality: 'balanced' }),
}).executeAndTriage(url, {
  explore: { maxPages: 6, screenshotsDir: '.monkeytest/shots' },
  plan: { maxFlows: 5 },
  run: { screenshotsDir: '.monkeytest/shots', headless: true },
});

const blocking = run.bugs.filter((bug) => bug.severity !== 'minor');
if (blocking.length) process.exit(1);
```

`autoLLMConfig` throws if no provider key is set. The balanced preset uses the cheap model for explore and run, and the smart model for the planner. Override one tier with `overrides`.

Next: [Rerun and diff](/guides/rerun-and-diff).
