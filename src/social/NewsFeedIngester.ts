/**
 * @fileoverview NewsFeedIngester — external news source integration framework.
 *
 * Provides a pluggable architecture for polling external news APIs and routing
 * ingested articles to matching enclaves. Source-specific fetch implementations
 * are stubbed for future integration.
 *
 * @module wunderland/social/NewsFeedIngester
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import type { EnclaveRegistry } from './EnclaveRegistry.js';
import type { ISourceFetcher } from './sources/ISourceFetcher.js';

// ============================================================================
// Types
// ============================================================================

/** Supported external news source types. */
export type NewsSourceType = 'newsapi' | 'reddit' | 'hackernews' | 'arxiv' | 'semantic-scholar' | 'serper';

/** Configuration for a registered news source. */
export interface NewsSource {
  /** Human-readable source name */
  name: string;
  /** Source type (determines fetch strategy) */
  type: NewsSourceType;
  /** Polling interval in milliseconds */
  pollIntervalMs: number;
  /** Whether this source is currently enabled */
  enabled: boolean;
}

/** An article ingested from an external source. */
export interface IngestedArticle {
  /** Article title */
  title: string;
  /** Brief summary or description */
  summary: string;
  /** Original source URL */
  url: string;
  /** Which source type produced this article */
  source: NewsSourceType;
  /** Topic categories for routing */
  categories: string[];
  /** When the article was originally published */
  publishedAt: Date;
  /** SHA-256 hash of title+url for deduplication */
  contentHash: string;
}

// ============================================================================
// NewsFeedIngester
// ============================================================================

/**
 * Polls external news sources and routes articles to matching enclaves.
 *
 * Currently provides a stub framework — actual API integrations are marked with
 * TODO comments for each source type.
 *
 * @example
 * ```typescript
 * const ingester = new NewsFeedIngester();
 * ingester.registerSource({
 *   name: 'HackerNews',
 *   type: 'hackernews',
 *   pollIntervalMs: 300000,
 *   enabled: true,
 * });
 *
 * ingester.on('article_ingested', (article) => {
 *   console.log(`New article: ${article.title}`);
 * });
 *
 * const articles = await ingester.pollSource('HackerNews');
 * ```
 */
export class NewsFeedIngester extends EventEmitter {
  /** Registered sources by name. */
  private sources: Map<string, NewsSource> = new Map();

  /** In-memory buffer of ingested articles. */
  private articles: IngestedArticle[] = [];

  /** Set of content hashes for deduplication. */
  private seenHashes: Set<string> = new Set();

  /** Pluggable source fetchers keyed by source type. */
  private fetchers: Map<NewsSourceType, ISourceFetcher> = new Map();

  /**
   * Register a new external news source.
   * @throws If a source with the same name is already registered.
   */
  registerSource(source: NewsSource): void {
    if (this.sources.has(source.name)) {
      throw new Error(`News source '${source.name}' is already registered.`);
    }
    this.sources.set(source.name, source);
  }

  /**
   * Register a pluggable source fetcher. Replaces any existing fetcher for that type.
   */
  registerFetcher(fetcher: ISourceFetcher): void {
    this.fetchers.set(fetcher.type, fetcher);
  }

  /**
   * Poll a registered source for new articles.
   *
   * Currently returns an empty array for all source types.
   * Each source type has a TODO for its specific API integration.
   *
   * @param sourceName  Name of the registered source to poll.
   * @returns Array of newly ingested articles (deduplicated).
   */
  async pollSource(sourceName: string): Promise<IngestedArticle[]> {
    const source = this.sources.get(sourceName);
    if (!source) {
      throw new Error(`News source '${sourceName}' is not registered.`);
    }

    if (!source.enabled) {
      return [];
    }

    let rawArticles: IngestedArticle[] = [];

    const fetcher = this.fetchers.get(source.type);
    if (fetcher) {
      try {
        rawArticles = await fetcher.fetch({
          maxResults: 25,
          timeoutMs: 15000,
          ...(source as any).fetchConfig,
        });
      } catch {
        rawArticles = [];
      }
    }

    // Deduplicate and buffer
    const newArticles = this.deduplicateAndBuffer(rawArticles);

    // Emit events for each new article
    for (const article of newArticles) {
      this.emit('article_ingested', article);
    }

    return newArticles;
  }

  /**
   * Retrieve buffered articles with optional filtering.
   *
   * @param opts.source    Filter by source type.
   * @param opts.category  Filter by category (article must include this category).
   * @param opts.limit     Maximum number of articles to return.
   */
  getArticles(opts?: { source?: string; category?: string; limit?: number }): IngestedArticle[] {
    let filtered = this.articles;

    if (opts?.source) {
      filtered = filtered.filter((a) => a.source === opts.source);
    }

    if (opts?.category) {
      const cat = opts.category.toLowerCase();
      filtered = filtered.filter((a) =>
        a.categories.some((c) => c.toLowerCase() === cat),
      );
    }

    if (opts?.limit && opts.limit > 0) {
      filtered = filtered.slice(0, opts.limit);
    }

    return filtered;
  }

  /**
   * Route an article to enclaves whose tags overlap with the article's categories.
   *
   * @param article   The article to route.
   * @param registry  The EnclaveRegistry to match against.
   * @returns Array of matching enclave names.
   */
  routeToEnclaves(article: IngestedArticle, registry: EnclaveRegistry): string[] {
    const matchingEnclaves = registry.matchEnclavesByTags(article.categories);
    return matchingEnclaves.map((enc) => enc.name);
  }

  /**
   * @deprecated Use routeToEnclaves instead.
   */
  routeToSubreddits(article: IngestedArticle, registry: EnclaveRegistry): string[] {
    return this.routeToEnclaves(article, registry);
  }

  /** Get a registered source by name. */
  getSource(name: string): NewsSource | undefined {
    return this.sources.get(name);
  }

  /** List all registered sources. */
  listSources(): NewsSource[] {
    return [...this.sources.values()];
  }

  // ── Internal ──

  /**
   * Deduplicate articles by content hash and append new ones to the buffer.
   */
  private deduplicateAndBuffer(articles: IngestedArticle[]): IngestedArticle[] {
    const newArticles: IngestedArticle[] = [];

    for (const article of articles) {
      const hash = article.contentHash || computeContentHash(article.title, article.url);
      if (!this.seenHashes.has(hash)) {
        this.seenHashes.add(hash);
        const articleWithHash = { ...article, contentHash: hash };
        this.articles.push(articleWithHash);
        newArticles.push(articleWithHash);
      }
    }

    return newArticles;
  }
}

// ============================================================================
// Helpers
// ============================================================================

/** Compute a SHA-256 content hash from title + URL for deduplication. */
function computeContentHash(title: string, url: string): string {
  return createHash('sha256').update(`${title}::${url}`).digest('hex');
}
