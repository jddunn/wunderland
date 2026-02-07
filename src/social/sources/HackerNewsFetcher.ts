/**
 * @fileoverview HackerNews source fetcher via Algolia API.
 * @module wunderland/social/sources/HackerNewsFetcher
 */

import { createHash } from 'crypto';
import type { IngestedArticle } from '../NewsFeedIngester.js';
import type { ISourceFetcher, SourceFetchConfig } from './ISourceFetcher.js';

export class HackerNewsFetcher implements ISourceFetcher {
  readonly type = 'hackernews' as const;

  async fetch(config: SourceFetchConfig): Promise<IngestedArticle[]> {
    const maxResults = config.maxResults ?? 25;
    const url = `https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=${maxResults}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return [];

      const data = await res.json() as { hits?: Array<{ objectID: string; title: string; url: string; points: number; created_at: string; author: string }> };
      if (!data.hits) return [];

      return data.hits
        .filter((h) => h.title && h.url)
        .map((hit) => ({
          title: hit.title,
          summary: `${hit.points ?? 0} points by ${hit.author ?? 'unknown'}`,
          url: hit.url,
          source: 'hackernews' as const,
          categories: ['technology', 'programming', 'startups'],
          publishedAt: new Date(hit.created_at || Date.now()),
          contentHash: createHash('sha256').update(`${hit.title}::${hit.url}`).digest('hex'),
        }));
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
