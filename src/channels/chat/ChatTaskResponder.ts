// @ts-nocheck
/**
 * @fileoverview ChatTaskResponder — bridges incoming channel messages to
 * the AgentOS tool execution pipeline with security gating and conversation persistence.
 *
 * Flow:
 * 1. Security gate (tier + user whitelist)
 * 2. Load conversation history from SQLite
 * 3. Build message array with history + new user message
 * 4. Call LLM with tool pipeline (llmCallFn)
 * 5. Store both user and assistant messages
 * 6. Reply to the user via channel
 *
 * @module wunderland/chat/ChatTaskResponder
 */

import { ChatConversationStore } from './ChatConversationStore.js';
import { checkSecurity } from './ChannelSecurityGate.js';
import { resolveToolAllowlist } from './ToolAllowlistResolver.js';
import type { ChatTaskResponderConfig, ChannelContext, SecurityTier } from './types.js';

/**
 * Bridges incoming channel messages to the full AgentOS tool execution pipeline.
 * Handles security, conversation state, and response delivery.
 */
export class ChatTaskResponder {
  private store: ChatConversationStore;
  private allowedUsers: string[];
  private tier: SecurityTier;
  private toolAllowlist: string[] | null;
  private llmCallFn?: (messages: Array<{ role: string; content: string }>, tools?: unknown[]) => Promise<string>;

  constructor(config: ChatTaskResponderConfig) {
    this.store = new ChatConversationStore(
      config.dbPath ?? '/tmp/wunderland-chat.db',
      config.conversationHistoryLimit,
    );
    this.allowedUsers = config.allowedUsers;
    this.tier = config.securityTier;
    this.toolAllowlist = resolveToolAllowlist(config.securityTier);
    this.llmCallFn = config.llmCallFn;
  }

  /**
   * Handle an incoming message from a chat channel.
   *
   * @param messageText - The user's message text.
   * @param ctx - Channel context with platform info and reply/send functions.
   * @returns The assistant's text response (files are sent directly via ctx.sendFileFn).
   */
  async handle(messageText: string, ctx: ChannelContext): Promise<string> {
    // 1. Security gate
    const securityResult = checkSecurity(ctx.userId, this.allowedUsers);
    if (!securityResult.allowed) {
      await ctx.replyFn(securityResult.reason!);
      return securityResult.reason!;
    }

    // 2. Load conversation history
    const history = await this.store.getHistory(ctx.chatId);
    const messages = history.map(m => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: messageText });

    // 3. Store user message
    await this.store.addMessage({
      chatId: ctx.chatId,
      platform: ctx.platform,
      role: 'user',
      content: messageText,
    });

    // 4. Call LLM with tool pipeline
    let response: string;
    try {
      if (this.llmCallFn) {
        response = await this.llmCallFn(messages);
      } else {
        response = 'ChatTaskResponder: no LLM function configured. Please set llmCallFn in config.';
      }
    } catch (err) {
      response = 'Something went wrong. Try again or rephrase your request.';
    }

    // 5. Store assistant response
    await this.store.addMessage({
      chatId: ctx.chatId,
      platform: ctx.platform,
      role: 'assistant',
      content: response,
    });

    // 6. Send response to channel
    await ctx.replyFn(response);

    return response;
  }

  /** Get the tool allowlist for this responder's security tier. */
  getToolAllowlist(): string[] | null {
    return this.toolAllowlist;
  }

  /** Get the security tier. */
  getSecurityTier(): SecurityTier {
    return this.tier;
  }

  /** Close database connections. */
  close(): void {
    this.store.close();
  }
}
