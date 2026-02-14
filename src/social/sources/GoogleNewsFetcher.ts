/**
 * @fileoverview Google News RSS fetcher — free, no API key required.
 * Parses the public Google News RSS feed for top headlines by topic.
 * @module wunderland/social/sources/GoogleNewsFetcher
 */

import { createHash } from 'crypto';
import type { IngestedArticle, NewsSourceType } from '../NewsFeedIngester.js';
import type { ISourceFetcher, SourceFetchConfig } from './ISourceFetcher.js';

/** Google News topic codes mapped to human-readable categories. */
const TOPIC_MAP: Record<string, string[]> = {
  WORLD: ['world', 'politics', 'international'],
  NATION: ['politics', 'domestic', 'national'],
  BUSINESS: ['business', 'finance', 'economy'],
  TECHNOLOGY: ['technology', 'tech'],
  SCIENCE: ['science', 'research'],
  HEALTH: ['health', 'medicine'],
  ENTERTAINMENT: ['entertainment', 'culture'],
};

export class GoogleNewsFetcher implements ISourceFetcher {
  readonly type = 'google-news' as NewsSourceType;

  async fetch(config: SourceFetchConfig): Promise<IngestedArticle[]> {
    // Default to multiple topics for broad coverage
    const topics = config.query?.split(',').map((t) => t.trim().toUpperCase()) ?? ['WORLD', 'BUSINESS', 'TECHNOLOGY', 'SCIENCE'];
    const maxResults = config.maxResults ?? 20;
    const perTopicLimit = Math.max(3, Math.floor(maxResults / topics.length));
    const extraCategories = config.extraCategories ?? [];

    const results = await Promise.allSettled(
      topics.map((topic) => this.fetchTopic(topic, perTopicLimit, config.timeoutMs ?? 10000, extraCategories)),
    );

    const articles: IngestedArticle[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        articles.push(...result.value);
      }
    }
    return articles;
  }

  private async fetchTopic(topic: string, limit: number, timeoutMs: number, extraCategories: string[]): Promise<IngestedArticle[]> {
    const url = `https://news.google.com/rss/topics/${encodeURIComponent(topic)}?hl=en-US&gl=US&ceid=US:en`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; WunderlandBot/1.0; +https://wunderland.sh)',
          'Accept': 'application/rss+xml, application/xml, text/xml',
        },
      });
      if (!res.ok) return [];

      const xml = await res.text();
      return this.parseRss(xml, topic, limit, extraCategories);
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseRss(xml: string, topic: string, limit: number, extraCategories: string[]): IngestedArticle[] {
    const articles: IngestedArticle[] = [];
    const items = xml.split('<item>').slice(1, limit + 1);
    const topicCategories = TOPIC_MAP[topic] ?? [topic.toLowerCase()];

    for (const item of items) {
      const title = this.extractTag(item, 'title')?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();
      const link = this.extractTag(item, 'link')?.trim();
      const pubDate = this.extractTag(item, 'pubDate')?.trim();
      const source = this.extractTag(item, 'source')?.replace(/<!\[CDATA\[(.*?)\]\]>/g, '$1').trim();

      if (title && link) {
        articles.push({
          title,
          summary: source ? `via ${source}` : '',
          url: link,
          source: 'google-news' as NewsSourceType,
          categories: ['google-news', ...topicCategories, ...extraCategories],
          publishedAt: pubDate ? new Date(pubDate) : new Date(),
          contentHash: createHash('sha256').update(`${title}::${link}`).digest('hex'),
        });
      }
    }

    return articles;
  }

  private extractTag(xml: string, tag: string): string | undefined {
    const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`));
    return match?.[1]?.trim();
  }
}
