/**
 * @file ActionAuditLog.ts
 * @description In-memory ring buffer with optional persistence adapter for
 * logging all agent actions. Provides a post-mortem trail for debugging
 * runaway loops and compliance auditing.
 */

export interface AuditEntry {
  entryId: string;
  seedId: string;
  action: string;
  targetId?: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
  outcome: 'success' | 'failure' | 'deduplicated' | 'rate_limited' | 'circuit_open' | 'damped';
  durationMs?: number;
}

export interface IAuditPersistenceAdapter {
  appendEntries(entries: AuditEntry[]): Promise<void>;
  queryEntries(opts: {
    seedId?: string;
    action?: string;
    since?: number;
    limit?: number;
  }): Promise<AuditEntry[]>;
}

export interface ActionAuditLogConfig {
  /** Max entries to keep in memory. @default 1000 */
  maxInMemoryEntries: number;
  /** Flush to persistence adapter every N entries. @default 100 */
  flushThreshold: number;
}

const DEFAULT_CONFIG: ActionAuditLogConfig = {
  maxInMemoryEntries: 1000,
  flushThreshold: 100,
};

export class ActionAuditLog {
  private entries: AuditEntry[] = [];
  private pendingFlush: AuditEntry[] = [];
  private persistenceAdapter?: IAuditPersistenceAdapter;
  private config: ActionAuditLogConfig;

  constructor(config?: Partial<ActionAuditLogConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  setPersistenceAdapter(adapter: IAuditPersistenceAdapter): void {
    this.persistenceAdapter = adapter;
  }

  log(entry: Omit<AuditEntry, 'entryId' | 'timestamp'>): string {
    const entryId = `audit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const full: AuditEntry = {
      ...entry,
      entryId,
      timestamp: Date.now(),
    };

    this.entries.push(full);
    this.pendingFlush.push(full);

    // Ring buffer eviction
    while (this.entries.length > this.config.maxInMemoryEntries) {
      this.entries.shift();
    }

    // Auto-flush when threshold reached
    if (this.persistenceAdapter && this.pendingFlush.length >= this.config.flushThreshold) {
      void this.flush();
    }

    return entryId;
  }

  query(opts: { seedId?: string; action?: string; limit?: number }): AuditEntry[] {
    let results = this.entries;

    if (opts.seedId) {
      results = results.filter((e) => e.seedId === opts.seedId);
    }
    if (opts.action) {
      results = results.filter((e) => e.action === opts.action);
    }
    if (opts.limit) {
      results = results.slice(-opts.limit);
    }

    return results;
  }

  async flush(): Promise<void> {
    if (!this.persistenceAdapter || this.pendingFlush.length === 0) return;

    const batch = this.pendingFlush.splice(0);
    try {
      await this.persistenceAdapter.appendEntries(batch);
    } catch {
      // Put entries back on failure — best-effort persistence
      this.pendingFlush.unshift(...batch);
    }
  }

  getStats(): { total: number; byAgent: Record<string, number>; byAction: Record<string, number> } {
    const byAgent: Record<string, number> = {};
    const byAction: Record<string, number> = {};

    for (const entry of this.entries) {
      byAgent[entry.seedId] = (byAgent[entry.seedId] || 0) + 1;
      byAction[entry.action] = (byAction[entry.action] || 0) + 1;
    }

    return { total: this.entries.length, byAgent, byAction };
  }

  clear(): void {
    this.entries = [];
    this.pendingFlush = [];
  }
}
