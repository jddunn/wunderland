/**
 * @fileoverview Serper Web Search Tool — Google search via Serper.dev API.
 *
 * Enables agents to search the web for current information, news, and research.
 * Requires SERPER_API_KEY environment variable.
 *
 * @module wunderland/tools/SerperSearchTool
 */

import type { ITool, ToolExecutionContext, ToolExecutionResult, JSONSchemaObject } from '@framers/agentos';

export interface SerperSearchInput {
  query: string;
  type?: 'search' | 'news' | 'images';
  num?: number;
}

export interface SerperSearchResult {
  query: string;
  type: string;
  results: Array<{
    title: string;
    link: string;
    snippet: string;
    position?: number;
    date?: string;
    imageUrl?: string;
  }>;
  totalResults?: number;
  searchTime?: number;
}

export class SerperSearchTool implements ITool<SerperSearchInput, SerperSearchResult> {
  readonly id = 'serper-web-search-v1';
  readonly name = 'web_search';
  readonly displayName = 'Web Search';
  readonly description =
    'Search the web using Google via Serper API. Returns titles, links, and snippets ' +
    'for the top results. Supports web search, news search, and image search. ' +
    'Use this to find current information, verify facts, or research topics.';
  readonly category = 'research';
  readonly version = '1.0.0';
  readonly hasSideEffects = false;

  readonly inputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The search query string.' },
      type: {
        type: 'string',
        enum: ['search', 'news', 'images'],
        description: 'Type of search. Defaults to "search".',
        default: 'search',
      },
      num: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'Number of results to return. Defaults to 5.',
        default: 5,
      },
    },
    required: ['query'],
  };

  readonly outputSchema: JSONSchemaObject = {
    type: 'object',
    properties: {
      query: { type: 'string' },
      type: { type: 'string' },
      results: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string' },
            link: { type: 'string' },
            snippet: { type: 'string' },
          },
        },
      },
    },
  };

  readonly requiredCapabilities = ['capability:web_search'];

  private apiKey: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.SERPER_API_KEY || '';
  }

  async execute(
    args: SerperSearchInput,
    _context: ToolExecutionContext,
  ): Promise<ToolExecutionResult<SerperSearchResult>> {
    if (!this.apiKey) {
      return { success: false, error: 'SERPER_API_KEY not configured.' };
    }

    const searchType = args.type || 'search';
    const num = args.num || 5;

    try {
      const endpoint = searchType === 'news'
        ? 'https://google.serper.dev/news'
        : searchType === 'images'
          ? 'https://google.serper.dev/images'
          : 'https://google.serper.dev/search';

      const startTime = Date.now();
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: args.query, num }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Serper API error (${response.status}): ${errorText}`,
        };
      }

      const data = (await response.json()) as any;
      const searchTime = Date.now() - startTime;

      // Normalize results across search types
      let results: SerperSearchResult['results'] = [];

      if (searchType === 'news' && data.news) {
        results = data.news.slice(0, num).map((item: any, i: number) => ({
          title: item.title,
          link: item.link,
          snippet: item.snippet || item.description || '',
          position: i + 1,
          date: item.date,
        }));
      } else if (searchType === 'images' && data.images) {
        results = data.images.slice(0, num).map((item: any, i: number) => ({
          title: item.title || '',
          link: item.link || item.imageUrl,
          snippet: item.source || '',
          position: i + 1,
          imageUrl: item.imageUrl,
        }));
      } else if (data.organic) {
        results = data.organic.slice(0, num).map((item: any) => ({
          title: item.title,
          link: item.link,
          snippet: item.snippet || '',
          position: item.position,
        }));
      }

      return {
        success: true,
        output: {
          query: args.query,
          type: searchType,
          results,
          totalResults: data.searchParameters?.totalResults,
          searchTime,
        },
      };
    } catch (err: any) {
      return {
        success: false,
        error: `Web search failed: ${err.message}`,
      };
    }
  }
}
