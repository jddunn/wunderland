import type { ITool, ToolExecutionContext } from '@framers/agentos';

import type { WunderlandAgentConfig } from '../api/types.js';
import { createMemoryReadTool, type MemoryReadResult } from '../tools/MemoryReadTool.js';
import { RAGTool } from '../tools/RAGTool.js';
import { WunderlandRAGClient, type RAGQueryInput } from './rag-client.js';

function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveRagBackendUrl(config: WunderlandAgentConfig): string | null {
  if (config.rag?.enabled !== true) return null;

  const value =
    config.rag.backendUrl
    ?? process.env['WUNDERLAND_BACKEND_URL']
    ?? process.env['NEXT_PUBLIC_API_URL']
    ?? 'http://localhost:3001';

  return hasText(value) ? value.trim() : null;
}

function resolveRagAuthToken(config: WunderlandAgentConfig): string | undefined {
  if (hasText(config.rag?.authToken)) return config.rag.authToken.trim();
  if (hasText(config.rag?.authTokenEnvVar)) {
    const fromEnv = process.env[config.rag.authTokenEnvVar.trim()];
    if (hasText(fromEnv)) return fromEnv.trim();
  }
  return undefined;
}

function buildBaseQueryInput(
  config: WunderlandAgentConfig,
  input: { query: string; topK?: number; collectionIds?: string[] },
  _context?: ToolExecutionContext,
): RAGQueryInput {
  const defaultCollectionIds =
    input.collectionIds
    ?? (config.rag?.collectionIds && config.rag.collectionIds.length > 0
      ? config.rag.collectionIds
      : hasText(config.rag?.defaultCollectionId)
        ? [config.rag.defaultCollectionId.trim()]
        : undefined);

  return {
    query: input.query,
    topK: input.topK ?? config.rag?.defaultTopK ?? 6,
    collectionIds: defaultCollectionIds,
    preset: config.rag?.preset,
    includeAudit: config.rag?.includeAudit,
    includeGraphRag: config.rag?.includeGraphRag,
    debug: config.rag?.includeDebug,
    similarityThreshold: config.rag?.similarityThreshold,
    filters: config.rag?.filters,
    includeMetadata: config.rag?.includeMetadata,
    strategy: config.rag?.strategy,
    strategyParams: config.rag?.strategyParams,
    queryVariants: config.rag?.queryVariants,
    rewrite: config.rag?.rewrite,
  };
}

function formatMemoryContext(result: MemoryReadResult): string {
  if (result.items.length === 0) return 'No relevant long-term memory found.';
  return result.items
    .map((item, index) => {
      const source = hasText(item.source) ? ` (${item.source})` : '';
      const score = typeof item.score === 'number' ? ` [score ${(item.score * 100).toFixed(0)}%]` : '';
      return `[${index + 1}]${source}${score}\n${item.text}`;
    })
    .join('\n\n');
}

export function createConfiguredRagTools(config: WunderlandAgentConfig): ITool[] {
  const backendUrl = resolveRagBackendUrl(config);
  if (!backendUrl) return [];

  const authToken = resolveRagAuthToken(config);
  const client = new WunderlandRAGClient({ baseUrl: backendUrl, authToken });
  const tools: ITool[] = [];

  const exposeMemoryRead = config.rag?.exposeMemoryRead !== false;
  const exposeRagQuery = config.rag?.exposeRagQuery !== false;

  if (exposeMemoryRead) {
    tools.push(
      createMemoryReadTool(async ({ query, topK, context }) => {
        const response = await client.query(buildBaseQueryInput(config, { query, topK }, context));
        const items = (response.chunks ?? []).map((chunk) => ({
          text: chunk.content,
          score: chunk.score,
          source:
            (typeof chunk.metadata?.source === 'string' && chunk.metadata.source)
            || chunk.documentId
            || chunk.chunkId,
          metadata: chunk.metadata,
        }));

        const result: MemoryReadResult = {
          items,
          context: '',
        };
        result.context = formatMemoryContext(result);
        return result;
      }),
    );
  }

  if (exposeRagQuery) {
    tools.push(
      new RAGTool({
        backendUrl,
        authToken,
        seedId: hasText(config.seedId) ? config.seedId.trim() : undefined,
        defaultTopK: config.rag?.defaultTopK,
        defaultCollectionIds:
          config.rag?.collectionIds
          ?? (hasText(config.rag?.defaultCollectionId) ? [config.rag.defaultCollectionId.trim()] : undefined),
        preset: config.rag?.preset,
        includeAudit: config.rag?.includeAudit,
        includeGraphRag: config.rag?.includeGraphRag,
        includeDebug: config.rag?.includeDebug,
        queryVariants: config.rag?.queryVariants,
        rewrite: config.rag?.rewrite,
        strategy: config.rag?.strategy,
        strategyParams: config.rag?.strategyParams,
        similarityThreshold: config.rag?.similarityThreshold,
        filters: config.rag?.filters,
        includeMetadata: config.rag?.includeMetadata,
      }),
    );
  }

  return tools;
}
