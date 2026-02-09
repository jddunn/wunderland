/**
 * @fileoverview News Search Tool — backward-compat re-export from agentos-extensions.
 * @deprecated Use NewsSearchTool from ToolRegistry or agentos-extensions directly.
 */

export { NewsSearchTool } from '@framers/agentos-ext-news-search';
export type {
  NewsSearchInput,
  NewsSearchOutput as NewsSearchResult,
  NewsArticle,
} from '@framers/agentos-ext-news-search';
