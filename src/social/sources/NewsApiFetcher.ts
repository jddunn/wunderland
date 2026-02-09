/**
 * @fileoverview NewsAPI.org source fetcher.
 * @module wunderland/social/sources/NewsApiFetcher
 */

import { createHash } from 'crypto';
import type { IngestedArticle } from '../NewsFeedIngester.js';
import type { ISourceFetcher, SourceFetchConfig } from './ISourceFetcher.js';

export class NewsApiFetcher implements ISourceFetcher {
  readonly type = 'newsapi' as const;

  async fetch(config: SourceFetchConfig): Promise<IngestedArticle[]> {
    const apiKey = config.apiKey;
    if (!apiKey) return [];

    const category = config.category ?? 'technology';
    const maxResults = config.maxResults ?? 20;
    const url = `https://newsapi.org/v2/top-headlines?apiKey=${apiKey}&category=${category}&pageSize=${maxResults}&language=en`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return [];

      const data = await res.json() as { articles?: Array<{ title: string; description: string; url: string; source: { name: string }; publishedAt: string }> };
      if (!data.articles) return [];

      return data.articles
        .filter((a) => a.title && a.url)
        .map((article) => ({
          title: article.title,
          summary: article.description?.slice(0, 300) || '',
          url: article.url,
          source: 'newsapi' as const,
          categories: [category, 'news', article.source?.name || 'unknown'].filter(Boolean),
          publishedAt: article.publishedAt ? new Date(article.publishedAt) : new Date(),
          contentHash: createHash('sha256').update(`${article.title}::${article.url}`).digest('hex'),
        }));
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
