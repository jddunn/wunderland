import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/**/*.integration.test.ts',
      'src/**/*.e2e.test.ts',
      'src/__tests__/cli-*.test.ts',
      'src/__tests__/OpenRouterFallback.test.ts',
      'node_modules/**',
    ],
    server: {
      deps: {
        inline: [
          '@framers/agentos-ext-web-search',
          '@framers/agentos-ext-web-browser',
          '@framers/agentos-ext-giphy',
          '@framers/agentos-ext-image-search',
          '@framers/agentos-ext-news-search',
          '@framers/agentos-ext-voice-synthesis',
          '@framers/agentos-ext-cli-executor',
          '@framers/agentos-extensions-registry',
        ],
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/cli/**',
        'src/index.ts',
      ],
    },
  },
});
