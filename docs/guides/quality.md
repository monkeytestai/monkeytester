# Quality methodology

The accuracy gate is a false-positive rate **under 10%** on a frozen 10-site set. **That gate has not been run.** Nothing in this repository is a passing score.

`src/audit/adjudication.ts` is the protocol (`fixed-10-2026-11-08`). It does not fetch the sites. `CURRENT_ADJUDICATION` is `null`.

## The ten slots

Nine hosts are already named by the hand-labelled bake-off corpus in `test/fp-measurement.test.ts`:

1. `https://automationexercise.com/`
2. `https://bananabeings.com/`
3. `https://demo.playwright.dev/todomvc`
4. `https://demoqa.com/`
5. `https://jewellerycasting08.lovable.app/`
6. `https://parabank.parasoft.com/parabank/index.htm`
7. `https://practicesoftwaretesting.com/`
8. `https://the-internet.herokuapp.com/`
9. `https://www.saucedemo.com/`

The tenth slot is **unassigned**. That corpus has no tenth host. Do not invent a URL, and do not crawl a customer site, to fill the table. While any slot is unassigned, `evaluateGate` returns `passed: false`.

The 0.7.1 release note (0 of 12 bugs on `app.monkeytest.ai` and `bananabeings.com`) is stored as `PRIOR_TWO_SITE_NOTE`. `sufficientForGate` is false. Two sites are not the fixed set. That note is also not a description of the hosted service observed on 0.7.0.

## Denominator

False-positive rate = false positives ÷ confirmed bugs.

Confirmed bugs are `RunResult.bugs`. Suggestions are not in the numerator or the denominator. Inconclusive flows are not passes and not false positives. A site that filed **zero** confirmed bugs has an **undefined** rate, not 0%.

The aggregate rate **sums** counts across the ten sites. It does not average per-site rates, so a quiet site cannot dilute a noisy one. A rate of exactly 10% does not pass. The threshold is `FALSE_POSITIVE_GATE` (`0.1`), and the comparison is strict `<`.

## Coverage and misses

Record these beside the rate. They are not the false-positive denominator.

| Field | Meaning |
| --- | --- |
| `inScopePages` | Pages the adjudicator listed before the run |
| `pagesExplored` | Pages this run actually opened |
| Coverage | `pagesExplored / inScopePages`, undefined when the list is empty |
| `misses` | Known defects that no filed bug matched |
| `inconclusiveFlows` | Checks that did not finish. Not a pass |

## Version stamp

Every site row needs `engineVersion`, `gitSha`, `channel` (`latest`, `next`, or `source`), `depth`, and the explorer, planner, and runner model ids. A row without that stamp cannot pass the gate. The npm channel is not the hosted product version. See [Versions](/getting-started/versions).

## What already runs in CI

`npm test` includes fixture tests and the labelled replay of old findings (`test/fp-measurement.test.ts`, `test/false-pass-rate.test.ts`). Those lock classifier behaviour. They are not a fresh pass over the ten sites, and they do not flip the gate.

A local reproduction of find → fix → same-trace rerun → diff lives on the demo fixture only: `npx tsx scripts/fixture-loop.ts`. That run is a stub action resolver. It is not a model evaluation and not an adjudication.
