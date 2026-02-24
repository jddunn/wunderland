import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Cross-package alias for @framers/agentos/auth (only available in monorepo)
const agentosAuthPath = resolve(__dirname, '../agentos/src/core/llm/auth/index.ts');
const hasAgentosAuth = existsSync(agentosAuthPath);

export default defineConfig({
  resolve: {
    alias: hasAgentosAuth ? {
      '@framers/agentos/auth': agentosAuthPath,
    } : {},
  },
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/**/*.integration.test.ts',
      'src/**/*.e2e.test.ts',
      'src/__tests__/cli-*.test.ts',
      'src/__tests__/OpenRouterFallback.test.ts',
      'node_modules/**',
      // OAuth tests require @framers/agentos sibling (not available in standalone CI)
      ...(hasAgentosAuth ? [] : [
        'src/__tests__/file-token-store.test.ts',
        'src/__tests__/openai-oauth-flow.test.ts',
      ]),
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
