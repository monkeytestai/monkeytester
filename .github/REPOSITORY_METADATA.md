# Repository metadata

Observed on 8 November 2026: GitHub About description was empty, topics were empty, the repository had 4 stars and 0 forks. Stars and npm downloads are not adoption. This pull request does not call the GitHub API and does not change About, topics, or the social preview on the repository.

Apply the following from a maintainer account when you want the public About page to match the product. Do not buy stars, exchange stars, or automate starring.

## About

```
Open-source autonomous website QA: URL → evidence-backed bugs → rerun + diff.
```

## Topics

```
ai-testing
autonomous-testing
playwright
typescript
cli
quality-assurance
```

## Commands for a maintainer

These are not run by this change.

```bash
gh repo edit monkeytestai/monkeytester \
  --description "Open-source autonomous website QA: URL → evidence-backed bugs → rerun + diff."

gh repo edit monkeytestai/monkeytester \
  --add-topic ai-testing \
  --add-topic autonomous-testing \
  --add-topic playwright \
  --add-topic typescript \
  --add-topic cli \
  --add-topic quality-assurance
```

## Social preview

`.github/social-preview.png` is a 1280×640 card drawn for the GitHub About social image. It is not a screenshot of a run and not a recording. Upload it in the repository About settings (Social preview). GitHub does not pick the file up from the tree.

Website hero text on docs.monkeytest.ai and the README headline stay as they are. This card uses the About sentence above, not a replacement headline for the site.
