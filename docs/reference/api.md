# Programmatic API

```ts
import { Monkey, autoLLMConfig } from '@monkeytestai/monkeytester';

const monkey = new Monkey({ llm: autoLLMConfig({ quality: 'balanced' }) });
const { siteMap, plan, run } = await monkey.executeAndTriage('https://example.com', {
  explore: { maxPages: 6, screenshotsDir: '.monkeytest/shots' },
  plan: { maxFlows: 5 },
  run: { screenshotsDir: '.monkeytest/shots', headless: true },
});
```

Import from `@monkeytestai/monkeytester` only. There are no public subpath exports. Inside a clone, import `./dist/index.js` or `./src/index.ts` with `tsx`.

`executeAndTriage` resolves even when explore or plan is partial. An empty `plan.flows` still returns. Read `plan.notes`. A missing API key throws before that.

## Methods

| Method | Returns | Use it when |
| --- | --- | --- |
| `executeAndTriage(url, opts)` | `{ siteMap, plan, run }` | Full loop |
| `exploreAndPlan(url, opts)` | `{ siteMap, plan }` | Crawl and plan, no execution |
| `runFromPlan(plan, opts)` | `{ run }` | Execute a stored plan with the LLM |
| `replayRecorded(run, opts)` | `{ run }` | Replay traces. No LLM unless `opts.heal`. |

`new Monkey()` defaults `strictOracles` and `failOn5xx` to on. Pass `false` to opt out. `plannerModel` sets the planner model only. `inbox` is an `InboxProvider`. See [Config](/reference/config).

## Plans, runs, diff

```ts
import { savePlan, saveRun, loadPlan, loadRun, diffRuns, summariseDiff } from '@monkeytestai/monkeytester';

const planPath = savePlan(plan, { dir: '.monkeytest' });
const { path, id } = saveRun(run, { dir: '.monkeytest' });
const stored = loadPlan('.monkeytest');
const diff = diffRuns(earlier, later);
console.log(summariseDiff(diff));
```

`diffRuns` returns `newBugs`, `fixedBugs`, `persistingBugs`, `regressedBugs`, and `stats` (`new`, `fixed`, `persisting`, `regressed`, `delta`). `summariseDiff` is the one-line CLI string.

`verifyBugs(run, opts)` replays bug traces. The report's `exitCode` is 1 when any verdict is `still_broken` or `flaky`.

## Other exports you can call directly

| Export | Role |
| --- | --- |
| `explore`, `plan`, `groundedTestPlan`, `runPlan` | The phases, if you drive them yourself |
| `triage`, `triagePolished` | Rule-based triage, and optional copy polish |
| `createLLM`, `autoLLMConfig`, `detectProviderFromEnv` | Provider setup |
| `CHEAP_FAST_MODEL`, `SMART_MODEL` | Default model ids |
| `resolveDepthPreset`, `DEPTH_PRESETS`, `BASIC_PRESET` | Page and flow caps |
| `createHttpInbox`, `loadInboxProvider` | Your inbox |
| `EventBus`, `noopBus` | Live events. See [Events](/reference/events). |
| `ENGINE_VERSION` | The string stored on `run.engine_version` |
| `AUTH_PROVIDER_CONTRACT`, `createAuthProvider` | In-memory existing-account provider. See [Auth provider contract](/reference/auth-contract). |
| `alignVerdict`, `deriveRunOutcome` | Outcome sentences. A model verdict is kept only when it agrees with the bug count. |

`triage(run)` does not turn `failOn5xx` on by itself. `executeAndTriage` does, because it goes through `Monkey`.

If the planner returns invalid JSON, usable flows are kept, the crawl's public-form flow is still reserved when `maxFlows` allows it, and `plan.notes` records the model error. An empty plan remains only when the crawl has nothing to ground.
