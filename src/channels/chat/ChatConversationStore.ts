// @ts-nocheck
/**
 * @fileoverview SQLite-backed conversation persistence for chat channels.
 *
 * Stores per-chatId message history with a configurable limit. Uses better-sqlite3
 * for synchronous SQLite operations (fast, no async overhead for simple queries).
 * Automatically trims history when the limit is exceeded.
 *
 * @module wunderland/chat/ChatConversationStore
 */

import type { ConversationMessage } from './types.js';

/**
 * Persists conversation history in SQLite for chat task responder sessions.
 * Each conversation is keyed by chatId and trimmed to a configurable limit.
 */
export class ChatConversationStore {
  private db: any;
  private dbPath: string;
  private limit: number;
  private initialized = false;

  /**
   * @param dbPath - Path to the SQLite database file.
   * @param limit - Maximum messages per conversation (oldest trimmed first).
   */
  constructor(dbPath: string, limit: number = 50) {
    this.dbPath = dbPath;
    this.limit = limit;
  }

  /** Lazy-initialize the database on first access. */
  private async ensureDb(): Promise<void> {
    if (this.initialized) return;
    const { default: Database } = await import('better-sqlite3');
    this.db = new Database(this.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        tool_calls TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_chat_conv_chat_id ON chat_conversations(chat_id);
    `);
    this.initialized = true;
  }

  /** Add a message to the conversation history. Trims excess if over limit. */
  async addMessage(msg: Omit<ConversationMessage, 'id' | 'createdAt'>): Promise<void> {
    await this.ensureDb();
    this.db.prepare(
      'INSERT INTO chat_conversations (chat_id, platform, role, content, tool_calls) VALUES (?, ?, ?, ?, ?)'
    ).run(msg.chatId, msg.platform, msg.role, msg.content, msg.toolCalls ?? null);

    const count = this.db.prepare(
      'SELECT COUNT(*) as c FROM chat_conversations WHERE chat_id = ?'
    ).get(msg.chatId).c;

    if (count > this.limit) {
      const excess = count - this.limit;
      this.db.prepare(
        'DELETE FROM chat_conversations WHERE id IN (SELECT id FROM chat_conversations WHERE chat_id = ? ORDER BY id ASC LIMIT ?)'
      ).run(msg.chatId, excess);
    }
  }

  /** Get recent conversation history for a chat, ordered oldest first. */
  async getHistory(chatId: string): Promise<ConversationMessage[]> {
    await this.ensureDb();
    return this.db.prepare(
      'SELECT * FROM chat_conversations WHERE chat_id = ? ORDER BY id ASC LIMIT ?'
    ).all(chatId, this.limit);
  }

  /** Close the database connection. */
  close(): void {
    this.db?.close();
  }
}
