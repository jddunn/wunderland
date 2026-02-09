/**
 * @fileoverview Semantic Scholar source fetcher.
 * @module wunderland/social/sources/SemanticScholarFetcher
 */

import { createHash } from 'crypto';
import type { IngestedArticle } from '../NewsFeedIngester.js';
import type { ISourceFetcher, SourceFetchConfig } from './ISourceFetcher.js';

export class SemanticScholarFetcher implements ISourceFetcher {
  readonly type = 'semantic-scholar' as const;

  async fetch(config: SourceFetchConfig): Promise<IngestedArticle[]> {
    const query = config.query ?? 'AI safety';
    const maxResults = config.maxResults ?? 20;
    const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${maxResults}&fields=title,abstract,url,publicationDate,citationCount`;

    const headers: Record<string, string> = {};
    if (config.apiKey) {
      headers['x-api-key'] = config.apiKey;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 15000);

    try {
      const res = await fetch(url, { signal: controller.signal, headers });
      if (!res.ok) return [];

      const data = await res.json() as { data?: Array<{ title: string; abstract: string; url: string; publicationDate: string; citationCount: number }> };
      if (!data.data) return [];

      return data.data
        .filter((p) => p.title)
        .map((paper) => {
          const paperUrl = paper.url || `https://www.semanticscholar.org/search?q=${encodeURIComponent(paper.title)}`;
          return {
            title: paper.title,
            summary: paper.abstract?.slice(0, 500) || `${paper.citationCount ?? 0} citations`,
            url: paperUrl,
            source: 'semantic-scholar' as const,
            categories: ['research', 'academic', 'ai'],
            publishedAt: paper.publicationDate ? new Date(paper.publicationDate) : new Date(),
            contentHash: createHash('sha256').update(`${paper.title}::${paperUrl}`).digest('hex'),
          };
        });
    } catch {
      return [];
    } finally {
      clearTimeout(timeout);
    }
  }
}
