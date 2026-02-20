/**
 * @fileoverview CompactionManager — conversation context compaction engine.
 *
 * When the conversation context grows too large for the model's context window,
 * the CompactionManager summarizes the conversation while preserving critical
 * context such as PERSONA.md directives, security constraints, active skills,
 * and GOALS.md objectives.
 *
 * Layer 3 (read audit) optionally verifies that key terms from the original
 * context survive compaction, guarding against information loss.
 *
 * @module wunderland/core/CompactionManager
 */

// ── Types ────────────────────────────────────────────────────────────────────

/** Configuration for the compaction engine. */
export interface CompactionConfig {
  /** Maximum tokens before triggering compaction */
  maxContextTokens?: number; // default: 100_000

  /** Approximate token estimation ratio (chars/token) */
  charsPerToken?: number; // default: 4

  /** LLM invoker for generating summaries */
  invoker?: (prompt: string) => Promise<string>;

  /** Critical rules to always re-inject after compaction */
  criticalRules?: string[];

  /** Enable post-compaction read audit (Layer 3) */
  enableReadAudit?: boolean;
}

/** Result of a compaction operation. */
export interface CompactionResult {
  compacted: boolean;
  originalTokenEstimate: number;
  compactedTokenEstimate: number;
  criticalRulesInjected: string[];
  auditPassed?: boolean;
}

/** A single message in a conversation. */
export interface ConversationMessage {
  role: string;
  content: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

/** Default maximum context tokens before compaction triggers. */
const DEFAULT_MAX_CONTEXT_TOKENS = 100_000;

/** Default chars-per-token ratio for rough estimation. */
const DEFAULT_CHARS_PER_TOKEN = 4;

/** Maximum number of retries when the LLM summarization call fails. */
const SUMMARY_MAX_RETRIES = 2;

/** Delay between retries (ms). */
const SUMMARY_RETRY_DELAY_MS = 1_000;

/**
 * System prompt used to instruct the LLM to produce a compacted summary.
 *
 * The prompt asks the model to:
 * 1. Preserve all factual decisions, tool outputs, and user preferences.
 * 2. Retain any persona/character directives verbatim.
 * 3. Keep security constraints and active skill references.
 * 4. Compress filler, greetings, and repetitive acknowledgments.
 * 5. Output a single coherent narrative (no bullet points) suitable for
 *    re-injection as a system-level "conversation so far" block.
 */
export const COMPACTION_SUMMARY_PROMPT = `You are a conversation compaction engine. Your task is to produce a concise, faithful summary of the conversation below.

RULES:
1. Preserve ALL factual decisions, conclusions, tool call results, and user preferences verbatim — these must not be paraphrased or omitted.
2. Retain any PERSONA directives, character descriptions, or role-play instructions exactly as stated.
3. Keep all security constraints, permission boundaries, and active skill references intact.
4. Keep references to GOALS, objectives, or milestones the user or agent established.
5. Compress filler exchanges (greetings, thanks, "sure", "got it") into a single sentence or remove entirely.
6. Do NOT invent information that was not in the original conversation.
7. Output a single coherent narrative paragraph (or a few short paragraphs) suitable for re-injection as a "conversation so far" context block.
8. Begin your summary with: "COMPACTED CONTEXT:"

CONVERSATION TO COMPACT:
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Sleep utility. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract key terms from a set of messages for audit comparison.
 * Returns a deduplicated set of lowercased significant words (length >= 5)
 * that appear in assistant or tool messages.
 */
function extractKeyTerms(messages: ConversationMessage[]): Set<string> {
  const terms = new Set<string>();
  for (const msg of messages) {
    if (msg.role === 'assistant' || msg.role === 'tool' || msg.role === 'system') {
      const words = msg.content
        .replace(/[^a-zA-Z0-9_\-/.]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 5);
      for (const w of words) {
        terms.add(w.toLowerCase());
      }
    }
  }
  return terms;
}

// ── CompactionManager ────────────────────────────────────────────────────────

/**
 * Manages conversation compaction — summarizing long conversations while
 * preserving critical context (persona, security, skills, goals).
 */
export class CompactionManager {
  private readonly maxContextTokens: number;
  private readonly charsPerToken: number;

  constructor(config?: Pick<CompactionConfig, 'maxContextTokens' | 'charsPerToken'>) {
    this.maxContextTokens = config?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.charsPerToken = config?.charsPerToken ?? DEFAULT_CHARS_PER_TOKEN;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /**
   * Check whether the conversation should be compacted based on estimated
   * token count vs. the configured maximum.
   */
  shouldCompact(messages: ConversationMessage[]): boolean {
    const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
    const estimatedTokens = Math.ceil(totalChars / this.charsPerToken);
    return estimatedTokens > this.maxContextTokens;
  }

  /**
   * Compact a conversation: summarize via LLM, re-inject critical rules,
   * and optionally audit the result.
   *
   * If no `invoker` is provided in the config, compaction returns a
   * result with `compacted: false` — the caller is responsible for
   * providing an LLM invoker when actual summarization is desired.
   */
  async compact(
    messages: ConversationMessage[],
    config?: CompactionConfig,
  ): Promise<CompactionResult> {
    const mergedConfig: Required<CompactionConfig> = {
      maxContextTokens: config?.maxContextTokens ?? this.maxContextTokens,
      charsPerToken: config?.charsPerToken ?? this.charsPerToken,
      invoker: config?.invoker ?? (async () => ''),
      criticalRules: config?.criticalRules ?? [],
      enableReadAudit: config?.enableReadAudit ?? false,
    };

    const originalTokenEstimate = this.estimateTokens(
      messages.map((m) => m.content).join('\n'),
    );

    // If we're under the limit, skip compaction
    if (originalTokenEstimate <= mergedConfig.maxContextTokens) {
      return {
        compacted: false,
        originalTokenEstimate,
        compactedTokenEstimate: originalTokenEstimate,
        criticalRulesInjected: [],
      };
    }

    // If no invoker provided, we cannot compact
    if (!config?.invoker) {
      return {
        compacted: false,
        originalTokenEstimate,
        compactedTokenEstimate: originalTokenEstimate,
        criticalRulesInjected: [],
      };
    }

    // Generate the summary
    const summary = await this.generateSummary(messages, mergedConfig.invoker);

    // Inject critical rules
    const withRules = this.injectCriticalRules(summary, mergedConfig.criticalRules);

    const compactedTokenEstimate = this.estimateTokens(withRules);

    // Optional audit
    let auditPassed: boolean | undefined;
    if (mergedConfig.enableReadAudit) {
      auditPassed = this.auditCompaction(messages, withRules);
    }

    return {
      compacted: true,
      originalTokenEstimate,
      compactedTokenEstimate,
      criticalRulesInjected: [...mergedConfig.criticalRules],
      auditPassed,
    };
  }

  /**
   * Rough token estimation using the configured chars-per-token ratio.
   * This is intentionally approximate — use a proper tokenizer for
   * precision-critical paths.
   */
  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / this.charsPerToken);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  /**
   * Generate a summary of the conversation via the provided LLM invoker.
   * Retries up to `SUMMARY_MAX_RETRIES` times on failure.
   */
  private async generateSummary(
    messages: ConversationMessage[],
    invoker: (prompt: string) => Promise<string>,
  ): Promise<string> {
    const conversationText = messages
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n\n');

    const prompt = COMPACTION_SUMMARY_PROMPT + conversationText;

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= SUMMARY_MAX_RETRIES; attempt++) {
      try {
        const result = await invoker(prompt);
        if (result && result.trim().length > 0) {
          return result.trim();
        }
        // Empty result — treat as failure, retry
        lastError = new Error('LLM returned empty summary');
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }

      if (attempt < SUMMARY_MAX_RETRIES) {
        await sleep(SUMMARY_RETRY_DELAY_MS);
      }
    }

    // All retries exhausted — return a fallback truncation
    const fallback = messages
      .slice(-20)
      .map((m) => `[${m.role}]: ${m.content}`)
      .join('\n\n');

    return `COMPACTED CONTEXT (fallback — LLM summarization failed: ${lastError?.message ?? 'unknown error'}):\n\n${fallback}`;
  }

  /**
   * Append critical rules to the compacted summary.
   * Critical rules are injected as a clearly demarcated block so the
   * model treats them as authoritative constraints.
   */
  private injectCriticalRules(summary: string, rules: string[]): string {
    if (rules.length === 0) return summary;

    const rulesBlock = [
      '',
      '--- CRITICAL RULES (always enforced) ---',
      ...rules.map((rule, i) => `${i + 1}. ${rule}`),
      '--- END CRITICAL RULES ---',
    ].join('\n');

    return summary + '\n' + rulesBlock;
  }

  /**
   * Audit the compacted output to verify that key terms from the original
   * conversation are preserved. Returns true if at least 60% of key terms
   * from the original are found in the compacted text.
   *
   * This is "Layer 3" of the compaction safety net — a cheap, local check
   * that catches catastrophic information loss without requiring another
   * LLM call.
   */
  private auditCompaction(
    originalMessages: ConversationMessage[],
    compactedText: string,
  ): boolean {
    const originalTerms = extractKeyTerms(originalMessages);
    if (originalTerms.size === 0) return true;

    const compactedLower = compactedText.toLowerCase();
    let preserved = 0;

    for (const term of originalTerms) {
      if (compactedLower.includes(term)) {
        preserved++;
      }
    }

    const ratio = preserved / originalTerms.size;

    // 60% preservation threshold — generous enough to allow compression
    // but catches cases where the summary dropped entire topics.
    return ratio >= 0.6;
  }
}
