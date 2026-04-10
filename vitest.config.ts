// @ts-nocheck
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

// Cross-package aliases for @framers/agentos sub-packages (only available in monorepo)
const agentosAuthPath = resolve(__dirname, '../agentos/src/core/llm/auth/index.ts');
const agentosRagPath = resolve(__dirname, '../agentos/src/rag/index.ts');
const agentosQueryRouterPath = resolve(__dirname, '../agentos/src/query-router/index.ts');
const agentosMemoryPath = resolve(__dirname, '../agentos/src/memory/index.ts');
const agentosOrchestrationPath = resolve(__dirname, '../agentos/src/orchestration/index.ts');
const agentosOrchestrationRuntimeKernelPath = resolve(__dirname, '../agentos/src/orchestration/runtime-kernel.ts');
const agentosRootPath = resolve(__dirname, '../agentos/src/index.ts');
const agentosOrchestrationIrTypesPath = resolve(__dirname, '../agentos/src/orchestration/ir/types.ts');
const agentosOrchestrationGraphEventPath = resolve(__dirname, '../agentos/src/orchestration/events/GraphEvent.ts');
const agentosOrchestrationCheckpointInterfacePath = resolve(__dirname, '../agentos/src/orchestration/checkpoint/ICheckpointStore.ts');
const agentosOrchestrationInMemoryCheckpointPath = resolve(__dirname, '../agentos/src/orchestration/checkpoint/InMemoryCheckpointStore.ts');
const agentosOrchestrationGraphRuntimePath = resolve(__dirname, '../agentos/src/orchestration/runtime/GraphRuntime.ts');
const agentosOrchestrationNodeExecutorPath = resolve(__dirname, '../agentos/src/orchestration/runtime/NodeExecutor.ts');
const hasAgentosAuth = existsSync(agentosAuthPath);
const hasAgentosRoot = existsSync(agentosRootPath);

const agentosAliases: Record<string, string> = {};
if (hasAgentosAuth) agentosAliases['@framers/agentos/auth'] = agentosAuthPath;
if (hasAgentosRoot) {
  agentosAliases['@framers/agentos/rag'] = agentosRagPath;
  agentosAliases['@framers/agentos/query-router'] = agentosQueryRouterPath;
  agentosAliases['@framers/agentos/memory'] = agentosMemoryPath;
  agentosAliases['@framers/agentos/orchestration'] = agentosOrchestrationPath;
  agentosAliases['@framers/agentos/orchestration/runtime-kernel'] = agentosOrchestrationRuntimeKernelPath;
  agentosAliases['@framers/agentos/orchestration/ir/types'] = agentosOrchestrationIrTypesPath;
  agentosAliases['@framers/agentos/orchestration/events/GraphEvent'] = agentosOrchestrationGraphEventPath;
  agentosAliases['@framers/agentos/orchestration/checkpoint/ICheckpointStore'] = agentosOrchestrationCheckpointInterfacePath;
  agentosAliases['@framers/agentos/orchestration/checkpoint/InMemoryCheckpointStore'] = agentosOrchestrationInMemoryCheckpointPath;
  agentosAliases['@framers/agentos/orchestration/runtime/GraphRuntime'] = agentosOrchestrationGraphRuntimePath;
  agentosAliases['@framers/agentos/orchestration/runtime/NodeExecutor'] = agentosOrchestrationNodeExecutorPath;
  agentosAliases['@framers/agentos'] = agentosRootPath;
}

const agentosSourceDir = resolve(__dirname, '../agentos/src');

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export default defineConfig({
  resolve: {
    alias: [
      ...Object.entries(agentosAliases).map(([find, replacement]) => ({
        find: new RegExp(`^${escapeRegExp(find)}$`),
        replacement,
      })),
      {
        find: '@framers/agentos',
        replacement: agentosSourceDir,
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
          /^@framers\/agentos(?:\/.*)?$/,
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
