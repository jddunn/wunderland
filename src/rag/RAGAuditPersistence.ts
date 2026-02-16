/**
 * @fileoverview SQL persistence for RAG audit trails.
 * Uses the sql-storage-adapter StorageAdapter interface for cross-platform support.
 * @module wunderland/rag/RAGAuditPersistence
 */

import type { RAGAuditTrail } from '@framers/agentos';

/** Minimal subset of StorageAdapter needed for audit persistence. */
interface StorageAdapterLike {
  exec(script: string): Promise<void>;
  run(statement: string, parameters?: unknown[]): Promise<{ changes: number }>;
  get<T>(statement: string, parameters?: unknown[]): Promise<T | null>;
  all<T>(statement: string, parameters?: unknown[]): Promise<T[]>;
}

interface AuditRow {
  trail_id: string;
  request_id: string;
  seed_id: string | null;
  session_id: string | null;
  query: string;
  timestamp: string;
  operations_json: string;
  summary_json: string;
  total_duration_ms: number | null;
  total_tokens: number | null;
  total_cost_usd: number | null;
  created_at: string;
}

export class RAGAuditPersistence {
  private schemaReady = false;

  constructor(private readonly db: StorageAdapterLike) {}

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;

    await this.db.exec(`
      CREATE TABLE IF NOT EXISTS rag_audit_trails (
        trail_id TEXT PRIMARY KEY,
        request_id TEXT NOT NULL,
        seed_id TEXT,
        session_id TEXT,
        query TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        operations_json TEXT NOT NULL,
        summary_json TEXT NOT NULL,
        total_duration_ms INTEGER,
        total_tokens INTEGER,
        total_cost_usd REAL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rat_seed ON rag_audit_trails(seed_id);
      CREATE INDEX IF NOT EXISTS idx_rat_ts ON rag_audit_trails(timestamp);
      CREATE INDEX IF NOT EXISTS idx_rat_session ON rag_audit_trails(session_id);
    `);

    this.schemaReady = true;
  }

  async store(trail: RAGAuditTrail): Promise<void> {
    await this.ensureSchema();

    await this.db.run(
      `INSERT OR REPLACE INTO rag_audit_trails
       (trail_id, request_id, seed_id, session_id, query, timestamp,
        operations_json, summary_json, total_duration_ms, total_tokens, total_cost_usd, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        trail.trailId,
        trail.requestId,
        trail.seedId ?? null,
        trail.sessionId ?? null,
        trail.query,
        trail.timestamp,
        JSON.stringify(trail.operations),
        JSON.stringify(trail.summary),
        trail.summary.totalDurationMs,
        trail.summary.totalTokens,
        trail.summary.totalCostUSD,
      ],
    );
  }

  async query(opts: {
    seedId?: string;
    sessionId?: string;
    since?: string;
    limit?: number;
  }): Promise<RAGAuditTrail[]> {
    await this.ensureSchema();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts.seedId) {
      conditions.push('seed_id = ?');
      params.push(opts.seedId);
    }
    if (opts.sessionId) {
      conditions.push('session_id = ?');
      params.push(opts.sessionId);
    }
    if (opts.since) {
      conditions.push('timestamp >= ?');
      params.push(opts.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts.limit ?? 20;
    params.push(limit);

    const rows = await this.db.all<AuditRow>(
      `SELECT * FROM rag_audit_trails ${where} ORDER BY timestamp DESC LIMIT ?`,
      params,
    );

    return rows.map(rowToTrail);
  }

  async getByTrailId(trailId: string): Promise<RAGAuditTrail | null> {
    await this.ensureSchema();

    const row = await this.db.get<AuditRow>(
      'SELECT * FROM rag_audit_trails WHERE trail_id = ?',
      [trailId],
    );

    return row ? rowToTrail(row) : null;
  }

  async pruneOlderThan(days: number): Promise<number> {
    await this.ensureSchema();

    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    const result = await this.db.run(
      'DELETE FROM rag_audit_trails WHERE timestamp < ?',
      [cutoff],
    );

    return result.changes;
  }
}

function rowToTrail(row: AuditRow): RAGAuditTrail {
  return {
    trailId: row.trail_id,
    requestId: row.request_id,
    seedId: row.seed_id ?? undefined,
    sessionId: row.session_id ?? undefined,
    query: row.query,
    timestamp: row.timestamp,
    operations: JSON.parse(row.operations_json),
    summary: JSON.parse(row.summary_json),
  };
}
