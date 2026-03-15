/**
 * @fileoverview ToolFailureLearner — automatically records lessons from tool
 * failures so the agent avoids repeating the same mistakes.
 *
 * When a tool fails (browser blocked, API key missing, empty results), the
 * learner extracts a concise lesson and feeds it to the auto-ingest pipeline,
 * which embeds and stores it in the agent's RAG memory. On future turns,
 * retrieval surfaces these lessons so the agent uses different approaches.
 *
 * @module wunderland/runtime/tool-failure-learner
 */

import type { IMemoryAutoIngestPipeline } from '../storage/types.js';

/** Categorized failure pattern with suggested alternative. */
interface FailurePattern {
  match: RegExp;
  lesson: string;
  tags: string[];
}

/** Known failure patterns and their lessons. */
const FAILURE_PATTERNS: FailurePattern[] = [
  {
    match: /captcha|bot.detect|access.denied|403|cloudflare|blocked/i,
    lesson: 'blocks headless browsers (anti-bot). Use web_search with site: filter, or load stealth-browser and use stealth_navigate instead of browser_navigate.',
    tags: ['browser', 'anti-bot'],
  },
  {
    match: /empty.*(content|page|result)|no.*results?.*found|returned.*empty/i,
    lesson: 'returned empty content — may block headless browsers. Use web_search as fallback, or try stealth_navigate if stealth-browser is available.',
    tags: ['browser', 'empty-result'],
  },
  {
    match: /API.?KEY|api.*key.*required|not.*configured|missing.*key/i,
    lesson: 'requires an API key that is not configured. Run `wunderland extensions info <name>` for required env vars.',
    tags: ['api-key'],
  },
  {
    match: /timeout|timed?\s*out|ETIMEDOUT|ECONNREFUSED/i,
    lesson: 'timed out or could not connect. Service may be down. Try alternative tools.',
    tags: ['timeout'],
  },
  {
    match: /rate.?limit|429|too.*many.*requests|quota.*exceeded/i,
    lesson: 'hit rate limit. Wait before retrying or switch to an alternative provider/tool.',
    tags: ['rate-limit'],
  },
  {
    match: /model.*not.*found|pull.*first/i,
    lesson: 'Ollama model not installed. Use `wunderland ollama-setup` to pull required models.',
    tags: ['ollama'],
  },
];

export interface ToolFailureRecord {
  toolName: string;
  args: Record<string, unknown>;
  error: string;
  timestamp: string;
}

export interface ToolFailureLearnerConfig {
  /** Auto-ingest pipeline for storing lessons. */
  autoIngestPipeline?: IMemoryAutoIngestPipeline;
  /** Conversation ID for lesson storage. */
  conversationId: string;
  /** Whether to log when lessons are saved. Default: false. */
  verbose?: boolean;
}

/**
 * Collects tool failures and feeds lessons to the auto-ingest pipeline
 * so they get embedded into the agent's RAG memory.
 */
export class ToolFailureLearner {
  private pipeline: IMemoryAutoIngestPipeline | undefined;
  private conversationId: string;
  private verbose: boolean;
  private savedLessons = new Set<string>();
  private queuedLessons = new Set<string>();
  private pendingLessons: Array<{ dedupKey: string; lesson: string }> = [];

  constructor(config: ToolFailureLearnerConfig) {
    this.pipeline = config.autoIngestPipeline;
    this.conversationId = config.conversationId;
    this.verbose = config.verbose ?? false;
  }

  /** Update the pipeline reference (set after initialization). */
  setPipeline(pipeline: IMemoryAutoIngestPipeline): void {
    this.pipeline = pipeline;
  }

  /**
   * Record a tool failure. Extracts a lesson if the error matches
   * a known pattern and queues it for ingestion.
   */
  recordFailure(record: ToolFailureRecord): void {
    const pattern = FAILURE_PATTERNS.find((p) => p.match.test(record.error));
    if (!pattern) return; // Unknown error — skip

    // Dedup: don't save the same lesson for the same tool twice per session
    const dedupKey = `${record.toolName}:${pattern.match.source}`;
    if (this.savedLessons.has(dedupKey) || this.queuedLessons.has(dedupKey)) return;
    this.queuedLessons.add(dedupKey);

    // Extract site/URL from args for context
    const url = (record.args as any)?.url || (record.args as any)?.query || '';
    const site = typeof url === 'string' ? url.replace(/^https?:\/\//, '').split('/')[0] : '';
    const siteContext = site ? ` (${site})` : '';

    const lesson = `[Tool Lesson] "${record.toolName}"${siteContext} ${pattern.lesson}`;
    this.pendingLessons.push({ dedupKey, lesson });

    if (this.verbose) {
      console.debug(`[ToolFailureLearner] Queued: ${lesson}`);
    }
  }

  /**
   * Flush pending lessons to the auto-ingest pipeline.
   * Lessons are fed as synthetic "assistant" messages that the pipeline
   * will evaluate for importance and store if above threshold.
   */
  async flush(): Promise<number> {
    if (!this.pipeline || this.pendingLessons.length === 0) return 0;

    const lessons = this.pendingLessons.splice(0);
    const combined = lessons.map((entry) => entry.lesson).join('\n');

    try {
      await this.pipeline.processConversationTurn(
        this.conversationId,
        '[System: Recording tool usage lessons for future reference]',
        combined,
      );
      for (const entry of lessons) {
        this.queuedLessons.delete(entry.dedupKey);
        this.savedLessons.add(entry.dedupKey);
      }
      if (this.verbose) {
        console.debug(`[ToolFailureLearner] Flushed ${lessons.length} lesson(s) to RAG`);
      }
      return lessons.length;
    } catch {
      // Non-fatal — learning is best-effort
      this.pendingLessons.unshift(...lessons);
      return 0;
    }
  }

  /**
   * Get the lesson for a specific tool+error combo (for display).
   */
  static getLessonForError(toolName: string, error: string): string | null {
    const pattern = FAILURE_PATTERNS.find((p) => p.match.test(error));
    if (!pattern) return null;
    return `"${toolName}": ${pattern.lesson}`;
  }
}
