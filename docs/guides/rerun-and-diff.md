# Rerun and diff

```bash
npx monkeytest run https://example.com --depth basic
npx monkeytest rerun
npx monkeytest diff prev latest
```

`run` writes `.monkeytest/plan.json` and a file under `.monkeytest/runs/`. `rerun` replays the action trace on the latest run. It does not crawl again and it does not call the LLM. Sign-in checks, sign-up checks, and a signed-out redirect are judged the same way as a live run. A recorded locator that no longer matches is inconclusive, not a site bug.

`--heal` re-resolves a step whose locator missed, marks that step `healed`, and may call the model. If the stored run has no trace, `rerun` says so and re-executes the stored plan with the LLM. Pass a run id to replay that run instead of the latest.

`rerun` exits 1 when a blocking bug is still failing. It prints a `monkeytest diff <previous> <new>` hint when an older run exists.

## Diff

```bash
npx monkeytest diff prev latest
npx monkeytest diff <runA> <runB>
npx monkeytest diff prev latest --json
```

`latest` is the newest file in `runs/`. `prev` is the one before it. Any other argument is a run id. `diff` does not open a browser and does not call a model.

The text line is built by `summariseDiff`:

```text
N new, N fixed, N still broken, N regressed (net ±N)
```

`new`, `fixed`, `persisting` ("still broken"), and `regressed` are the four sets. `regressed` means the same fingerprint came back at a higher severity. Exit code 1 when `new` or `regressed` is non-empty.

Matching uses `fingerprintV2` when both bugs have it, and the legacy `fingerprint` otherwise.

## Verify one bug

```bash
npx monkeytest verify
npx monkeytest verify --repeat 3
npx monkeytest verify --bug <fingerprint>
```

Each known bug's trace is replayed. The verdict is `fixed`, `still_broken`, `flaky`, `healed`, or `blocked`. Exit 1 when any row is `still_broken` or `flaky`. `--heal` is the same locator retry as on `rerun`.

## From the library

```ts
import { Monkey, autoLLMConfig, diffRuns, loadPlan, saveRun } from '@monkeytestai/monkeytester';

const monkey = new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });
const { plan } = loadPlan('.monkeytest');
const { run } = await monkey.runFromPlan(plan, {
  run: { screenshotsDir: '.monkeytest/shots' },
});
saveRun(run, { dir: '.monkeytest' });
```

`runFromPlan` executes the stored plan. It is the fallback path, not the trace replay. Trace replay is `replayTraces`, which is what the CLI uses when a trace is present. `diffRuns(previous, current)` returns `{ newBugs, fixedBugs, persistingBugs, regressedBugs, stats }`.

Next: [CLI reference](/reference/cli).
