/**
 * @fileoverview Reddit source fetcher via public JSON API.
 * Supports single subreddit or multi-subreddit fetching.
 * @module wunderland/social/sources/RedditFetcher
 */

import { createHash } from 'crypto';
import type { IngestedArticle } from '../NewsFeedIngester.js';
import type { ISourceFetcher, SourceFetchConfig } from './ISourceFetcher.js';

export class RedditFetcher implements ISourceFetcher {
  readonly type = 'reddit' as const;

  async fetch(config: SourceFetchConfig): Promise<IngestedArticle[]> {
    const subreddits = config.subreddits ?? [config.subreddit ?? 'artificial'];
    const perSubLimit = Math.max(5, Math.floor((config.maxResults ?? 25) / subreddits.length));
    const extraCategories = config.extraCategories ?? [];

    const results = await Promise.allSettled(
      subreddits.map((sub) => this.fetchSubreddit(sub, perSubLimit, config.timeoutMs ?? 10000, extraCategories)),
    );

    const articles: IngestedArticle[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        articles.push(...result.value);
      }
    }
    return articles;
  }

  private async fetchSubreddit(subreddit: string, limit: number, timeoutMs: number, extraCategories: string[]): Promise<IngestedArticle[]> {
    // Use old.reddit.com .json suffix — less aggressive blocking than www.reddit.com
    const url = `https://old.reddit.com/r/${subreddit}/hot.json?limit=${limit}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WunderlandBot/1.0; +https://wunderland.sh)',
          'Accept': 'application/json',
        },
      });
      if (!res.ok) return [];

      const data = await res.json() as { data?: { children?: Array<{ data: { title: string; selftext: string; url: string; subreddit: string; ups: number; created_utc: number; permalink: string; num_comments: number; link_flair_text: string } }> } };
      if (!data.data?.children) return [];

      return data.data.children
        .filter((c) => c.data.title)
        .map((child) => {
          const d = child.data;
          const postUrl = d.url || `https://www.reddit.com${d.permalink}`;
          const categories = [d.subreddit, 'reddit', ...extraCategories];
          if (d.link_flair_text) categories.push(d.link_flair_text.toLowerCase());
          return {
            title: d.title,
            summary: d.selftext?.slice(0, 500) || `${d.ups} upvotes, ${d.num_comments ?? 0} comments on r/${d.subreddit}`,
            url: postUrl,
            source: 'reddit' as const,
            categories,
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
