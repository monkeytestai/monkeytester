import { describe, expect, it } from 'vitest';
import { DOCS_ORIGIN, docsCanonical } from '../docs/.vitepress/canonical.ts';

describe('docs canonical URLs', () => {
  it('maps VitePress pages to clean docs.monkeytest.ai URLs', () => {
    expect(DOCS_ORIGIN).toBe('https://docs.monkeytest.ai');
    expect(docsCanonical('index.md')).toBe('https://docs.monkeytest.ai/');
    expect(docsCanonical('getting-started/quick-start.md')).toBe('https://docs.monkeytest.ai/getting-started/quick-start');
    expect(docsCanonical('/guides/quality.html')).toBe('https://docs.monkeytest.ai/guides/quality');
    expect(docsCanonical('getting-started/versions.md#channels')).toBe('https://docs.monkeytest.ai/getting-started/versions');
  });
});
