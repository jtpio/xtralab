// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

// https://astro.build/config
export default defineConfig({
  site: 'https://jtpio.github.io',
  base: '/xtralab',
  integrations: [
    starlight({
      title: 'xtralab',
      description: 'An opinionated JupyterLab meta-package for coding agents.',
      favicon: '/favicon.svg',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/jtpio/xtralab'
        }
      ],
      editLink: {
        baseUrl: 'https://github.com/jtpio/xtralab/edit/main/docs/'
      },
      customCss: ['./src/styles/custom.css'],
      sidebar: [
        {
          label: 'Start here',
          items: [
            { label: 'Installation', slug: 'installation' },
            { label: 'Getting started', slug: 'getting-started' },
            { label: 'Desktop app', slug: 'desktop' }
          ]
        },
        {
          label: 'Features',
          items: [
            { label: 'Agent launcher', slug: 'features/launcher' },
            { label: 'Git diffs', slug: 'features/git-diffs' },
            { label: 'Ask an agent', slug: 'features/ask-agent' },
            { label: 'Omnibox', slug: 'features/omnibox' },
            { label: 'Terminals', slug: 'features/terminals' },
            { label: 'Defaults and themes', slug: 'features/defaults' }
          ]
        },
        {
          label: 'Agents',
          items: [
            { label: 'Connect agents with MCP', slug: 'agents/mcp' },
            { label: 'Agent skills', slug: 'agents/skills' }
          ]
        },
        {
          label: 'Customize',
          items: [
            { label: 'Launcher entries', slug: 'customize/launcher' },
            { label: 'Language servers', slug: 'customize/language-servers' }
          ]
        }
      ]
    })
  ]
});
