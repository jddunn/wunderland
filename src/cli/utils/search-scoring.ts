/**
 * Shared relevance-scoring search used by CLI commands, TUI views, and API consumers.
 * Supports multi-term queries with fuzzy matching via Levenshtein distance.
 * @module wunderland/cli/utils/search-scoring
 */

/** Levenshtein distance for fuzzy matching. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/** Check if term fuzzy-matches target (Levenshtein distance <= threshold). */
function fuzzyMatch(term: string, target: string, threshold = 2): boolean {
  if (target.includes(term)) return true;
  // Check each word in target
  const words = target.split(/[\s\-_]+/);
  return words.some(w => levenshtein(term, w) <= threshold);
}

/**
 * Shape that any searchable item must satisfy.
 * All fields except `name` are optional.
 */
export interface SearchableItem {
  id?: string;
  name: string;
  displayName?: string;
  category?: string;
  description?: string;
  tags?: string[];
  keywords?: string[];
}

/** An item paired with its relevance score. */
export interface ScoredResult<T extends SearchableItem> {
  item: T;
  score: number;
}

/**
 * Score and rank items by relevance to a query string.
 * Multi-term queries: all terms must match (AND logic), scores are summed.
 *
 * @param items - The items to search through
 * @param query - Space-separated search terms
 * @param maxResults - Maximum number of results to return (default 20)
 * @returns Scored results sorted by descending relevance
 */
export function scoreSearch<T extends SearchableItem>(
  items: T[],
  query: string,
  maxResults = 20,
): ScoredResult<T>[] {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return items.map(item => ({ item, score: 0 }));

  const results: ScoredResult<T>[] = [];

  for (const item of items) {
    const name = (item.name || '').toLowerCase();
    const displayName = (item.displayName || '').toLowerCase();
    const id = (item.id || '').toLowerCase();
    const category = (item.category || '').toLowerCase();
    const description = (item.description || '').toLowerCase();
    const tags = (item.tags || item.keywords || []).map(t => t.toLowerCase());
    const allText = `${id} ${name} ${displayName} ${category} ${description} ${tags.join(' ')}`;

    let totalScore = 0;
    let allTermsMatch = true;

    for (const term of terms) {
      let termScore = 0;

      // Exact matches (highest priority)
      if (name === term || id === term) termScore += 50;
      else if (name.includes(term) || id.includes(term)) termScore += 30;
      else if (displayName.includes(term)) termScore += 25;
      else if (category === term) termScore += 20;
      else if (tags.some(t => t === term)) termScore += 20;
      else if (description.includes(term)) termScore += 10;
      else if (tags.some(t => t.includes(term))) termScore += 8;
      else if (allText.includes(term)) termScore += 5;
      // Fuzzy fallback
      else if (fuzzyMatch(term, allText)) termScore += 3;
      else {
        allTermsMatch = false;
        break;
      }

      totalScore += termScore;
    }

    if (allTermsMatch && totalScore > 0) {
      results.push({ item, score: totalScore / terms.length });
    }
  }

  return results
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults);
}

/**
 * Simple filter for real-time TUI typing (fast, no scoring overhead).
 * Returns items that fuzzy-match the query.
 *
 * @param items - The items to filter
 * @param query - The search string
 * @returns Filtered items (original order preserved)
 */
export function filterSearch<T extends SearchableItem>(
  items: T[],
  query: string,
): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;

  return items.filter(item => {
    const hay = `${item.id || ''} ${item.name} ${item.displayName || ''} ${item.category || ''} ${item.description || ''} ${(item.tags || item.keywords || []).join(' ')}`.toLowerCase();
    return hay.includes(q) || fuzzyMatch(q, hay);
  });
}
