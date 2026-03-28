/**
 * @fileoverview HackerNews source fetcher via Algolia API.
 * @module wunderland/social/sources/HackerNewsFetcher
 */

import { createHash } from 'crypto';
import type { IngestedArticle } from '../NewsFeedIngester.js';
import type { ISourceFetcher, SourceFetchConfig } from './ISourceFetcher.js';

/**
 * Full keyword → category mapping for content-based inference.
 * The wunderland package serves all agent types, so categories span
 * well beyond tech — design, business, gaming, math, health, education, etc.
 */
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  ai: ['ai', 'machine learning', 'ml', 'llm', 'gpt', 'claude', 'neural', 'transformer', 'deep learning', 'diffusion', 'openai', 'anthropic', 'gemini', 'model', 'inference', 'training', 'fine-tune', 'rag', 'embedding', 'agent'],
  programming: ['rust', 'python', 'javascript', 'typescript', 'golang', 'java', 'c++', 'compiler', 'parser', 'regex', 'algorithm', 'data structure', 'api', 'sdk', 'framework', 'library', 'package', 'npm', 'crate', 'pip'],
  security: ['security', 'vulnerability', 'cve', 'exploit', 'hack', 'breach', 'encryption', 'zero-day', 'malware', 'ransomware', 'phishing', 'auth', 'oauth', 'backdoor'],
  startups: ['startup', 'funding', 'yc', 'seed', 'series a', 'valuation', 'acquisition', 'ipo', 'founder', 'venture', 'pivot', 'launch'],
  infrastructure: ['kubernetes', 'docker', 'aws', 'cloud', 'server', 'database', 'postgres', 'redis', 'kafka', 'deploy', 'ci/cd', 'terraform', 'devops', 'linux', 'nginx', 'cdn'],
  web: ['browser', 'css', 'html', 'react', 'vue', 'svelte', 'nextjs', 'frontend', 'web', 'dom', 'wasm', 'webgl', 'pwa'],
  hardware: ['chip', 'cpu', 'gpu', 'arm', 'risc-v', 'fpga', 'silicon', 'semiconductor', 'asic', 'circuit', 'embedded', 'iot', 'raspberry pi', 'arduino'],
  science: ['research', 'paper', 'study', 'physics', 'biology', 'chemistry', 'space', 'nasa', 'quantum', 'genome', 'neuroscience', 'arxiv', 'peer review'],
  crypto: ['bitcoin', 'ethereum', 'blockchain', 'crypto', 'defi', 'nft', 'solana', 'web3', 'token', 'wallet'],
  policy: ['regulation', 'gdpr', 'copyright', 'patent', 'antitrust', 'fcc', 'eu', 'legislation', 'congress', 'court', 'ruling', 'ban', 'censorship', 'privacy'],
  career: ['hiring', 'layoff', 'remote', 'salary', 'interview', 'resume', 'job', 'career', 'engineer', 'manager', 'burnout', 'culture'],
  open_source: ['open source', 'oss', 'mit license', 'gpl', 'apache', 'github', 'gitlab', 'fork', 'contributor', 'maintainer', 'bsd'],
  design: ['design', 'ux', 'ui', 'typography', 'figma', 'color', 'accessibility', 'a11y', 'responsive', 'animation'],
  business: ['revenue', 'profit', 'market', 'growth', 'enterprise', 'saas', 'pricing', 'customer', 'churn', 'b2b', 'b2c', 'monetize'],
  gaming: ['game', 'gaming', 'unity', 'unreal', 'godot', 'steam', 'console', 'vr', 'ar', 'metaverse', '3d'],
  mathematics: ['math', 'proof', 'theorem', 'algebra', 'geometry', 'topology', 'statistics', 'probability', 'optimization', 'graph theory'],
  health: ['health', 'medical', 'clinical', 'fda', 'drug', 'therapy', 'mental health', 'biotech', 'pharma', 'diagnosis', 'patient'],
  education: ['education', 'learning', 'course', 'university', 'student', 'mooc', 'tutorial', 'teaching', 'curriculum'],
  energy: ['energy', 'solar', 'wind', 'nuclear', 'battery', 'ev', 'electric vehicle', 'grid', 'renewable', 'climate', 'carbon'],
  media: ['media', 'journalism', 'news', 'podcast', 'video', 'streaming', 'content', 'creator', 'youtube', 'tiktok', 'social media'],
  finance: ['finance', 'bank', 'trading', 'stock', 'investment', 'fintech', 'payment', 'stripe', 'paypal', 'credit', 'loan', 'mortgage'],
  robotics: ['robot', 'robotics', 'drone', 'autonomous', 'self-driving', 'lidar', 'slam', 'actuator', 'humanoid'],
  legal: ['legal', 'law', 'attorney', 'contract', 'compliance', 'lawsuit', 'tort', 'liability', 'intellectual property'],
};

/** Infer categories from title and URL by matching keywords. */
function inferCategories(title: string, url: string): string[] {
  const text = `${title} ${url}`.toLowerCase();
  const scores: [string, number][] = [];
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    const matchCount = keywords.filter(kw => text.includes(kw)).length;
    if (matchCount > 0) scores.push([category, matchCount]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  const matched = scores.map(([cat]) => cat);
  return matched.length > 0 ? matched : ['general'];
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
