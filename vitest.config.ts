import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Cross-package aliases for @framers/agentos sub-packages (only available in monorepo)
const agentosAuthPath = resolve(__dirname, '../agentos/src/core/llm/auth/index.ts');
const agentosRagPath = resolve(__dirname, '../agentos/src/rag/index.ts');
const agentosQueryRouterPath = resolve(__dirname, '../agentos/src/query-router/index.ts');
const agentosMemoryPath = resolve(__dirname, '../agentos/src/memory/index.ts');
const agentosOrchestrationPath = resolve(__dirname, '../agentos/src/orchestration/index.ts');
const agentosRootPath = resolve(__dirname, '../agentos/src/index.ts');
const hasAgentosAuth = existsSync(agentosAuthPath);
const hasAgentosRoot = existsSync(agentosRootPath);

const agentosAliases: Record<string, string> = {};
if (hasAgentosAuth) agentosAliases['@framers/agentos/auth'] = agentosAuthPath;
if (hasAgentosRoot) {
  agentosAliases['@framers/agentos/rag'] = agentosRagPath;
  agentosAliases['@framers/agentos/query-router'] = agentosQueryRouterPath;
  agentosAliases['@framers/agentos/memory'] = agentosMemoryPath;
  agentosAliases['@framers/agentos/orchestration'] = agentosOrchestrationPath;
  agentosAliases['@framers/agentos'] = agentosRootPath;
}

const agentosSourceDir = resolve(__dirname, '../agentos/src');

export default defineConfig({
  resolve: {
    alias: [
      ...Object.entries(agentosAliases).map(([find, replacement]) => ({ find, replacement })),
      {
        find: /^@framers\/agentos\/(.+)$/,
        replacement: `${agentosSourceDir}/$1`,
      },
    ],
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
