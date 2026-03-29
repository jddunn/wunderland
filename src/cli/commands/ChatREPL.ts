/**
 * @fileoverview Interactive read-eval-print loop for the `wunderland chat` command.
 *
 * Extracted from `chat.ts` to isolate the interactive session lifecycle
 * (readline, slash commands, channel message bridging, REPL loop) from
 * the command entry point and bootstrap logic.
 *
 * The ChatREPL receives a fully bootstrapped agent state via its
 * constructor and delegates rendering to {@link ChatStreamRenderer}.
 *
 * @module wunderland/cli/commands/ChatREPL
 */

import { createInterface } from 'node:readline/promises';
import chalk from 'chalk';
import {
  success as sColor,
  warn as wColor,
  muted,
  dim,
  tool as tColor,
} from '../ui/theme.js';
import { glyphs } from '../ui/glyphs.js';
import {
  safeJsonStringify,
  type ToolInstance,
} from '../../runtime/tool-calling.js';
import {
  chatFrameGlyphs,
  getChatWidth,
  frameLine,
  frameBorder,
  C,
  chatPrompt,
} from './chat-ui.js';
import type { ChatStreamRenderer } from './ChatStreamRenderer.js';

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * A channel adapter instance for bidirectional messaging.
 *
 * When the CLI agent has channels configured (e.g. Telegram, Discord),
 * inbound messages arrive via these adapters and are processed in the REPL
 * alongside stdin input.
 */
export interface ChannelAdapterInstance {
  platform: string;
  displayName?: string;
  on: (handler: (event: any) => void, eventTypes?: string[]) => () => void;
  sendMessage: (conversationId: string, content: any) => Promise<any>;
  sendTypingIndicator?: (conversationId: string, isTyping: boolean) => Promise<void>;
  getConnectionInfo?: () => { status: string };
  shutdown?: () => Promise<void>;
}

/**
 * An incoming message from a connected channel.
 *
 * Queued by the channel adapter listener and dequeued by the REPL loop
 * for processing alongside stdin input.
 */
interface IncomingChannelMessage {
  platform: string;
  conversationId: string;
  senderName: string;
  text: string;
  adapter: ChannelAdapterInstance;
}

/**
 * Configuration for constructing a {@link ChatREPL}.
 *
 * Contains all the bootstrapped agent state needed to run the interactive
 * session — tool map, permission handlers, channel adapters, slash
 * command dependencies, and display configuration.
 */
export interface ChatREPLConfig {
  /** Map of tool name to tool instance. */
  toolMap: Map<string, ToolInstance>;
  /** Connected channel adapters for bidirectional messaging. */
  channelAdapters: ChannelAdapterInstance[];
  /** Whether tool calls auto-approve without HITL prompts. */
  autoApproveToolCalls: boolean;
  /** Whether verbose diagnostic output is enabled. */
  verbose: boolean;
  /** Whether the QueryRouter is enabled. */
  enableQueryRouter: boolean;

  /** Stream renderer for terminal output. */
  renderer: ChatStreamRenderer;

  /**
   * Run a single chat turn — sends the user's input through the full
   * LLM tool-calling loop and produces an assistant reply.
   *
   * @param input - The user's input text.
   * @param replyTarget - When the input came from a channel, the adapter and
   *   conversation ID to reply to.
   */
  runChatTurn: (
    input: string,
    replyTarget?: { adapter: ChannelAdapterInstance; conversationId: string },
  ) => Promise<void>;

  /**
   * Apply research prefix classification to the user's input.
   *
   * Handles explicit `/research` and `/deep` prefixes as well as
   * auto-classification via LLM-as-judge when enabled.
   *
   * @param input - The user's raw input text.
   * @returns The potentially-prefixed input text.
   */
  applyResearchPrefix: (input: string) => Promise<string>;

  // ── Slash command dependencies ─────────────────────────────────────────

  /** Conversation message history (mutable, includes system prompt at index 0). */
  messages: Array<Record<string, unknown>>;
  /** Context window manager for infinite context compaction. */
  contextWindowManager?: {
    enabled: boolean;
    getStats: () => {
      currentTokens: number;
      maxTokens: number;
      utilization: number;
      currentTurn: number;
      messageCount: number;
      compactedMessageCount: number;
      totalCompactions: number;
      avgCompressionRatio: number;
      totalTracesCreated: number;
      summaryChainNodes: number;
      summaryChainTokens: number;
      strategy: string;
    };
    getCompactionHistory: () => Array<{
      timestamp: number;
      turnRange: [number, number];
      inputTokens: number;
      outputTokens: number;
      compressionRatio: number;
      durationMs: number;
      preservedEntities: string[];
    }>;
    clear: () => void;
  };
  /** Discovery manager for capability stats. */
  discoveryManager?: {
    getStats: () => {
      enabled: boolean;
      initialized: boolean;
      capabilityCount: number;
      graphNodes: number;
      graphEdges: number;
      presetCoOccurrences: number;
      manifestDirs: string[];
      recallProfile: string;
    };
  } | null;
  /** Memory adapter for persisted conversation history. */
  memoryAdapter?: {
    deleteConversation?: (conversationId: string) => Promise<void>;
  };
  /** Stable conversation ID for persistence. */
  conversationId: string;
  /** QueryRouter accessor for /router slash command. */
  getCliQueryRouter?: () => {
    getCorpusStats: () => {
      initialized: boolean;
      configuredPathCount: number;
      chunkCount: number;
      sourceCount: number;
      topicCount: number;
      retrievalMode: string;
      embeddingDimension: number;
      rerankRuntimeMode: string;
      deepResearchEnabled: boolean;
      deepResearchRuntimeMode: string;
    };
  } | null;
}

/**
 * Interactive read-eval-print loop for the `wunderland chat` command.
 *
 * Manages the terminal readline interface, slash command dispatch,
 * channel message bridging, and the main input loop. Each user input
 * is routed through the configured `runChatTurn` callback for LLM
 * processing, while slash commands are handled locally.
 *
 * ## Lifecycle
 *
 * 1. {@link start} — enters the main loop, reads from stdin and channel queues.
 * 2. Slash commands are intercepted and handled without LLM calls.
 * 3. Regular input is passed to `runChatTurn` for tool-calling and reply.
 * 4. The loop exits on `/exit`, `exit`, or `quit`.
 * 5. {@link stop} — closes the readline interface and channel listeners.
 */
export class ChatREPL {
  private readonly config: ChatREPLConfig;
  private readonly rl: ReturnType<typeof createInterface>;

  /** Channel message queue for bridging async channel events into the REPL. */
  private readonly channelQueue: IncomingChannelMessage[] = [];
  private channelQueueResolve: (() => void) | null = null;
  /** Cleanup callbacks for channel adapter listeners. */
  private readonly channelCleanups: Array<() => void> = [];

  /** Session-scoped permission cache to avoid re-prompting for identical tool+args. */
  private readonly permissionCache = new Map<string, boolean>();
  /** When the user presses 'a' (accept all), all subsequent prompts auto-approve. */
  private sessionAcceptAll = false;

  constructor(config: ChatREPLConfig) {
    this.config = config;
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
  }

  /**
   * Interactive permission prompt for Tier 3 (sync HITL) tool calls.
   *
   * Supports three responses:
   * - `y` / `yes` — approve this specific call (cached for identical calls)
   * - `a` / `all` / `accept all` — approve all remaining calls this session
   * - anything else — deny
   *
   * @param tool - The tool requesting permission.
   * @param args - The arguments the tool will be called with.
   * @returns Whether the tool call is approved.
   */
  async askPermission(
    tool: ToolInstance,
    args: Record<string, unknown>,
  ): Promise<boolean> {
    if (this.config.autoApproveToolCalls || this.sessionAcceptAll) return true;
    const cacheKey = `${tool.name}:${safeJsonStringify(args, 400)}`;
    const cached = this.permissionCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const preview = safeJsonStringify(args, 800);
    const effectLabel = tool.hasSideEffects === true ? 'side effects' : 'read-only';
    const q = `  ${wColor(glyphs().warn)} Allow ${tColor(tool.name)} (${effectLabel})?\n${dim(preview)}\n  ${muted('[y/a(ccept all)/N]')} `;
    const answer = (await this.rl.question(q)).trim().toLowerCase();
    if (answer === 'a' || answer === 'all' || answer === 'accept all') {
      this.sessionAcceptAll = true;
      return true;
    }
    const result = answer === 'y' || answer === 'yes';
    this.permissionCache.set(cacheKey, result);
    return result;
  }

  /**
   * Checkpoint prompt for turn-approval modes (`after-each-round` / `after-each-turn`).
   *
   * @param info - Summary of the tools called in the current round.
   * @returns Whether the agent should continue executing.
   */
  async askCheckpoint(info: {
    round: number;
    toolCalls: Array<{
      toolName: string;
      hasSideEffects: boolean;
      args: Record<string, unknown>;
    }>;
  }): Promise<boolean> {
    if (this.config.autoApproveToolCalls) return true;
    const summary = info.toolCalls
      .map((c) => {
        const effect = c.hasSideEffects ? 'side effects' : 'read-only';
        const preview = safeJsonStringify(c.args, 600);
        return `- ${c.toolName} (${effect}): ${preview}`;
      })
      .join('\n');
    const q = `  ${wColor(glyphs().warn)} Checkpoint after round ${info.round}.\n${dim(summary || '(no tool calls)')}\n  ${muted('Continue? [y/N]')} `;
    const answer = (await this.rl.question(q)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  }

  /**
   * Folder access permission prompt for runtime folder access requests.
   *
   * @param req - The folder access request details.
   * @returns Whether folder access is granted.
   */
  async askFolderPermission(req: {
    path: string;
    operation: string;
    recursive?: boolean;
    reason: string;
  }): Promise<boolean> {
    if (this.sessionAcceptAll) return true;
    const cacheKey = `folder_access:${req.path}:${req.operation}`;
    const cached = this.permissionCache.get(cacheKey);
    if (cached !== undefined) return cached;
    const q = `  ${wColor(glyphs().warn)} Grant ${req.operation.toUpperCase()} access to ${tColor(req.path)}${req.recursive ? '/**' : ''}?\n  ${dim(`Reason: ${req.reason}`)}\n  ${muted('[y/a(ccept all)/N]')} `;
    const answer = (await this.rl.question(q)).trim().toLowerCase();
    if (answer === 'a' || answer === 'all' || answer === 'accept all') {
      this.sessionAcceptAll = true;
      return true;
    }
    const result = answer === 'y' || answer === 'yes';
    this.permissionCache.set(cacheKey, result);
    return result;
  }

  /**
   * Enter the main REPL loop.
   *
   * Reads user input from stdin and processes inbound channel messages
   * concurrently. The loop blocks on `rl.question()` when no channels
   * are connected, or races stdin against the channel message queue
   * when channels are active.
   *
   * Exits when the user types `/exit`, `exit`, or `quit`.
   */
  async start(): Promise<void> {
    // Wire up channel adapter listeners
    for (const adapter of this.config.channelAdapters) {
      const cleanup = adapter.on(
        (event: any) => {
          if (event?.type !== 'message') return;
          const data = event.data;
          this.enqueueChannelMessage({
            platform: data?.platform ?? (adapter as any).platform ?? 'unknown',
            conversationId: data?.conversationId ?? '',
            senderName:
              data?.sender?.displayName || data?.sender?.username || data?.sender?.id || 'unknown',
            text: data?.text ?? '',
            adapter,
          });
        },
        ['message'],
      );
      this.channelCleanups.push(cleanup);
    }

    const hasChannels = this.config.channelAdapters.length > 0;
    for (;;) {
      if (!hasChannels) {
        // No channels — simple blocking readline (original behavior, zero overhead)
        const line = await this.rl.question(chatPrompt());
        const input = (line || '').trim();
        if (!input) continue;
        if (input === '/exit' || input === 'exit' || input === 'quit') break;
        if (this.handleSlashCommand(input)) continue;
        await this.safeChatTurn(await this.config.applyResearchPrefix(input));
      } else {
        // Concurrent: race stdin vs channel message queue
        let stdinLine: string | undefined;
        let channelMsg: IncomingChannelMessage | undefined;

        const stdinPromise = this.rl.question(chatPrompt()).then((line) => {
          stdinLine = line;
        });
        const channelPromise = this.waitForChannelMessage().then(() => {
          channelMsg = this.channelQueue.shift();
        });

        await Promise.race([stdinPromise, channelPromise]);

        if (channelMsg) {
          const cm = channelMsg;
          const prefix = `[${cm.platform}/${cm.senderName}]`;
          console.log(
            `\n  ${frameBorder(chatFrameGlyphs().v)} ${chalk.hex(C.brightCyan)(prefix)} ${cm.text}`
          );
          await this.safeChatTurn(`${prefix} ${cm.text}`, {
            adapter: cm.adapter,
            conversationId: cm.conversationId,
          });
          // The pending stdinPromise stays live — it will resolve on the next iteration
        } else if (stdinLine !== undefined) {
          const input = (stdinLine || '').trim();
          if (!input) continue;
          if (input === '/exit' || input === 'exit' || input === 'quit') break;
          if (this.handleSlashCommand(input)) continue;
          await this.safeChatTurn(await this.config.applyResearchPrefix(input));
        }
      }
    }
  }

  /**
   * Clean up the REPL — close the readline interface and detach channel listeners.
   */
  stop(): void {
    for (const cleanup of this.channelCleanups) cleanup();
    this.rl.close();
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Enqueue an inbound channel message and wake the REPL if it is
   * waiting on the channel promise.
   */
  private enqueueChannelMessage(msg: IncomingChannelMessage): void {
    this.channelQueue.push(msg);
    if (this.channelQueueResolve) {
      this.channelQueueResolve();
      this.channelQueueResolve = null;
    }
  }

  /**
   * Returns a promise that resolves when at least one channel message
   * is available in the queue.
   */
  private waitForChannelMessage(): Promise<void> {
    if (this.channelQueue.length > 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.channelQueueResolve = resolve;
    });
  }

  /**
   * Wraps `runChatTurn` with error handling so network/LLM failures
   * don't crash the REPL. Errors are rendered via the stream renderer.
   */
  private async safeChatTurn(
    input: string,
    replyTarget?: { adapter: ChannelAdapterInstance; conversationId: string },
  ): Promise<void> {
    try {
      await this.config.runChatTurn(input, replyTarget);
    } catch (err) {
      this.config.renderer.renderTurnError(err);
    }
  }

  /**
   * Dispatch slash commands.
   *
   * @param input - The user's input text (expected to start with `/`).
   * @returns `true` if the input was a recognized slash command and was handled.
   */
  private handleSlashCommand(input: string): boolean {
    if (input === '/help') {
      const cw = getChatWidth();
      const iw = cw - 2;
      const helpLines: string[] = [];
      helpLines.push('');
      helpLines.push(
        frameLine(
          `   ${chalk.hex(C.cyan)('/help')}      ${chalk.hex(C.text)('Show this help')}`,
          iw
        )
      );
      helpLines.push(
        frameLine(
          `   ${chalk.hex(C.cyan)('/tools')}     ${chalk.hex(C.text)('List available tools')}`,
          iw
        )
      );
      helpLines.push(
        frameLine(
          `   ${chalk.hex(C.cyan)('/channels')}  ${chalk.hex(C.text)('Show connected channels')}`,
          iw
        )
      );
      helpLines.push(
        frameLine(
          `   ${chalk.hex(C.cyan)('/discover')}  ${chalk.hex(C.text)('Show discovery stats')}`,
          iw
        )
      );
      helpLines.push(
        frameLine(
          `   ${chalk.hex(C.cyan)('/memory')}    ${chalk.hex(C.text)('Show context window & compaction stats')}`,
          iw
        )
      );
      helpLines.push(
        frameLine(
          `   ${chalk.hex(C.cyan)('/clear')}     ${chalk.hex(C.text)('Clear conversation history')}`,
          iw
        )
      );
      helpLines.push(
        frameLine(
          `   ${chalk.hex(C.cyan)('/research')}  ${chalk.hex(C.text)('Deep research mode (prefix: /research <query>)')}`,
          iw
        )
      );
      helpLines.push(
        frameLine(
          `   ${chalk.hex(C.cyan)('/router')}    ${chalk.hex(C.text)('Show QueryRouter status & corpus stats')}`,
          iw
        )
      );
      helpLines.push(
        frameLine(`   ${chalk.hex(C.cyan)('/exit')}      ${chalk.hex(C.text)('Quit')}`, iw)
      );
      helpLines.push('');
      console.log(helpLines.join('\n'));
      return true;
    }

    if (input === '/tools') {
      const names = [...this.config.toolMap.keys()].sort();
      const cw = getChatWidth();
      const iw = cw - 2;
      const toolLines: string[] = [''];
      for (const n of names) {
        toolLines.push(frameLine(`   ${chalk.hex(C.magenta)(n)}`, iw));
      }
      toolLines.push('');
      console.log(toolLines.join('\n'));
      return true;
    }

    if (input === '/channels') {
      const cw = getChatWidth();
      const iw = cw - 2;
      const chLines: string[] = [''];
      if (this.config.channelAdapters.length === 0) {
        chLines.push(frameLine(`   ${muted('No channels connected')}`, iw));
      } else {
        for (const adapter of this.config.channelAdapters) {
          const info = adapter.getConnectionInfo?.();
          const status =
            info?.status === 'connected' ? sColor('connected') : wColor(info?.status ?? 'unknown');
          chLines.push(
            frameLine(
              `   ${chalk.hex(C.brightCyan)((adapter as any).displayName || (adapter as any).platform)} ${status}`,
              iw
            )
          );
        }
      }
      chLines.push('');
      console.log(chLines.join('\n'));
      return true;
    }

    if (input === '/discover') {
      const dStats = this.config.discoveryManager?.getStats() ?? {
        enabled: false,
        initialized: false,
        capabilityCount: 0,
        graphNodes: 0,
        graphEdges: 0,
        presetCoOccurrences: 0,
        manifestDirs: [],
        recallProfile: 'balanced',
      };
      const cw = getChatWidth();
      const iw = cw - 2;
      const dLines: string[] = [''];
      dLines.push(frameLine(`   ${chalk.hex(C.brightCyan)('Discovery Stats')}`, iw));
      dLines.push(
        frameLine(`   Enabled:       ${dStats.enabled ? sColor('yes') : wColor('no')}`, iw)
      );
      dLines.push(
        frameLine(`   Initialized:   ${dStats.initialized ? sColor('yes') : wColor('no')}`, iw)
      );
      dLines.push(frameLine(`   Capabilities:  ${dStats.capabilityCount}`, iw));
      dLines.push(frameLine(`   Graph nodes:   ${dStats.graphNodes}`, iw));
      dLines.push(frameLine(`   Graph edges:   ${dStats.graphEdges}`, iw));
      dLines.push(frameLine(`   Preset co-occ: ${dStats.presetCoOccurrences}`, iw));
      if (dStats.manifestDirs.length > 0) {
        dLines.push(frameLine(`   Manifest dirs: ${dStats.manifestDirs.join(', ')}`, iw));
      }
      dLines.push('');
      console.log(dLines.join('\n'));
      return true;
    }

    if (input === '/memory') {
      const cw = getChatWidth();
      const iw = cw - 2;
      const memLines: string[] = [''];
      memLines.push(frameLine(`   ${chalk.hex(C.brightCyan)('Context Window Status')}`, iw));
      if (this.config.contextWindowManager?.enabled) {
        const stats = this.config.contextWindowManager.getStats();
        memLines.push(frameLine(`   Enabled:       ${sColor('yes')} (${stats.strategy})`, iw));
        memLines.push(frameLine(`   Tokens:        ${stats.currentTokens} / ${stats.maxTokens} (${(stats.utilization * 100).toFixed(1)}%)`, iw));
        memLines.push(frameLine(`   Turn:          ${stats.currentTurn}`, iw));
        memLines.push(frameLine(`   Messages:      ${stats.messageCount} (${stats.compactedMessageCount} compacted)`, iw));
        memLines.push(frameLine(`   Compactions:   ${stats.totalCompactions}`, iw));
        if (stats.totalCompactions > 0) {
          memLines.push(frameLine(`   Avg compress:  ${stats.avgCompressionRatio}x`, iw));
          memLines.push(frameLine(`   Traces created:${stats.totalTracesCreated}`, iw));
          memLines.push(frameLine(`   Chain nodes:   ${stats.summaryChainNodes} (${stats.summaryChainTokens} tokens)`, iw));
        }
        // Show recent compaction entries
        const history = this.config.contextWindowManager.getCompactionHistory();
        if (history.length > 0) {
          memLines.push(frameLine(`   ${chalk.hex(C.brightCyan)('Recent Compactions')}`, iw));
          for (const entry of history.slice(-3)) {
            memLines.push(frameLine(
              `   [${new Date(entry.timestamp).toLocaleTimeString()}] turns ${entry.turnRange[0]}\u2013${entry.turnRange[1]}: ${entry.inputTokens}\u2192${entry.outputTokens} tokens (${entry.compressionRatio.toFixed(1)}x, ${entry.durationMs}ms)`,
              iw
            ));
            if (entry.preservedEntities.length > 0) {
              memLines.push(frameLine(`     entities: ${entry.preservedEntities.slice(0, 10).join(', ')}`, iw));
            }
          }
        }
      } else {
        memLines.push(frameLine(`   Enabled:       ${wColor('no')}`, iw));
        memLines.push(frameLine(`   ${muted('Set memory.infiniteContext.enabled: true in agent config')}`, iw));
      }
      memLines.push('');
      console.log(memLines.join('\n'));
      return true;
    }

    if (input === '/clear') {
      // Clear in-memory messages (keep only the system prompt)
      this.config.messages.splice(1);
      // Clear context window manager state
      this.config.contextWindowManager?.clear();
      // Clear persisted history
      if (this.config.memoryAdapter?.deleteConversation) {
        this.config.memoryAdapter.deleteConversation(this.config.conversationId).catch(() => {});
      }
      console.log(`  ${chalk.hex(C.dim)('Conversation history cleared.')}`);
      return true;
    }

    if (input === '/router') {
      const cw = getChatWidth();
      const iw = cw - 2;
      const rLines: string[] = [''];
      rLines.push(frameLine(`   ${chalk.hex(C.brightCyan)('QueryRouter Status')}`, iw));
      if (!this.config.enableQueryRouter) {
        rLines.push(frameLine(`   Enabled:       ${wColor('no')} (--no-query-router)`, iw));
      } else {
        const qr = this.config.getCliQueryRouter?.();
        if (qr) {
          const stats = qr.getCorpusStats();
          rLines.push(frameLine(`   Enabled:       ${sColor('yes')}`, iw));
          rLines.push(frameLine(`   Initialised:   ${stats.initialized ? sColor('yes') : wColor('no')}`, iw));
          rLines.push(frameLine(`   Corpus paths:  ${stats.configuredPathCount}`, iw));
          rLines.push(frameLine(`   Chunks:        ${stats.chunkCount}`, iw));
          rLines.push(frameLine(`   Sources:       ${stats.sourceCount}`, iw));
          rLines.push(frameLine(`   Topics:        ${stats.topicCount}`, iw));
          rLines.push(frameLine(`   Retrieval:     ${stats.retrievalMode}`, iw));
          rLines.push(frameLine(`   Embedding dim: ${stats.embeddingDimension}`, iw));
          rLines.push(frameLine(`   Rerank:        ${stats.rerankRuntimeMode}`, iw));
          rLines.push(frameLine(`   Deep research: ${stats.deepResearchEnabled ? sColor('yes') : wColor('no')} (${stats.deepResearchRuntimeMode})`, iw));
          rLines.push(frameLine(`   ${chalk.hex(C.brightCyan)('Platform knowledge')}: 243 entries (105 tools, 79 skills, 30 FAQ, 14 API, 15 troubleshooting)`, iw));
        } else {
          rLines.push(frameLine(`   Enabled:       ${wColor('pending')} (init in progress or failed)`, iw));
          rLines.push(frameLine(`   ${muted('The router initialises in the background. Try again shortly.')}`, iw));
        }
      }
      rLines.push('');
      console.log(rLines.join('\n'));
      return true;
    }

    return false;
  }
}
