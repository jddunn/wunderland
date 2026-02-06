/**
 * @fileoverview News Search Tool — backward-compat re-export from agentos-extensions.
 * @deprecated Use NewsSearchTool from ToolRegistry or agentos-extensions directly.
 */

export { NewsSearchTool } from '../../../agentos-extensions/registry/curated/research/news-search/src/tools/newsSearch.js';
export type {
  NewsSearchInput,
  NewsSearchOutput as NewsSearchResult,
  NewsArticle,
} from '../../../agentos-extensions/registry/curated/research/news-search/src/tools/newsSearch.js';
