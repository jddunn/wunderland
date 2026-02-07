/**
 * @fileoverview arXiv source fetcher via Atom XML API.
 * @module wunderland/social/sources/ArxivFetcher
 */

import { createHash } from 'crypto';
import type { IngestedArticle } from '../NewsFeedIngester.js';
import type { ISourceFetcher, SourceFetchConfig } from './ISourceFetcher.js';

export class ArxivFetcher implements ISourceFetcher {
  readonly type = 'arxiv' as const;

  async fetch(config: SourceFetchConfig): Promise<IngestedArticle[]> {
    const query = config.query ?? 'cat:cs.AI';
    const maxResults = config.maxResults ?? 20;
    const url = `http://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15000);

    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return [];

      const xml = await res.text();
      return this.parseAtomFeed(xml);
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseAtomFeed(xml: string): IngestedArticle[] {
    const articles: IngestedArticle[] = [];
    const entries = xml.split('<entry>').slice(1);

    for (const entry of entries) {
      const title = this.extractTag(entry, 'title')?.replace(/\s+/g, ' ').trim();
      const summary = this.extractTag(entry, 'summary')?.replace(/\s+/g, ' ').trim().slice(0, 500);
      const published = this.extractTag(entry, 'published');
      const idTag = this.extractTag(entry, 'id');

      // Extract PDF/abs link
      const linkMatch = entry.match(/<link[^>]+href="([^"]+)"[^>]*title="pdf"/);
      const absMatch = entry.match(/<link[^>]+href="([^"]+)"[^>]*type="text\/html"/);
      const url = linkMatch?.[1] || absMatch?.[1] || idTag || '';

      // Extract categories
      const categories: string[] = ['arxiv', 'research'];
      const catMatches = entry.matchAll(/term="([^"]+)"/g);
      for (const m of catMatches) {
        categories.push(m[1]);
      }

      if (title && url) {
        articles.push({
          title,
          summary: summary || '',
          url,
          source: 'arxiv',
          categories,
          publishedAt: published ? new Date(published) : new Date(),
          contentHash: createHash('sha256').update(`${title}::${url}`).digest('hex'),
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
