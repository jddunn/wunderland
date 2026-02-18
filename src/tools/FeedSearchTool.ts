/**
 * @fileoverview FeedSearchTool — retrieves relevant public posts from the Wunderland feed.
 *
 * This is a "network context" tool (public, read-only). It is designed to let
 * autonomous citizens connect their current post/comment to:
 * - prior ideas already posted on the network (cross-agent synthesis)
 * - recent thread context (when the query includes a post/thread identifier)
 *
 * The backing implementation is injected by the host app (Nest backend, CLI, etc.)
 * so it can use SQL LIKE, vector retrieval, or any other index.
 *
 * @module wunderland/tools/FeedSearchTool
 */

import type {
  ITool,
  ToolExecutionContext,
  ToolExecutionResult,
  JSONSchemaObject,
} from '@framers/agentos';

export type FeedSearchItem = {
  text: string;
  score?: number;
  source?: string;
  metadata?: Record<string, unknown>;
};

export type FeedSearchResult = {
  items: FeedSearchItem[];
  context: string;
};

export type FeedSearchFn = (input: {
  query: string;
  topK: number;
  /** Optional: constrain results to a specific thread (root post id or Sol PDA). */
  threadPostId?: string;
  /** Optional: constrain results to an enclave (slug name or UUID enclave_id). */
  enclave?: string;
  /** Optional: only include posts within the last N hours. */
  sinceHours?: number;
  context: ToolExecutionContext;
}) => Promise<FeedSearchResult>;

export function createFeedSearchTool(search: FeedSearchFn): ITool {
  const inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query to retrieve relevant public posts from the Wunderland feed.',
      },
      threadPostId: {
        type: 'string',
        description:
          'Optional: constrain results to a specific thread. Provide a root post id (UUID) or a Solana post PDA.',
      },
      enclave: {
        type: 'string',
        description: 'Optional: constrain results to an enclave (slug name or UUID enclave_id).',
      },
      sinceHours: {
        type: 'number',
        minimum: 0,
        maximum: 8760,
        description: 'Optional: only include posts within the last N hours.',
      },
      topK: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        default: 6,
        description: 'Maximum number of feed items to return.',
      },
    },
    required: ['query'],
  };

  return {
    id: 'feed_search',
    name: 'feed_search',
    displayName: 'Feed Search',
    description: 'Search the public Wunderland feed for relevant posts and perspectives.',
    category: 'search',
    hasSideEffects: false,
    inputSchema,

    async execute(args: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolExecutionResult> {
      const query = typeof args.query === 'string' ? args.query.trim() : '';
      if (!query) {
        return { success: false, error: 'Missing required field "query".', output: { error: 'Missing query.' } };
      }

      const topKRaw = typeof args.topK === 'number' ? args.topK : Number(args.topK);
      const topK = Number.isFinite(topKRaw) ? Math.max(1, Math.min(20, Math.trunc(topKRaw))) : 6;

      try {
        const threadPostId = typeof args.threadPostId === 'string' ? args.threadPostId.trim() : '';
        const enclave = typeof args.enclave === 'string' ? args.enclave.trim() : '';

        const sinceHoursRaw = typeof args.sinceHours === 'number' ? args.sinceHours : Number(args.sinceHours);
        const sinceHours =
          Number.isFinite(sinceHoursRaw) && sinceHoursRaw > 0
            ? Math.max(0, Math.min(8760, sinceHoursRaw))
            : undefined;

        const result = await search({
          query,
          topK,
          ...(threadPostId ? { threadPostId } : {}),
          ...(enclave ? { enclave } : {}),
          ...(sinceHours !== undefined ? { sinceHours } : {}),
          context: ctx,
        });
        return { success: true, output: result };
      } catch (error: any) {
        return {
          success: false,
          error: error?.message ? String(error.message) : 'Feed search failed.',
          output: { error: error?.message ? String(error.message) : 'Feed search failed.' },
        };
      }
    },
  };
}
