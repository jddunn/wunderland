// @ts-nocheck
/**
 * @fileoverview Per-agent conversation memory backed by a shared StorageAdapter.
 * @module wunderland/storage/AgentMemoryAdapter
 *
 * Reuses the same SQL schema as backend SqliteMemoryAdapter but scoped to
 * a single agent (no userId column needed — the entire DB is per-agent).
 */

import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type {
  IAgentMemoryAdapter,
  AgentConversationTurn,
  AgentConversationSummary,
} from './types.js';
import { v4 as uuidv4 } from 'uuid';

export class AgentMemoryAdapter implements IAgentMemoryAdapter {
  constructor(
    private readonly adapter: StorageAdapter,
    private readonly agentId: string,
  ) {}

  async initialize(): Promise<void> {
    await this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS conversations (
        conversationId TEXT PRIMARY KEY,
        agentId TEXT,
        createdAt INTEGER NOT NULL,
        lastActivity INTEGER NOT NULL,
        summary TEXT,
        title TEXT,
        persona TEXT
      );

      CREATE TABLE IF NOT EXISTS conversation_turns (
        storageId TEXT PRIMARY KEY,
        conversationId TEXT NOT NULL,
        agentId TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
        content TEXT,
        timestamp INTEGER NOT NULL,
        model TEXT,
        prompt_tokens INTEGER,
        completion_tokens INTEGER,
        total_tokens INTEGER,
        tool_calls TEXT,
        tool_call_id TEXT,
        metadata TEXT,
        summary TEXT,
        FOREIGN KEY (conversationId) REFERENCES conversations(conversationId)
      );

      CREATE INDEX IF NOT EXISTS idx_turns_conv
        ON conversation_turns(conversationId, timestamp);
    `);
  }

  async storeConversationTurn(
    conversationId: string,
    turn: AgentConversationTurn,
  ): Promise<string> {
    const storageId = turn.storageId || uuidv4();
    const now = turn.timestamp || Date.now();

    // Ensure conversation exists
    await this.adapter.run(
      `INSERT INTO conversations (conversationId, agentId, createdAt, lastActivity)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversationId) DO UPDATE SET lastActivity = excluded.lastActivity`,
      [conversationId, this.agentId, now, now],
    );

    await this.adapter.run(
      `INSERT INTO conversation_turns
       (storageId, conversationId, agentId, role, content, timestamp,
        model, prompt_tokens, completion_tokens, total_tokens,
        tool_calls, tool_call_id, metadata, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        storageId,
        conversationId,
        turn.agentId || this.agentId,
        turn.role,
        turn.content,
        now,
        turn.model ?? null,
        turn.promptTokens ?? null,
        turn.completionTokens ?? null,
        turn.totalTokens ?? null,
        turn.toolCalls ?? null,
        turn.toolCallId ?? null,
        turn.metadata ? JSON.stringify(turn.metadata) : null,
        turn.summary ?? null,
      ],
    );

    return storageId;
  }

  async retrieveConversationTurns(
    conversationId: string,
    options?: { limit?: number; beforeTimestamp?: number },
  ): Promise<AgentConversationTurn[]> {
    let sql = `SELECT * FROM conversation_turns WHERE conversationId = ?`;
    const params: unknown[] = [conversationId];

    if (options?.beforeTimestamp) {
      sql += ` AND timestamp < ?`;
      params.push(options.beforeTimestamp);
    }

    sql += ` ORDER BY timestamp ASC`;

    if (options?.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    const rows = await this.adapter.all<Record<string, unknown>>(sql, params);
    return rows.map(toTurn);
  }

  async listConversations(
    limit = 50,
    offset = 0,
  ): Promise<AgentConversationSummary[]> {
    const rows = await this.adapter.all<Record<string, unknown>>(
      `SELECT c.conversationId, c.lastActivity, c.agentId, c.summary, c.persona,
              (SELECT COUNT(*) FROM conversation_turns t WHERE t.conversationId = c.conversationId) as turnCount
       FROM conversations c
       ORDER BY c.lastActivity DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    return rows.map((r) => ({
      conversationId: r['conversationId'] as string,
      lastActivity: r['lastActivity'] as number,
      agentId: r['agentId'] as string | undefined,
      summary: r['summary'] as string | undefined,
      turnCount: r['turnCount'] as number | undefined,
      persona: r['persona'] as string | null | undefined,
    }));
  }

  async setConversationPersona(conversationId: string, persona: string | null): Promise<void> {
    await this.adapter.run(
      `UPDATE conversations SET persona = ? WHERE conversationId = ?`,
      [persona, conversationId],
    );
  }

  async getConversationPersona(conversationId: string): Promise<string | null> {
    const row = await this.adapter.get<{ persona: string | null }>(
      `SELECT persona FROM conversations WHERE conversationId = ?`,
      [conversationId],
    );
    return row?.persona ?? null;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    await this.adapter.run(`DELETE FROM conversation_turns WHERE conversationId = ?`, [conversationId]);
    await this.adapter.run(`DELETE FROM conversations WHERE conversationId = ?`, [conversationId]);
  }

  async disconnect(): Promise<void> {
    // Adapter lifecycle managed by AgentStorageManager
  }
}

function toTurn(row: Record<string, unknown>): AgentConversationTurn {
  let metadata: Record<string, unknown> | undefined;
  if (row['metadata'] && typeof row['metadata'] === 'string') {
    try { metadata = JSON.parse(row['metadata']); } catch { /* ignore */ }
  }
  return {
    storageId: row['storageId'] as string,
    conversationId: row['conversationId'] as string,
    agentId: row['agentId'] as string,
    role: row['role'] as AgentConversationTurn['role'],
    content: row['content'] as string | null,
    timestamp: row['timestamp'] as number,
    model: row['model'] as string | undefined,
    promptTokens: row['prompt_tokens'] as number | undefined,
    completionTokens: row['completion_tokens'] as number | undefined,
    totalTokens: row['total_tokens'] as number | undefined,
    toolCalls: row['tool_calls'] as string | undefined,
    toolCallId: row['tool_call_id'] as string | undefined,
    metadata,
    summary: row['summary'] as string | undefined,
  };
}
