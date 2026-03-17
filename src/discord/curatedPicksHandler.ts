/**
 * Curated Picks handler — periodically fetches news/research from the scraper API,
 * uses OpenAI to pick the most wildly interesting item, generates edgy opinionated
 * commentary, and posts it to #general as "Wunderland News".
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const BRAND_COLOR = 0x8b6914;

const CATEGORIES = ['tech', 'science', 'finance', 'world'] as const;

const BASE_INTERVAL = 18 * 60 * 60 * 1000;   // 18 hours — ~1 pick per day
const JITTER_MAX   = 2 * 60 * 60 * 1000;     // 0-2h random jitter
const STARTUP_DELAY = 30 * 60 * 1000;        // 30 min after boot
const MAX_PICKS_PER_DAY = 2;                 // absolute max 2 per day, usually 1

// --- Dedup cache constants ---
const CACHE_DIR = path.join(os.homedir(), '.wunderland');
const CACHE_FILE = path.join(CACHE_DIR, 'curated-picks-cache.json');
const CACHE_MAX_ENTRIES = 50;
const CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SIMILARITY_THRESHOLD = 0.45; // Jaccard word overlap — 0.45 catches "same story, different headline"

const CURATION_JUDGE_PROMPT = `
You are the selection judge for Wunderland News — curating only the most wild, conversation-starting news for the Rabbit Hole community (builders, engineers, hackers, and the dangerously curious).

You will receive a numbered list of articles. Pick ONLY ONE story. Your job is to judge whether anything is actually worth interrupting the main community feed for.

HARD REQUIREMENTS:
- Must be genuinely surprising, consequential, or deeply counterintuitive
- Must be likely to provoke real discussion or disagreement among smart technical people
- Must matter to builders, engineers, researchers, traders, or power users
- Must clear this bar: "Would people still care about this in a week?"

INSTANT REJECT:
- Corporate announcements, product launches, funding rounds
- Incremental updates ("X releases version Y")
- Routine earnings, stock movement, or market churn
- Clickbait, vague hype, or anything that feels disposable
- Anything boring. If in doubt, it is boring.

If NOTHING clears this bar, respond with exactly {}

Otherwise respond with ONLY JSON:
{"index": <0-based index of the selected article>}`.trim();

const CURATION_COPY_PROMPT = `
You are the editorial voice of Wunderland News.

You will receive one selected article. Write:
- a hook: one lowercase raw reaction line, like you're texting a smart group chat
- commentary: 1-3 sentences with a specific take, not neutral summary

BANNED:
- "this changes everything"
- "brace yourselves"
- "challenges everything we know"
- "game-changer"
- "paradigm shift"
- "buckle up"
- "it remains to be seen"
- "only time will tell"
- "this is huge"

REQUIRED:
- name a specific winner, loser, or concrete consequence
- sound like a smart, slightly unhinged person online, not a journalist
- no markdown, no code fences, JSON only

Respond with ONLY JSON:
{"hook":"<line>","commentary":"<1-3 sentences>"}`.trim();

interface CandidateArticle {
  title: string;
  url: string;
  date: string;
  category: string;
}

interface CacheEntry {
  title: string;
  url: string;
  timestamp: number;
}

interface CuratedCopy {
  hook: string;
  commentary: string;
}

export interface CuratedPicksConfig {
  channelId: string;
  openaiApiKey: string;
  systemPrompt: string;
  scraperApiUrl: string;
  model?: string;
  intervalMs?: number;
  /** Separate bot token for posting news (posts as "Wunderland News" bot instead of the agent bot) */
  newsBotToken?: string;
}

function extractJsonObject(content: string): string | null {
  const cleaned = String(content ?? '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  return match?.[0] ?? null;
}

// ---------------------------------------------------------------------------
// Dedup cache helpers
// ---------------------------------------------------------------------------

function loadCache(): CacheEntry[] {
  try {
    if (!fs.existsSync(CACHE_FILE)) return [];
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    const entries: CacheEntry[] = JSON.parse(raw);
    // Prune old entries
    const cutoff = Date.now() - CACHE_MAX_AGE_MS;
    return entries.filter(e => e.timestamp > cutoff).slice(-CACHE_MAX_ENTRIES);
  } catch {
    return [];
  }
}

function saveCache(entries: CacheEntry[]): void {
  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
    const cutoff = Date.now() - CACHE_MAX_AGE_MS;
    const pruned = entries.filter(e => e.timestamp > cutoff).slice(-CACHE_MAX_ENTRIES);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(pruned, null, 2));
  } catch (err: any) {
    console.warn('[CuratedPicks] Failed to save cache:', err?.message ?? err);
  }
}

/** Tokenize a title into a set of meaningful lowercase words. */
function tokenize(title: string): Set<string> {
  const stopWords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'can', 'shall', 'to', 'of', 'in', 'for',
    'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
    'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
    'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each',
    'every', 'all', 'any', 'few', 'more', 'most', 'other', 'some',
    'such', 'no', 'only', 'own', 'same', 'than', 'too', 'very',
    'just', 'about', 'also', 'how', 'what', 'which', 'who', 'whom',
    'this', 'that', 'these', 'those', 'it', 'its', 'new', 'says',
    'said', 'says', 'according', 'report', 'reports', 'latest',
  ]);
  const words = title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  return new Set(words.filter(w => !stopWords.has(w)));
}

/** Jaccard similarity between two title word sets. */
function titleSimilarity(a: string, b: string): number {
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

/** Check if a title is too similar to any cached entry. */
function isTooSimilar(title: string, cache: CacheEntry[]): boolean {
  for (const entry of cache) {
    const sim = titleSimilarity(title, entry.title);
    if (sim >= SIMILARITY_THRESHOLD) {
      console.log(`[CuratedPicks] Skipping similar title (${(sim * 100).toFixed(0)}%): "${title}" ≈ "${entry.title}"`);
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export function createCuratedPicksHandler(config: CuratedPicksConfig) {
  const model = config.model || 'gpt-4o';
  const interval = config.intervalMs || BASE_INTERVAL;
  const postedUrls = new Set<string>();
  let picksToday = 0;
  let lastResetDate = new Date().toDateString();

  // Initialize in-memory set from persistent cache
  const initialCache = loadCache();
  for (const entry of initialCache) {
    postedUrls.add(entry.url);
  }
  if (initialCache.length > 0) {
    console.log(`[CuratedPicks] Loaded ${initialCache.length} cached entries from disk`);
  }

  function maybeResetDaily(): void {
    const today = new Date().toDateString();
    if (today !== lastResetDate) {
      picksToday = 0;
      lastResetDate = today;
    }
  }

  function pickRandomCategories(count: number): string[] {
    const shuffled = [...CATEGORIES].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
  }

  async function fetchCandidates(): Promise<CandidateArticle[]> {
    const categories = pickRandomCategories(3);
    const baseUrl = config.scraperApiUrl.replace(/\/$/, '');

    // Use /headlines endpoint — fast, no scraping, no dedup
    const fetches = categories.map(async (cat): Promise<CandidateArticle[]> => {
      try {
        const res = await fetch(`${baseUrl}/api/v1/news/${cat}/headlines?limit=10`, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) return [];
        const data = await res.json() as any;
        const headlines = data?.headlines ?? [];
        return headlines
          .filter((h: any) => h?.title && h?.url)
          .map((h: any) => ({
            title: h.title,
            url: h.url,
            date: h.date || '',
            category: cat,
          }));
      } catch {
        console.warn(`[CuratedPicks] Failed to fetch ${cat} headlines`);
        return [];
      }
    });

    const results = await Promise.all(fetches);
    return results.flat();
  }

  async function curateAndComment(
    candidates: CandidateArticle[],
  ): Promise<{ article: CandidateArticle; hook: string; commentary: string } | null> {
    const articleList = candidates
      .map((a, i) => `${i}. [${a.category.toUpperCase()}] "${a.title}"${a.date ? ` (${a.date})` : ''}`)
      .join('\n');

    const judgePrompt = `Here are today's articles:\n\n${articleList}`;

    try {
      const judgeRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: CURATION_JUDGE_PROMPT },
            { role: 'user', content: judgePrompt },
          ],
          max_tokens: 120,
          temperature: 0.2,
        }),
      });

      if (!judgeRes.ok) {
        const text = await judgeRes.text().catch(() => '');
        console.error(`[CuratedPicks] Judge API error ${judgeRes.status}: ${text}`);
        return null;
      }

      const judgeData = await judgeRes.json() as any;
      const judgeContent = judgeData?.choices?.[0]?.message?.content?.trim() ?? '';
      if (!judgeContent || judgeContent === '{}') return null;

      const judgeJson = extractJsonObject(judgeContent);
      if (!judgeJson) return null;
      const judgeParsed = JSON.parse(judgeJson) as { index?: unknown };
      const idx = Number(judgeParsed.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= candidates.length) return null;

      const article = candidates[idx];
      const copyPrompt = `Selected article:

Title: ${article.title}
Category: ${article.category}
Date: ${article.date || 'unknown'}
URL: ${article.url}`;

      const copyRes = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: CURATION_COPY_PROMPT },
            { role: 'user', content: copyPrompt },
          ],
          max_tokens: 260,
          temperature: 0.95,
        }),
      });

      if (!copyRes.ok) {
        const text = await copyRes.text().catch(() => '');
        console.error(`[CuratedPicks] Copy API error ${copyRes.status}: ${text}`);
        return null;
      }

      const copyData = await copyRes.json() as any;
      const copyContent = copyData?.choices?.[0]?.message?.content?.trim() ?? '';
      const copyJson = extractJsonObject(copyContent);
      if (!copyJson) return null;
      const copyParsed = JSON.parse(copyJson) as Partial<CuratedCopy>;
      if (!copyParsed.hook || !copyParsed.commentary) return null;

      return {
        article,
        hook: String(copyParsed.hook).trim(),
        commentary: String(copyParsed.commentary).trim(),
      };
    } catch (err: any) {
      console.error('[CuratedPicks] Curation failed:', err?.message ?? err);
      return null;
    }
  }

  async function runCurationCycle(service: any): Promise<void> {
    maybeResetDaily();
    if (picksToday >= MAX_PICKS_PER_DAY) {
      console.log('[CuratedPicks] Daily limit reached, skipping cycle');
      return;
    }

    console.log('[CuratedPicks] Starting curation cycle...');

    const candidates = await fetchCandidates();
    if (candidates.length === 0) {
      console.log('[CuratedPicks] No candidates fetched, skipping cycle');
      return;
    }

    // Load persistent cache for similarity checking
    const cache = loadCache();

    // Filter out already-posted URLs AND similar titles
    const fresh = candidates.filter(a => {
      if (postedUrls.has(a.url)) return false;
      if (isTooSimilar(a.title, cache)) return false;
      return true;
    });
    if (fresh.length === 0) {
      console.log('[CuratedPicks] All candidates already posted or too similar, skipping cycle');
      return;
    }

    const pick = await curateAndComment(fresh);
    if (!pick) {
      console.log('[CuratedPicks] Nothing interesting this cycle, skipping');
      return;
    }

    const embed = {
      author: { name: '📰 Wunderland News' },
      title: pick.article.title,
      url: pick.article.url,
      description: pick.commentary,
      color: BRAND_COLOR,
      footer: { text: `${pick.article.category.toUpperCase()} | rabbithole.inc` },
    };

    try {
      if (config.newsBotToken) {
        // Post via separate "Wunderland News" bot using Discord REST API
        const res = await fetch(`https://discord.com/api/v10/channels/${config.channelId}/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bot ${config.newsBotToken}`,
          },
          body: JSON.stringify({ content: pick.hook, embeds: [embed] }),
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw new Error(`Discord API ${res.status}: ${text}`);
        }
      } else {
        // Fallback: post via the agent bot
        await service.sendMessage(config.channelId, pick.hook, { embeds: [embed] });
      }

      // Update both in-memory and persistent cache
      postedUrls.add(pick.article.url);
      cache.push({ title: pick.article.title, url: pick.article.url, timestamp: Date.now() });
      saveCache(cache);

      picksToday++;
      console.log(`[CuratedPicks] Posted: "${pick.article.title}" (${pick.article.category})`);
    } catch (err: any) {
      console.error('[CuratedPicks] Failed to post:', err?.message ?? err);
    }
  }

  function startSchedule(service: any): NodeJS.Timeout[] {
    const timers: NodeJS.Timeout[] = [];

    const startup = setTimeout(() => {
      runCurationCycle(service);

      const recurring = setInterval(() => {
        const jitter = Math.floor(Math.random() * JITTER_MAX);
        setTimeout(() => runCurationCycle(service), jitter);
      }, interval);
      timers.push(recurring);
    }, STARTUP_DELAY);

    timers.push(startup as unknown as NodeJS.Timeout);

    console.log(`[CuratedPicks] Scheduled: first cycle in ${Math.round(STARTUP_DELAY / 1000 / 60)}min, then every ${Math.round(interval / 1000 / 60 / 60)}h (±${Math.round(JITTER_MAX / 1000 / 60)}min jitter)`);
    return timers;
  }

  return { startSchedule };
}

export const __testing = {
  extractJsonObject,
  tokenize,
  titleSimilarity,
  isTooSimilar,
};
