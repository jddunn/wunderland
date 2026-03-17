/**
 * @fileoverview LLM-as-a-judge query classifier for research depth routing.
 *
 * Uses a small/cheap model (gpt-4o-mini, claude-haiku, qwen2.5:3b) to classify
 * incoming queries into research depth tiers BEFORE the main LLM turn. This is
 * more reliable than prompt-based instructions because the main LLM can ignore them.
 *
 * Classification tiers:
 *   none     — LLM can answer from training data (greetings, simple facts, code help)
 *   quick    — needs a web search or two (weather, stock price, "what is X")
 *   moderate — needs multi-source research (comparisons, recommendations, "best X for Y")
 *   deep     — needs decomposition + gap analysis (medical, legal, scientific, learning plans)
 *
 * @module wunderland/runtime/research-classifier
 */

export type ResearchDepth = 'none' | 'quick' | 'moderate' | 'deep';

export interface ResearchClassification {
  depth: ResearchDepth;
  reasoning: string;
  /** Time taken for the classification LLM call in ms */
  latencyMs: number;
}

export interface ResearchClassifierConfig {
  /** Whether auto-classification is enabled. Default: true */
  enabled: boolean;
  /** LLM call function: (systemPrompt, userMessage) → response text */
  llmCall: (system: string, user: string) => Promise<string>;
  /** Override classification for specific patterns (e.g., always deep for /research) */
  overrides?: { pattern: RegExp; depth: ResearchDepth }[];
}

export interface ResearchClassifierLlmCallOptions {
  providerId?: string;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

const CLASSIFIER_SYSTEM_PROMPT = `You are a query complexity classifier. Given a user query, classify it into ONE of these research depth tiers:

**none** — The query can be answered from general knowledge. Examples: greetings, simple factual questions, code syntax, math, creative writing, conversation.

**quick** — The query needs 1-2 web searches for current/real-time data. Examples: today's weather, current stock price, latest news about X, "what is [recent term]".

**moderate** — The query needs multiple sources compared and synthesized. Examples: product comparisons, "best X for Y", travel recommendations, current state of an industry.

**deep** — The query requires thorough multi-source research with decomposition and citations. Examples: medical conditions (diagnosis, treatment, symptoms), legal questions, scientific analysis, comprehensive learning plans, career transitions, financial planning, anything where incorrect information could cause harm.

Respond with ONLY a JSON object: {"depth": "none|quick|moderate|deep", "reasoning": "one sentence why"}

Do NOT explain. Do NOT add extra text. ONLY the JSON object.`;

export function resolveResearchClassifierModel(providerId?: string): string {
  if (providerId === 'ollama') return 'qwen2.5:3b';
  if (providerId === 'gemini') return 'gemini-2.0-flash-lite';
  return 'gpt-4o-mini';
}

export function createResearchClassifierLlmCall(
  options: ResearchClassifierLlmCallOptions,
): (system: string, user: string) => Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl || 'https://api.openai.com/v1';
  const model = resolveResearchClassifierModel(options.providerId);

  return async (system: string, user: string): Promise<string> => {
    const response = await fetchImpl(
      `${baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${options.apiKey ?? ''}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 0,
          max_tokens: 100,
        }),
      },
    );

    if (!response.ok) {
      return '{"depth":"none","reasoning":"classifier request failed"}';
    }

    const data = await response.json() as any;
    return data?.choices?.[0]?.message?.content || '{"depth":"none"}';
  };
}

/**
 * Classify a user query's required research depth using LLM-as-a-judge.
 */
export async function classifyResearchDepth(
  query: string,
  config: ResearchClassifierConfig,
): Promise<ResearchClassification> {
  if (!config.enabled) {
    return { depth: 'none', reasoning: 'classifier disabled', latencyMs: 0 };
  }

  // Check overrides first (e.g., /research prefix already handled)
  if (config.overrides) {
    for (const override of config.overrides) {
      if (override.pattern.test(query)) {
        return { depth: override.depth, reasoning: 'matched override pattern', latencyMs: 0 };
      }
    }
  }

  const start = Date.now();

  try {
    const response = await config.llmCall(CLASSIFIER_SYSTEM_PROMPT, query);
    const latencyMs = Date.now() - start;

    // Parse JSON response — be lenient with formatting
    const jsonMatch = response.match(/\{[\s\S]*?"depth"\s*:\s*"(none|quick|moderate|deep)"[\s\S]*?\}/);
    if (!jsonMatch) {
      // Fallback: look for just the depth word
      const wordMatch = response.match(/\b(none|quick|moderate|deep)\b/i);
      return {
        depth: (wordMatch?.[1]?.toLowerCase() as ResearchDepth) || 'none',
        reasoning: 'parsed from fallback word match',
        latencyMs,
      };
    }

    try {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        depth: parsed.depth as ResearchDepth,
        reasoning: parsed.reasoning || 'no reasoning provided',
        latencyMs,
      };
    } catch {
      return {
        depth: (jsonMatch[1] as ResearchDepth) || 'none',
        reasoning: 'parsed from regex match',
        latencyMs,
      };
    }
  } catch (err) {
    // Classification failure should never block the main turn
    return {
      depth: 'none',
      reasoning: `classifier error: ${err instanceof Error ? err.message : String(err)}`,
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Build the research mode prefix to inject into the user message
 * when the classifier determines research is needed.
 */
export function buildResearchPrefix(depth: ResearchDepth): string | null {
  if (depth === 'none') return null;

  if (depth === 'quick') {
    return '[Use web_search or news_search to find current information for this query. Cite your sources.]';
  }

  if (depth === 'moderate') {
    return (
      '[RESEARCH MODE: Use researchAggregate or researchInvestigate to search multiple sources for this query. ' +
      'Compare findings across sources and present a well-sourced answer with citations.]'
    );
  }

  // deep
  return (
    '[RESEARCH MODE: Use the deep_research tool with depth="deep" to answer this query. ' +
    'Decompose it into sub-questions, search multiple sources, analyze gaps, and synthesize a thorough ' +
    'report with citations. Do NOT answer from your training data alone.]'
  );
}

/**
 * Resolve classifier config from agent configuration.
 */
export interface ResearchClassifierAgentConfig {
  /** Enable LLM-as-judge query classification. Default: true */
  enabled?: boolean;
  /** Minimum depth to trigger research injection. Default: 'quick' */
  minDepthToInject?: ResearchDepth;
}

export const DEFAULT_RESEARCH_CLASSIFIER_CONFIG: ResearchClassifierAgentConfig = {
  enabled: true,
  minDepthToInject: 'quick',
};

/** Depth ordinal for comparison */
const DEPTH_ORDER: Record<ResearchDepth, number> = { none: 0, quick: 1, moderate: 2, deep: 3 };

export function shouldInjectResearch(
  classified: ResearchDepth,
  minDepth: ResearchDepth = 'quick',
): boolean {
  return DEPTH_ORDER[classified] >= DEPTH_ORDER[minDepth];
}
