# Starter issues

Briefs for a first pull request. They are not GitHub issues. Opening them on the tracker is a maintainer decision. Each brief names the files, the acceptance check, and what to leave alone.

The safety work in 0.7.2 (contact submits, sensitive submits, browser-error pages, replay fingerprints) is not a starter task. Do not refactor those paths to land one of these.

Authenticated retesting is a separate workstream. These briefs do not include login, session, cookie, or credential storage, and they do not ask you to change `src/signup/`, `src/explorer/authRedirect.ts`, `src/planner/authNegative.ts`, or `src/runner/authNegative.ts`.

## 1. Publish the config schema `init` points at, or stop pointing at it

`monkeytest init` writes `.monkeytest/config.json` with `$schema` set to `https://docs.monkeytest.ai/config-schema-v1.json`. That URL is not a file in `docs/public/`. The CLI does not read `config.json`. Flags and environment variables are what take effect (`docs/reference/cli.md`).

**Acceptance**

- Either add `docs/public/config-schema-v1.json` whose properties are exactly the keys `init` writes today (`provider`, `quality`, `depth`, `maxPages`, `maxFlows`), and a test that the `$schema` string in `src/cli.ts` matches `/config-schema-v1.json` and that the file exists.
- Or remove `$schema` from the scaffold until a file exists, and assert the written JSON has no `$schema`.
- `test/init-schema.test.ts` runs `node --import tsx src/cli.ts init --dir <tmp>` and reads the file. No network.
- `init` stays idempotent. The CLI still does not load `config.json`.

**Maintainer**

Review the schema as documentation of the scaffold only. Do not start honouring `config.json` in the same change.

## 2. `report` should show `videoPath`

`FlowResult.videoPath` is the per-flow WebM. `monkeytest report` prints `StepResult.screenshotPath` and does not print `videoPath` (`src/cli.ts`, `cmdReport`). `monkeytest open` lists both.

**Acceptance**

- A temp run JSON with `flows[0].videoPath` set to an absolute path.
- `monkeytest report <id> --dir <tmp>` stdout contains that path.
- `monkeytest report <id> --json` is still the stored file, unchanged.
- No upload, no browser, no new network call.

**Maintainer**

Print the path the run already stored. Do not generate a video in the test.

## 3. Optional local mode for the stub smoke

`node scripts/smoke.mjs` is a stub LLM against `https://example.com`. Keep that default. Contributors without outbound network need a local mode.

**Acceptance**

- `node scripts/smoke.mjs` with no flag still crawls `https://example.com`, still prints `STUB — not real-model testing`, and still ends with `OK — engine pipeline is wired correctly.`
- `node scripts/smoke.mjs --fixture` starts `test/fixtures/demo-app` on `127.0.0.1`, uses the stub LLM, prints the same stub line, exits 0, and does not require example.com.
- If the fixture mode can see the contact form, `contactPosts` stays 0. Do not POST a contact message to make the smoke "complete".
- The script's success line is not described as a real-model result.

**Maintainer**

Do not delete the example.com path. Do not add an API key. Do not change auth, session, or signup source to make the fixture mode pass.

## 4. Cost-guide model ids must exist in `MODEL_PRICES`

`docs/guides/cost-and-depth.md` names model ids in the cheap, balanced, and smart columns. `src/llm/prices.ts` is the price table. A renamed id in one file and not the other makes the sketch silently wrong.

**Acceptance**

- `test/cost-doc-models.test.ts` reads `docs/guides/cost-and-depth.md`, extracts the model ids in backticks in the estimate table, and expects each id to be a key of `MODEL_PRICES` and not `deprecated: true`.
- The prose may keep the word "sketch". Do not replace the sketch dollars with a generated invoice.
- When a model id is missing, fix the doc or add a price row. Do not invent a price that is not a published list price.

**Maintainer**

Price rows are public list prices. A missing row should make `estimateCostUsd` return null, which is the current behaviour. Do not guess.

## 5. Internal docs links should fail when the heading anchor is missing

`scripts/check-docs-links.mjs` resolves a docs path and then ignores the `#fragment`. A link to `/guides/rerun-and-diff#no-such-heading` currently passes.

**Acceptance**

- Extend the checker (or add `test/docs-anchors.test.ts`) so an internal link with a fragment must match a heading slug in the target markdown.
- Fixture: a temporary markdown string with a heading `## Rerun` and a link `...#rerun` passes; `...#missing` fails.
- Do not fetch external sites. Do not change auth guides except to fix a fragment that the new check proves is wrong.
- `npm run docs:links` still exits 0 on this repository after the check is accurate.

**Maintainer**

VitePress heading slugs are GitHub-style. Punctuation in a heading is the easy bug. Do not hand-edit `docs/guides/auth.md` to invent capability. If that page fails the anchor check, fix the fragment only.
