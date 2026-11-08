# Local fixture loop

A reproducible find → fix → same-trace rerun → diff against `test/fixtures/demo-app` on `127.0.0.1`.

This is **not** a live model run. The plan is hand-authored. Action resolution is a stub LLM. The contact form is not submitted. It is **not** a run against a customer site, `bananabeings.com`, or the hosted product.

`artifact.json` is the last local run of the script, stamped with `engineVersion`. Regenerate it rather than editing it.

```bash
npm install
npx playwright install chromium
npx tsx scripts/fixture-loop.ts --out examples/fixture-loop/artifact.json
```

The script prints `STUB — not real-model testing` and a diff line. A useful result looks like `0 new, 3 fixed, 0 still broken, 0 regressed`. Three seeded bugs (page error, broken link, disabled button) are filed, the fixture flips to fixed, `replayTraces` runs the stored traces without calling the stub again, and `diffRuns` compares fingerprints. `contactPosts` stays 0.

Shots and the run store are written under `examples/fixture-loop/.shots` and `.store`, which are gitignored. The artifact keeps counts and signals, not machine-specific screenshot paths.

## Recording

The diagram in the README (`docs/public/loop.svg`) is a diagram. It is not a recording.

A recording belongs in this folder only if it is a capture of this command's real output. Record the terminal while the script runs. Do not generate footage, do not restage a customer site, and do not present the stub as a model.

No video file is committed here. A screen recording of this command, labelled stub, may be attached to a pull request. It is not a live-model run.
