/**
 * @fileoverview HackerNews source fetcher via Algolia API.
 * @module wunderland/social/sources/HackerNewsFetcher
 */

import { createHash } from 'crypto';
import type { IngestedArticle } from '../NewsFeedIngester.js';
import type { ISourceFetcher, SourceFetchConfig } from './ISourceFetcher.js';

/** Keyword → category mapping for content-based inference. */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  ai: ['ai', 'machine learning', 'ml', 'llm', 'gpt', 'claude', 'neural', 'transformer', 'deep learning', 'openai', 'anthropic'],
  programming: ['rust', 'python', 'javascript', 'typescript', 'golang', 'compiler', 'algorithm', 'api', 'framework', 'library'],
  security: ['security', 'vulnerability', 'cve', 'exploit', 'hack', 'breach', 'encryption', 'zero-day', 'malware'],
  startups: ['startup', 'funding', 'yc', 'seed', 'series a', 'acquisition', 'ipo', 'founder', 'venture'],
  infrastructure: ['kubernetes', 'docker', 'aws', 'cloud', 'database', 'postgres', 'redis', 'deploy', 'devops', 'linux'],
  web: ['browser', 'css', 'html', 'react', 'vue', 'nextjs', 'frontend', 'wasm'],
  hardware: ['chip', 'cpu', 'gpu', 'arm', 'risc-v', 'semiconductor', 'embedded', 'iot'],
  science: ['research', 'paper', 'physics', 'biology', 'space', 'quantum', 'neuroscience', 'arxiv'],
  crypto: ['bitcoin', 'ethereum', 'blockchain', 'crypto', 'defi', 'solana', 'web3'],
  policy: ['regulation', 'gdpr', 'copyright', 'patent', 'antitrust', 'legislation', 'privacy'],
  career: ['hiring', 'layoff', 'remote', 'salary', 'interview', 'job', 'burnout'],
  open_source: ['open source', 'oss', 'github', 'gitlab', 'fork', 'contributor', 'maintainer'],
};

/** Infer categories from title and URL by matching keywords. */
function inferCategories(title: string, url: string): string[] {
  const text = `${title} ${url}`.toLowerCase();
  const matched = Object.entries(CATEGORY_KEYWORDS)
    .filter(([, keywords]) => keywords.some(kw => text.includes(kw)))
    .map(([cat]) => cat);
  return matched.length > 0 ? matched : ['technology'];
}

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
          categories: inferCategories(hit.title, hit.url),
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
