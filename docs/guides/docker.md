# Docker

```bash
docker build -t monkeytester:local .
docker run --rm monkeytester:local --help
```

The image compiles this package on Node 22 (`bookworm-slim`) and leaves it at `/opt/monkeytester` (`dist/`, `package.json`, the license files, and production dependencies). API keys are not baked in. Playwright browsers are not downloaded (`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`). A container that should open a page still needs `npx playwright install chromium` and the operating-system libraries.

The default command is `node /opt/monkeytester/dist/cli.js --help`. The process runs as the `node` user. `scripts.prepack` is removed after the build so a later `npm pack` of that tree does not delete `dist/`.

```bash
docker build --build-arg SOURCE_COMMIT="$(git rev-parse HEAD)" -t monkeytester:local .
```

`SOURCE_COMMIT` is stored as the image label `org.opencontainers.image.revision`. Do not pass API keys as build args.

Copy the tree into another image:

```dockerfile
COPY --from=monkeytester:local /opt/monkeytester /opt/monkeytester
```

A sibling checkout can depend on `"@monkeytestai/monkeytester": "file:../monkeytester"`. `mtaiserver` still uses `file:../monkeytest-core` until that repository is updated. The pinned layout, the symlink note, and what is excluded from the runtime stage are in [DOCKER.md](https://github.com/monkeytestai/monkeytester/blob/main/DOCKER.md) at the repository root.
