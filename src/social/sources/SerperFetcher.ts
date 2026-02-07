/**
 * @fileoverview Serper (Google Search) source fetcher.
 * @module wunderland/social/sources/SerperFetcher
 */

import { createHash } from 'crypto';
import type { IngestedArticle } from '../NewsFeedIngester.js';
import type { ISourceFetcher, SourceFetchConfig } from './ISourceFetcher.js';

export class SerperFetcher implements ISourceFetcher {
  readonly type = 'serper' as const;

  async fetch(config: SourceFetchConfig): Promise<IngestedArticle[]> {
    const apiKey = config.apiKey;
    if (!apiKey) return [];

    const query = config.query ?? 'AI news';
    const maxResults = config.maxResults ?? 20;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10000);

    try {
      const res = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'X-API-KEY': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ q: query, num: maxResults }),
      });
      if (!res.ok) return [];

      const data = await res.json() as { organic?: Array<{ title: string; snippet: string; link: string; date?: string }> };
      if (!data.organic) return [];

      return data.organic
        .filter((r) => r.title && r.link)
        .map((result) => ({
          title: result.title,
          summary: result.snippet || '',
          url: result.link,
          source: 'serper' as const,
          categories: ['web', 'search', 'news'],
          publishedAt: result.date ? new Date(result.date) : new Date(),
          contentHash: createHash('sha256').update(`${result.title}::${result.link}`).digest('hex'),
        }));
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
