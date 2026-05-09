// @ts-nocheck
/**
 * @fileoverview Terminal rendering for streaming chat output — tool call
 * display, assistant reply printing, widget extraction, and progress
 * indicators.
 *
 * Extracted from `chat.ts` to separate the rendering/display layer from
 * the REPL and command orchestration concerns.
 *
 * @module wunderland/cli/commands/ChatStreamRenderer
 */

import { exec } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import chalk from 'chalk';
import {
  accent,
  bright,
  warn as wColor,
  dim,
} from '../ui/theme.js';
import * as fmt from '../ui/format.js';
import {
  truncateString,
  type ToolInstance,
} from '../../runtime/tools/tool-calling.js';
import {
  chatFrameGlyphs,
  frameBorder,
  C,
  printAssistantReply,
} from './chat-ui.js';

/**
 * Configuration for constructing a {@link ChatStreamRenderer}.
 *
 * All callback fields are optional — when omitted the renderer simply
 * skips the corresponding display step (e.g. no progress indicator,
 * no fallback notice).
 */
export interface ChatStreamRendererConfig {
  /** Whether to print verbose diagnostic output. */
  verbose: boolean;
}

/**
 * Handles all terminal rendering during a chat turn:
 *
 * - Tool call invocation display (name + truncated args)
 * - Tool progress indicators for long-running tools
 * - Fallback provider notices
 * - Assistant reply printing with widget block extraction
 * - Widget HTML persistence and browser-open
 *
 * This class is stateless between turns — each method call is
 * self-contained and produces terminal output immediately.
 */
export class ChatStreamRenderer {
  private readonly verbose: boolean;

  constructor(config: ChatStreamRendererConfig) {
    this.verbose = config.verbose;
  }

  /**
   * Render a tool call invocation line in the chat frame.
   *
   * Displays the tool name in magenta and a truncated JSON preview of the
   * arguments in dim text, aligned to the chat frame border.
   *
   * @param tool - The tool instance being called.
   * @param args - The arguments passed to the tool.
   */
  renderToolCall(tool: ToolInstance, args: Record<string, unknown>): void {
    console.log(
      `  ${frameBorder(chatFrameGlyphs().v)} ${chalk.hex(C.magenta)('>')} ${chalk.hex(C.magenta)(tool.name)} ${chalk.hex(C.dim)(truncateString(JSON.stringify(args), 120))}`
    );
  }

  /**
   * Render a tool progress indicator for long-running tool executions.
   *
   * Used by tools like `deep_research` that emit intermediate progress
   * events during execution. Shows a magnifying glass icon, tool name
   * label, and the progress message.
   *
   * @param info - Progress event containing tool name and message.
   */
  renderToolProgress(info: {
    toolName: string;
    phase: string;
    message: string;
    progress?: number;
  }): void {
    const icon = chalk.hex(C.cyan)('\u{1F50D}');
    const label = chalk.hex(C.cyan)(`[${info.toolName}]`);
    const msg = chalk.hex(C.dim)(info.message);
    console.log(`  ${frameBorder(chatFrameGlyphs().v)} ${icon} ${label} ${msg}`);
  }

  /**
   * Render a fallback provider notice when the primary LLM provider fails
   * and the system automatically switches to a fallback.
   *
   * @param provider - The name of the fallback provider being used.
   */
  renderFallbackNotice(provider: string): void {
    console.log(
      `  ${frameBorder(chatFrameGlyphs().v)} ${wColor('!')} Primary provider failed, falling back to ${chalk.hex(C.cyan)(provider)}`
    );
  }

  /**
   * Render context window compaction stats after a compaction event.
   *
   * Only displayed when verbose mode is enabled. Shows the current token
   * count, total compactions, and the active strategy.
   *
   * @param stats - Context window statistics after compaction.
   */
  renderCompactionStats(stats: {
    currentTokens: number;
    totalCompactions: number;
    strategy: string;
  }): void {
    if (!this.verbose) return;
    console.log(
      `  ${frameBorder(chatFrameGlyphs().v)} ${dim(`[context compacted: ${stats.currentTokens} tokens, ${stats.totalCompactions} compactions, ${stats.strategy} strategy]`)}`
    );
  }

  /**
   * Render a QueryRouter diagnostic line (verbose only).
   *
   * Shows the classification tier, confidence score, retrieval strategy,
   * source count, any fallback retrievers used, reasoning text, and
   * the total route duration.
   *
   * @param routerResult - The QueryRouter result with classification and sources.
   * @param durationMs - How long the route call took.
   */
  renderQueryRouterDiag(routerResult: {
    classification: {
      tier: number;
      confidence: number;
      strategy: string;
      reasoning: string;
    };
    sources?: unknown[];
    fallbacksUsed?: string[];
    recommendations?: {
      skills: Array<{ skillId: string }>;
      tools: Array<{ toolId: string }>;
      extensions: Array<{ extensionId: string }>;
    };
  }, durationMs: number): void {
    if (!this.verbose) return;
    const c = routerResult.classification;
    const srcCount = routerResult.sources?.length ?? 0;
    const fallbacks = routerResult.fallbacksUsed?.length
      ? ` fallbacks=[${routerResult.fallbacksUsed.join(',')}]`
      : '';

    // Format capability recommendations for the diagnostic line
    let recsLabel = '';
    if (routerResult.recommendations) {
      const r = routerResult.recommendations;
      const recParts: string[] = [];
      if (r.skills.length) recParts.push(`skills=[${r.skills.map((s) => s.skillId).join(',')}]`);
      if (r.tools.length) recParts.push(`tools=[${r.tools.map((t) => t.toolId).join(',')}]`);
      if (r.extensions.length) recParts.push(`exts=[${r.extensions.map((e) => e.extensionId).join(',')}]`);
      if (recParts.length) recsLabel = ` recs={${recParts.join(' ')}}`;
    }

    console.log(
      `  ${frameBorder(chatFrameGlyphs().v)} ${dim(`[QueryRouter] tier=${c.tier} confidence=${c.confidence.toFixed(2)} strategy=${c.strategy} sources=${srcCount}${fallbacks}${recsLabel} reasoning="${c.reasoning}" | ${durationMs}ms`)}`
    );
  }

  /**
   * Render a research classifier annotation (verbose only).
   *
   * @param depth - The classified research depth.
   * @param reasoning - The classifier's reasoning text.
   * @param latencyMs - How long the classification took.
   */
  renderResearchClassification(depth: string, reasoning: string, latencyMs: number): void {
    if (!this.verbose) return;
    console.log(
      `  ${frameBorder(chatFrameGlyphs().v)} ${chalk.hex(C.magenta)(`[auto-research:${depth}]`)} ${chalk.hex(C.dim)(reasoning)} ${chalk.hex(C.dim)(`(${latencyMs}ms`)}`
    );
  }

  /**
   * Render an explicit research prefix annotation.
   *
   * @param depth - The research depth (e.g. 'moderate', 'deep').
   * @param query - The user's original query text.
   */
  renderExplicitResearch(depth: string, query: string): void {
    console.log(
      `  ${frameBorder(chatFrameGlyphs().v)} ${chalk.hex(C.magenta)(`[research:${depth}]`)} ${query}`
    );
  }

  /**
   * Process and render the assistant's reply text.
   *
   * Handles widget block detection: when the reply contains `:::widget`
   * fenced blocks with self-contained HTML, each block is extracted,
   * persisted to the filesystem, and opened in the user's default browser.
   * The raw HTML is replaced with a short placeholder in the terminal output.
   *
   * @param reply - The raw assistant reply text.
   * @returns The display-safe reply with widget blocks replaced.
   */
  async renderAssistantReply(reply: string): Promise<string> {
    // Widget block detection
    const widgetMatches = [...reply.matchAll(/:::widget\n([\s\S]*?)\n:::/g)];
    for (let i = 0; i < widgetMatches.length; i++) {
      const widgetHtml = widgetMatches[i][1];
      const titleMatch = widgetHtml.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : `widget-${i + 1}`;
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

      const widgetsDir = path.join(process.cwd(), 'widgets');
      await mkdir(widgetsDir, { recursive: true });
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const filename = `${timestamp}-${slug}.html`;
      const filePath = path.join(widgetsDir, filename);
      await writeFile(filePath, widgetHtml, 'utf-8');

      // Print widget info below the chat frame
      console.log();
      console.log(`  ${accent('\u25C6')} Widget: ${bright(title)}`);
      console.log(`    ${dim('File:')} ${filePath}`);

      // Open in the user's default browser (fire-and-forget)
      const openCmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start'
        : 'xdg-open';
      exec(`${openCmd} "${filePath}"`);
    }

    // Strip widget blocks from the terminal display
    const displayReply = widgetMatches.length > 0
      ? reply.replace(/:::widget\n[\s\S]*?\n:::/g, '\n  [Interactive Widget \u2014 opened in browser]\n')
      : reply;

    printAssistantReply(displayReply);
    return displayReply;
  }

  /**
   * Render an error block in the terminal.
   *
   * Distinguishes network errors from generic errors and shows a
   * user-friendly message for connectivity issues.
   *
   * @param err - The error that occurred during the chat turn.
   */
  renderTurnError(err: unknown): void {
    const errMsg = err instanceof Error ? err.message : String(err);
    const isNetwork =
      /fetch failed|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network.*error|Network error|unable to reach/i.test(
        errMsg
      );
    if (isNetwork) {
      fmt.errorBlock(
        'Network error',
        'Could not reach the LLM provider. Check your internet connection and try again.'
      );
    } else {
      fmt.errorBlock('Error', errMsg.length > 300 ? errMsg.slice(0, 300) + '\u2026' : errMsg);
    }
  }
}
