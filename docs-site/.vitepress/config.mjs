import { defineConfig } from 'vitepress'

export default defineConfig({
  title: 'clomp',
  description: 'A tamper-evident audit trail for security work — prove it, don\'t just claim it.',
  base: '/clomp/',
  lang: 'en-US',
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: [/^http:\/\/localhost/],

  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/clomp/logo.svg' }],
    ['meta', { property: 'og:type', content: 'website' }],
    ['meta', { property: 'og:title', content: 'clomp — a tamper-evident audit trail for security work' }],
    ['meta', { property: 'og:description', content: 'Prove — not just claim — that your security activities happen. Append-only, hash-chained, verifiable offline. Built for SOC 2 and NIS2 evidence.' }],
    ['meta', { property: 'og:image', content: 'https://sockulags.github.io/clomp/og-image.png' }],
    ['meta', { property: 'og:url', content: 'https://sockulags.github.io/clomp/' }],
    ['meta', { name: 'twitter:card', content: 'summary_large_image' }],
    ['meta', { name: 'twitter:image', content: 'https://sockulags.github.io/clomp/og-image.png' }]
  ],

  themeConfig: {
    logo: '/logo.svg',

    nav: [
      { text: 'Guide', link: '/guide/getting-started', activeMatch: '/guide/' },
      { text: 'Operations', link: '/operations/deployment', activeMatch: '/operations/' },
      { text: 'Reference', link: '/reference/rest-api', activeMatch: '/reference/' },
      {
        text: 'v0.2.0-alpha',
        items: [
          { text: 'Releases', link: 'https://github.com/sockulags/clomp/releases' },
          { text: 'Changelog', link: 'https://github.com/sockulags/clomp/commits/main' }
        ]
      }
    ],

    sidebar: {
      '/guide/': [
        {
          text: 'Introduction',
          items: [
            { text: 'What is clomp?', link: '/guide/what-is-clomp' },
            { text: 'How clomp compares', link: '/guide/comparison' },
            { text: 'Getting started', link: '/guide/getting-started' }
          ]
        },
        {
          text: 'Using clomp',
          items: [
            { text: 'Recording events', link: '/guide/recording-events' },
            { text: 'Scheduled controls', link: '/guide/scheduled-controls' },
            { text: 'Evidence files', link: '/guide/evidence' },
            { text: 'Verification', link: '/guide/verification' },
            { text: 'Exports & reports', link: '/guide/exports' }
          ]
        }
      ],
      '/operations/': [
        {
          text: 'Operations',
          items: [
            { text: 'Deployment', link: '/operations/deployment' },
            { text: 'Users & authentication', link: '/operations/authentication' },
            { text: 'External anchoring', link: '/operations/anchoring' },
            { text: 'Integrations', link: '/operations/integrations' },
            { text: 'Retention', link: '/operations/retention' },
            { text: 'GDPR & personal data', link: '/operations/gdpr' },
            { text: 'Backup & restore', link: '/operations/backup' }
          ]
        }
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'REST API', link: '/reference/rest-api' },
            { text: 'CLI', link: '/reference/cli' },
            { text: 'Node.js SDK', link: '/reference/sdk' },
            { text: 'Action catalog', link: '/reference/action-catalog' },
            { text: 'Hash chain specification', link: '/reference/hash-chain' },
            { text: 'Threat model', link: '/reference/threat-model' },
            { text: 'Configuration', link: '/reference/configuration' }
          ]
        }
      ]
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/sockulags/clomp' }
    ],

    footer: {
      message: 'Released under the MIT License. No paywalls, no open-core.',
      copyright: 'Copyright © 2026 Lucas Skog'
    },

    search: { provider: 'local' },

    editLink: {
      pattern: 'https://github.com/sockulags/clomp/edit/main/docs-site/:path',
      text: 'Edit this page on GitHub'
    }
  }
})
