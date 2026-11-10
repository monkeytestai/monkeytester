import { defineConfig } from 'vitepress';
import { DOCS_ORIGIN, docsCanonical } from './canonical.ts';

const description =
  'Point it at a URL. monkeytester finds the bugs, then proves you fixed them. Open-source Playwright and LLM agent.';

export default defineConfig({
  title: 'monkeytester',
  description,
  lang: 'en-US',
  cleanUrls: true,
  lastUpdated: true,
  appearance: true,
  titleTemplate: ':title · monkeytester',
  sitemap: {
    hostname: DOCS_ORIGIN,
  },
  transformHead(context) {
    return [
      ['link', { rel: 'canonical', href: docsCanonical(context.page) }],
    ];
  },

  markdown: {
    theme: { light: 'github-light', dark: 'github-dark' },
  },

  head: [
    ['link', { rel: 'icon', href: '/logo.svg', type: 'image/svg+xml' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.googleapis.com' }],
    ['link', { rel: 'preconnect', href: 'https://fonts.gstatic.com', crossorigin: '' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap',
      },
    ],
    ['meta', { name: 'theme-color', content: '#7c3aed' }],
    [
      'meta',
      {
        name: 'keywords',
        content:
          'monkeytest, monkeytester, exploratory testing, Playwright, LLM, bug finding, OpenAI, Gemini, open source',
      },
    ],
    ['meta', { property: 'og:site_name', content: 'monkeytester' }],
    ['meta', { property: 'og:title', content: 'Bugs your tests didn’t think to look for.' }],
    ['meta', { property: 'og:description', content: description }],
    ['meta', { property: 'og:image', content: 'https://docs.monkeytest.ai/og.png' }],
    ['meta', { property: 'og:image:width', content: '1280' }],
    ['meta', { property: 'og:image:height', content: '640' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:url', content: 'https://docs.monkeytest.ai/' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:title', content: 'Bugs your tests didn’t think to look for.' }],
    ['meta', { name: 'twitter:description', content: description }],
    ['meta', { name: 'twitter:image', content: 'https://docs.monkeytest.ai/og.png' }],
  ],

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'monkeytester',

    nav: [
      { text: 'Get started', link: '/getting-started/quick-start' },
      { text: 'Guides', link: '/guides/how-is-this-different', activeMatch: '/guides/' },
      { text: 'Reference', link: '/reference/cli', activeMatch: '/reference/' },
      { text: 'GitHub', link: 'https://github.com/monkeytestai/monkeytester' },
      { text: 'Cloud', link: 'https://monkeytest.ai' },
    ],

    sidebar: [
      {
        text: 'Getting started',
        items: [
          { text: 'Introduction', link: '/getting-started/introduction' },
          { text: 'Quick start', link: '/getting-started/quick-start' },
          { text: 'Installation', link: '/getting-started/installation' },
          { text: 'Your first run', link: '/getting-started/first-run' },
          { text: 'Reading the report', link: '/getting-started/reading-the-report' },
        ],
      },
      {
        text: 'Guides',
        items: [
          { text: 'How is this different?', link: '/guides/how-is-this-different' },
          { text: 'CI', link: '/guides/ci' },
          { text: 'Rerun and diff', link: '/guides/rerun-and-diff' },
          { text: 'Auth and login-only sites', link: '/guides/auth' },
          { text: 'Sign-up testing', link: '/guides/signup' },
          { text: 'LLM providers', link: '/guides/llm-providers' },
          { text: 'Cost and depth', link: '/guides/cost-and-depth' },
          { text: 'Docker', link: '/guides/docker' },
          { text: 'How it works', link: '/guides/how-it-works' },
          { text: 'Recipes', link: '/guides/recipes' },
          { text: 'Live events', link: '/guides/live-events' },
          { text: 'Prompt caching', link: '/guides/prompt-caching' },
          { text: 'Triager', link: '/guides/triager' },
          { text: 'License', link: '/guides/license' },
          { text: 'Publishing docs', link: '/guides/publishing-docs' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/reference/cli' },
          { text: 'Config', link: '/reference/config' },
          { text: 'Programmatic API', link: '/reference/api' },
          { text: 'Report', link: '/reference/report' },
          { text: 'Events', link: '/reference/events' },
        ],
      },
      {
        text: 'Help',
        items: [
          { text: 'FAQ and troubleshooting', link: '/troubleshooting' },
          { text: 'Changelog', link: '/changelog' },
        ],
      },
    ],

    socialLinks: [
      { icon: 'github', link: 'https://github.com/monkeytestai/monkeytester' },
    ],

    footer: {
      message: 'AGPL-3.0-only',
      copyright: 'Copyright © MonkeyTest contributors',
    },

    search: { provider: 'local' },

    outline: { level: [2, 3] },

    editLink: {
      pattern: 'https://github.com/monkeytestai/monkeytester/edit/main/docs/:path',
      text: 'Edit this page',
    },

    lastUpdated: { text: 'Updated' },

    docFooter: {
      prev: 'Previous',
      next: 'Next',
    },
  },
});
