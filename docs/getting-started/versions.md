# Versions

Three different versions show up in conversation. They are not interchangeable.

| What | How to read it | What it is not |
| --- | --- | --- |
| npm dist-tag `latest` | `npm view @monkeytestai/monkeytester dist-tags --json` | The hosted product |
| npm dist-tag `next` | The same command | The hosted product |
| This git tree | `package.json` `version`, and `monkeytest version` | A promise about production |
| Hosted API and worker | Observed deployment, named separately below | Whichever npm tag is newest |

Install the stable channel with `npm install @monkeytestai/monkeytester`. That follows `latest`. Install the pre-release channel with `npm install @monkeytestai/monkeytester@next`. Building this repository gives you the version in `package.json`. Docs on this branch describe that tree.

## Registry observation

Checked with `npm view` on **8 November 2026 at 10:16 IST**. This is an observation, **not a pin**. Re-run the command before you quote it.

| Dist-tag | Version observed |
| --- | --- |
| `latest` | 0.7.1 |
| `next` | 0.7.2-beta.2 |

`0.7.2-beta.2` is also the `version` in this tree's `package.json`. Matching the `next` tag does not mean this commit was the publish, and it does not mean production runs that build.

## Hosted service

The hosted API and worker were observed running **0.7.0**, from droplet checkout `60def87b`. The exact image revision is unproven. Unset safety flags do not establish safety defaults. Fixes that exist only on npm `latest` (0.7.1) or `next` (0.7.2-beta.2) are **not live SaaS protection**. Installing or publishing a newer package does not change that service.

Do not infer the deployed version from an npm tag.

## Docs site

[docs.monkeytest.ai](https://docs.monkeytest.ai) is built from `docs/` in [monkeytestai/monkeytester](https://github.com/monkeytestai/monkeytester). The edit link on each page points at `monkeytester/edit/main/docs/:path`. `monkeytestai/docs` is not this site.

`npm run docs:build` emits `sitemap.xml`, copies `robots.txt`, and writes a `rel=canonical` link on each page. Those files 404 on the live host until a later docs deploy. This repository does not deploy, and it does not change the Vercel project's dashboard settings. See [DEPLOY.md](https://github.com/monkeytestai/monkeytester/blob/main/docs/DEPLOY.md).

## Accuracy

The false-positive gate is a rate under 10% on a fixed 10-site set. That measurement is not recorded. A 0% note on two sites is not the gate. See [Quality methodology](/guides/quality).
