/**
 * Curated Picks handler — periodically fetches news/research from the scraper API,
 * uses OpenAI to pick the most interesting item, generates personality-driven
 * commentary, and posts it to #general as "Wunderland AI".
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const BRAND_COLOR = 0x8b6914;

const CATEGORIES = ['tech', 'science', 'finance', 'world'] as const;

const BASE_INTERVAL = 6 * 60 * 60 * 1000;   // 6 hours
const JITTER_MAX   = 30 * 60 * 1000;         // 0-30 min random
const STARTUP_DELAY = 15 * 60 * 1000;        // 15 min after boot
const MAX_PICKS_PER_DAY = 4;

const CURATION_ADDENDUM = `
You are curating the most interesting news and research for the Rabbit Hole community — a Discord server for builders, engineers, and curious minds.

You will receive a numbered list of articles. Pick the single most genuinely interesting one.

Selection criteria:
- Surprising, counterintuitive, or paradigm-shifting
- Relevant to builders, engineers, researchers, or curious minds
- Something YOU would actually want to share with smart friends
- NOT boring corporate announcements or incremental updates
- NOT clickbait or hype without substance
- NOT generic earnings reports or routine product updates

If nothing is genuinely worth sharing, respond with exactly: {}

Otherwise respond with ONLY a JSON object (no markdown, no code fences):
{ "index": <0-based index of the selected article>, "hook": "<casual 1-sentence intro — how you'd naturally lead into sharing this, no 'Hey everyone' or 'Check this out', just drop it naturally>", "commentary": "<your genuine hot take in 1-3 sentences — be opinionated, don't just summarize>" }`.trim();

interface CandidateArticle {
  title: string;
  url: string;
  date: string;
  category: string;
}

export interface CuratedPicksConfig {
  channelId: string;
  openaiApiKey: string;
  systemPrompt: string;
  scraperApiUrl: string;
  model?: string;
  intervalMs?: number;
}

export function createCuratedPicksHandler(config: CuratedPicksConfig) {
  const model = config.model || 'gpt-4o-mini';
  const interval = config.intervalMs || BASE_INTERVAL;
  const postedUrls = new Set<string>();
  let picksToday = 0;
  let lastResetDate = new Date().toDateString();

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
    const systemPrompt = `${config.systemPrompt}\n\n${CURATION_ADDENDUM}`;

    const articleList = candidates
      .map((a, i) => `${i}. [${a.category.toUpperCase()}] "${a.title}"${a.date ? ` (${a.date})` : ''}`)
      .join('\n');

    const userPrompt = `Here are today's articles:\n\n${articleList}`;

    try {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.openaiApiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          max_tokens: 300,
          temperature: 0.9,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error(`[CuratedPicks] OpenAI API error ${res.status}: ${text}`);
        return null;
      }

      const data = await res.json() as any;
      const content = data?.choices?.[0]?.message?.content?.trim();
      if (!content || content === '{}') return null;

      // Strip markdown code fences if present
      const cleaned = content.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
      const parsed = JSON.parse(cleaned);

      if (parsed.index == null || !parsed.hook || !parsed.commentary) return null;
      const idx = Number(parsed.index);
      if (idx < 0 || idx >= candidates.length) return null;

      return {
        article: candidates[idx],
        hook: parsed.hook,
        commentary: parsed.commentary,
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

    // Filter out already-posted URLs
    const fresh = candidates.filter(a => !postedUrls.has(a.url));
    if (fresh.length === 0) {
      console.log('[CuratedPicks] All candidates already posted, skipping cycle');
      return;
    }

    const pick = await curateAndComment(fresh);
    if (!pick) {
      console.log('[CuratedPicks] Nothing interesting this cycle, skipping');
      return;
    }

    const embed = {
      title: pick.article.title,
      url: pick.article.url,
      description: pick.commentary,
      color: BRAND_COLOR,
      footer: { text: 'rabbithole.inc' },
    };

    try {
      await service.sendMessage(config.channelId, pick.hook, {
        embeds: [embed],
      });

      postedUrls.add(pick.article.url);
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
