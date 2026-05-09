// @ts-nocheck
/**
 * @fileoverview Shared types for the chat task responder system.
 *
 * Defines security tiers, channel context, and configuration interfaces
 * used by the ChatTaskResponder, security gate, and conversation store.
 *
 * @module wunderland/chat/types
 */

/** Security tier controlling which tools are available via messaging channels. */
export type SecurityTier = 'strict' | 'balanced' | 'permissive';

/** Channel context passed through the tool execution pipeline. */
export interface ChannelContext {
  /** Platform identifier (telegram, whatsapp, discord, slack, etc). */
  platform: string;
  /** Chat/conversation ID on the platform. */
  chatId: string;
  /** Sender user ID on the platform. */
  userId: string;
  /** Send a file to the current chat. */
  sendFileFn: (filePath: string, caption?: string) => Promise<void>;
  /** Send a text reply to the current chat. */
  replyFn: (text: string) => Promise<void>;
}

/** Configuration for a single chat channel in agent.config.json. */
export interface ChannelConfig {
  /** Whether this channel is enabled. */
  enabled: boolean;
  /** Security tier for tool access. */
  securityTier: SecurityTier;
  /** User IDs allowed to invoke tools. Empty = all users allowed. */
  allowedUsers: string[];
  /** Maximum conversation history messages to retain per chat. */
  conversationHistoryLimit: number;
  /** Platform-specific settings (token, phone number, webhook port, etc). */
  [key: string]: unknown;
}

/** Configuration for the ChatTaskResponder. */
export interface ChatTaskResponderConfig {
  /** Security tier for this responder instance. */
  securityTier: SecurityTier;
  /** User IDs allowed to trigger tools. Empty = all users. */
  allowedUsers: string[];
  /** Max messages to retain per conversation. */
  conversationHistoryLimit: number;
  /** SQLite database path for conversation persistence. */
  dbPath?: string;
  /** LLM call function — invoked with message history, returns assistant response. */
  llmCallFn?: (messages: Array<{ role: string; content: string }>, tools?: unknown[]) => Promise<string>;
}

/** A stored conversation message. */
export interface ConversationMessage {
  /** Auto-increment ID. */
  id?: number;
  /** Chat/conversation ID. */
  chatId: string;
  /** Platform identifier. */
  platform: string;
  /** Message role. */
  role: 'user' | 'assistant';
  /** Message text content. */
  content: string;
  /** JSON-serialized tool calls (for context). */
  toolCalls?: string;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
}
