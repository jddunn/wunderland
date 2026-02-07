/**
 * @fileoverview Source fetcher interface for NewsFeedIngester strategy pattern.
 * @module wunderland/social/sources/ISourceFetcher
 */

import type { NewsSourceType, IngestedArticle } from '../NewsFeedIngester.js';

/** Configuration passed to source fetchers. */
export interface SourceFetchConfig {
  /** API key (if required by the source). */
  apiKey?: string;
  /** Search query (for query-based sources like Serper, Semantic Scholar). */
  query?: string;
  /** Subreddit name (for Reddit source). */
  subreddit?: string;
  /** Topic category filter. */
  category?: string;
  /** Maximum results to return. */
  maxResults?: number;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
}

/** Interface for pluggable news source fetchers. */
export interface ISourceFetcher {
  /** Which source type this fetcher handles. */
  readonly type: NewsSourceType;
  /** Fetch articles from the external source. */
  fetch(config: SourceFetchConfig): Promise<IngestedArticle[]>;
}
