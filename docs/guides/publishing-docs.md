# Publishing docs

```bash
npm run docs:build
```

The site is VitePress. The build writes `docs/.vitepress/dist`. Production is [docs.monkeytest.ai](https://docs.monkeytest.ai) on Vercel. [`.github/workflows/docs.yml`](https://github.com/monkeytestai/monkeytester/blob/main/.github/workflows/docs.yml) builds the site and uploads an artifact. It does not deploy. Vercel builds from the GitHub repository.

Clean URLs need `cleanUrls: true` in [`vercel.json`](https://github.com/monkeytestai/monkeytester/blob/main/vercel.json). Vercel does not read `netlify.toml` or `docs/public/_redirects`. Old paths redirect in `vercel.json`.

The Vercel project root has to be the repository root, so `vercel.json` is picked up. Output directory: `docs/.vitepress/dist`. Node 20 or newer. Host notes are in [DEPLOY.md](https://github.com/monkeytestai/monkeytester/blob/main/docs/DEPLOY.md).
