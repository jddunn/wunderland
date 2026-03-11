/**
 * @fileoverview Key-value state persistence for a single agent.
 * @module wunderland/storage/AgentStateStore
 */

import type { StorageAdapter } from '@framers/sql-storage-adapter';
import type { IAgentStateStore } from './types.js';

const TABLE = 'agent_state';

export class AgentStateStore implements IAgentStateStore {
  constructor(private readonly adapter: StorageAdapter) {}

  async initialize(): Promise<void> {
    await this.adapter.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async get<T = unknown>(key: string): Promise<T | null> {
    const row = await this.adapter.get<{ value: string }>(
      `SELECT value FROM ${TABLE} WHERE key = ?`,
      [key],
    );
    if (!row) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return row.value as unknown as T;
    }
  }

  async set<T = unknown>(key: string, value: T): Promise<void> {
    const json = JSON.stringify(value);
    const now = Date.now();
    await this.adapter.run(
      `INSERT INTO ${TABLE} (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, json, now],
    );
  }

  async delete(key: string): Promise<boolean> {
    const result = await this.adapter.run(
      `DELETE FROM ${TABLE} WHERE key = ?`,
      [key],
    );
    return result.changes > 0;
  }

  async list(prefix?: string): Promise<Array<{ key: string; value: unknown; updatedAt: number }>> {
    const query = prefix
      ? `SELECT key, value, updated_at FROM ${TABLE} WHERE key LIKE ? ORDER BY key`
      : `SELECT key, value, updated_at FROM ${TABLE} ORDER BY key`;
    const params = prefix ? [`${prefix}%`] : undefined;
    const rows = await this.adapter.all<{ key: string; value: string; updated_at: number }>(query, params);
    return rows.map((r) => {
      let parsed: unknown;
      try { parsed = JSON.parse(r.value); } catch { parsed = r.value; }
      return { key: r.key, value: parsed, updatedAt: r.updated_at };
    });
  }

  async clear(): Promise<void> {
    await this.adapter.run(`DELETE FROM ${TABLE}`);
  }
}
