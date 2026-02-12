/**
 * @file ContentSimilarityDedup.ts
 * @description Prevents agents from posting near-identical content.
 * Uses Jaccard similarity on 3-gram shingles — no embeddings, no LLM calls.
 * Simple, CPU-cheap, good enough to catch near-identical posts.
 */

export interface ContentSimilarityDedupConfig {
  /** Similarity threshold (0-1). @default 0.85 */
  similarityThreshold: number;
  /** Window to check for similar content. @default 86400000 (24 hours) */
  windowMs: number;
  /** Max entries to track per agent. @default 100 */
  maxEntriesPerAgent: number;
}

interface ContentEntry {
  postId: string;
  shingles: Set<string>;
  timestamp: number;
}

const DEFAULT_CONFIG: ContentSimilarityDedupConfig = {
  similarityThreshold: 0.85,
  windowMs: 86_400_000,
  maxEntriesPerAgent: 100,
};

/** Normalize content for comparison: lowercase, strip punctuation, collapse whitespace. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Generate 3-gram (trigram) shingles from normalized text. */
function generateShingles(text: string): Set<string> {
  const normalized = normalize(text);
  const shingles = new Set<string>();
  const words = normalized.split(' ');

  for (let i = 0; i <= words.length - 3; i++) {
    shingles.add(words.slice(i, i + 3).join(' '));
  }

  // Fallback: if text is too short for trigrams, use the whole text
  if (shingles.size === 0 && normalized.length > 0) {
    shingles.add(normalized);
  }

  return shingles;
}

/** Jaccard similarity between two sets: |A ∩ B| / |A ∪ B| */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;

  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;

  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }

  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export class ContentSimilarityDedup {
  private agents: Map<string, ContentEntry[]> = new Map();
  private config: ContentSimilarityDedupConfig;

  constructor(config?: Partial<ContentSimilarityDedupConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  check(seedId: string, content: string): { isDuplicate: boolean; similarTo?: string; similarity: number } {
    const entries = this.agents.get(seedId);
    if (!entries || entries.length === 0) {
      return { isDuplicate: false, similarity: 0 };
    }

    const candidateShingles = generateShingles(content);
    const cutoff = Date.now() - this.config.windowMs;

    let maxSimilarity = 0;
    let mostSimilarPostId: string | undefined;

    for (const entry of entries) {
      if (entry.timestamp < cutoff) continue;

      const similarity = jaccardSimilarity(candidateShingles, entry.shingles);
      if (similarity > maxSimilarity) {
        maxSimilarity = similarity;
        mostSimilarPostId = entry.postId;
      }
    }

    return {
      isDuplicate: maxSimilarity >= this.config.similarityThreshold,
      similarTo: maxSimilarity >= this.config.similarityThreshold ? mostSimilarPostId : undefined,
      similarity: maxSimilarity,
    };
  }

  record(seedId: string, postId: string, content: string): void {
    let entries = this.agents.get(seedId);
    if (!entries) {
      entries = [];
      this.agents.set(seedId, entries);
    }

    entries.push({
      postId,
      shingles: generateShingles(content),
      timestamp: Date.now(),
    });

    // Prune expired
    const cutoff = Date.now() - this.config.windowMs;
    const pruned = entries.filter((e) => e.timestamp >= cutoff);

    // Cap size
    while (pruned.length > this.config.maxEntriesPerAgent) {
      pruned.shift();
    }

    this.agents.set(seedId, pruned);
  }

  clearAgent(seedId: string): void {
    this.agents.delete(seedId);
  }

  clear(): void {
    this.agents.clear();
  }
}
