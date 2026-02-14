/**
 * @fileoverview Reddit source fetcher via public JSON API.
 * @module wunderland/social/sources/RedditFetcher
 */

import { createHash } from 'crypto';
import type { IngestedArticle } from '../NewsFeedIngester.js';
import type { ISourceFetcher, SourceFetchConfig } from './ISourceFetcher.js';

export class RedditFetcher implements ISourceFetcher {
  readonly type = 'reddit' as const;

  async fetch(config: SourceFetchConfig): Promise<IngestedArticle[]> {
    const subreddit = config.subreddit ?? 'artificial';
    const maxResults = config.maxResults ?? 25;
    // Use old.reddit.com — less aggressive blocking than www.reddit.com
    const url = `https://old.reddit.com/r/${subreddit}/hot.json?limit=${maxResults}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 10000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WunderlandBot/1.0; +https://wunderland.sh)',
          'Accept': 'application/json',
        },
      });
      if (!res.ok) return [];

      const data = await res.json() as { data?: { children?: Array<{ data: { title: string; selftext: string; url: string; subreddit: string; ups: number; created_utc: number; permalink: string } }> } };
      if (!data.data?.children) return [];

      return data.data.children
        .filter((c) => c.data.title)
        .map((child) => {
          const d = child.data;
          const postUrl = d.url || `https://www.reddit.com${d.permalink}`;
          return {
            title: d.title,
            summary: d.selftext?.slice(0, 300) || `${d.ups} upvotes on r/${d.subreddit}`,
            url: postUrl,
            source: 'reddit' as const,
            categories: [d.subreddit, 'reddit'],
            publishedAt: new Date((d.created_utc || Date.now() / 1000) * 1000),
            contentHash: createHash('sha256').update(`${d.title}::${postUrl}`).digest('hex'),
          };
        });
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
