/**
 * @fileoverview Rolling task-outcome telemetry + adaptive execution policy for Wunderland runtimes.
 * @module wunderland/runtime/adaptive-execution
 */

import {
  resolveStorageAdapter,
  type StorageAdapter,
  type StorageResolutionOptions,
} from '@framers/sql-storage-adapter';
import type {
  WunderlandAdaptiveExecutionConfig,
  WunderlandTaskOutcomeTelemetryConfig,
  WunderlandTaskOutcomeTelemetryScope,
  WunderlandToolFailureMode,
} from '../api/types.js';

type LoggerLike = {
  debug?: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
};

type TaskOutcomeStatus = 'success' | 'partial' | 'failed';

type TaskOutcomeAssessment = {
  status: TaskOutcomeStatus;
  score: number;
  reason: string;
  source: 'heuristic' | 'override';
};

type TaskOutcomeKpiWindowEntry = {
  status: TaskOutcomeStatus;
  score: number;
  timestamp: number;
};

export type WunderlandTaskOutcomeKpiSummary = {
  scopeKey: string;
  scopeMode: WunderlandTaskOutcomeTelemetryScope;
  windowSize: number;
  sampleCount: number;
  successCount: number;
  partialCount: number;
  failedCount: number;
  successRate: number;
  averageScore: number;
  weightedSuccessRate: number;
  timestamp: string;
};

export type WunderlandTaskOutcomeKpiAlert = {
  scopeKey: string;
  severity: 'warning' | 'critical';
  reason: string;
  threshold: number;
  value: number;
  sampleCount: number;
  timestamp: string;
};

type ResolvedTaskOutcomeTelemetryConfig = {
  enabled: boolean;
  rollingWindowSize: number;
  scope: WunderlandTaskOutcomeTelemetryScope;
  persist: boolean;
  tableName: string;
  storage: StorageResolutionOptions;
  emitAlerts: boolean;
  alertBelowWeightedSuccessRate: number;
  alertMinSamples: number;
  alertCooldownMs: number;
};

type ResolvedAdaptiveExecutionConfig = {
  enabled: boolean;
  minSamples: number;
  minWeightedSuccessRate: number;
  forceAllToolsWhenDegraded: boolean;
  forceFailOpenWhenDegraded: boolean;
};

export type WunderlandAdaptiveExecutionDecision = {
  scopeKey: string;
  toolFailureMode: WunderlandToolFailureMode;
  degraded: boolean;
  kpi: WunderlandTaskOutcomeKpiSummary | null;
  reason?: string;
  actions?: {
    forcedToolSelectionMode?: boolean;
    forcedToolFailureMode?: boolean;
    preservedRequestedFailClosed?: boolean;
  };
};

export type WunderlandAdaptiveTurnScope = {
  sessionId?: string;
  userId?: string;
  personaId?: string;
  tenantId?: string;
};

export type WunderlandAdaptiveExecutionRuntimeConfig = {
  toolFailureMode?: unknown;
  taskOutcomeTelemetry?: WunderlandTaskOutcomeTelemetryConfig;
  adaptiveExecution?: WunderlandAdaptiveExecutionConfig;
  logger?: LoggerLike;
};

const DEFAULT_TABLE_NAME = 'wunderland_task_outcome_kpi_windows';

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const v = Math.trunc(n);
  if (v < min) return min;
  if (v > max) return max;
  return v;
}

function sanitizeTableName(tableName: string): string {
  const normalized = String(tableName || '').trim();
  if (!normalized) return DEFAULT_TABLE_NAME;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(normalized)) {
    throw new Error(`Invalid tableName '${tableName}'. Use letters, numbers, and underscores only.`);
  }
  return normalized;
}

function sanitizeKpiEntry(raw: any): TaskOutcomeKpiWindowEntry | null {
  const status = raw?.status;
  const validStatus: TaskOutcomeStatus | null =
    status === 'success' || status === 'partial' || status === 'failed' ? status : null;
  if (!validStatus) return null;

  const scoreNum = Number(raw?.score);
  const timestampNum = Number(raw?.timestamp);
  if (!Number.isFinite(scoreNum) || !Number.isFinite(timestampNum)) return null;

  return {
    status: validStatus,
    score: Math.max(0, Math.min(1, scoreNum)),
    timestamp: Math.max(0, Math.trunc(timestampNum)),
  };
}

export function normalizeToolFailureMode(
  raw: unknown,
  fallback: WunderlandToolFailureMode = 'fail_open',
): WunderlandToolFailureMode {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'fail_closed') return 'fail_closed';
  if (v === 'fail_open') return 'fail_open';
  return fallback;
}

function maybeParseExplicitToolFailureMode(raw: unknown): WunderlandToolFailureMode | null {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (v === 'fail_closed') return 'fail_closed';
  if (v === 'fail_open') return 'fail_open';
  return null;
}

function resolveTaskOutcomeTelemetryConfig(
  config: WunderlandTaskOutcomeTelemetryConfig | undefined,
): ResolvedTaskOutcomeTelemetryConfig {
  const scopeRaw = typeof config?.scope === 'string' ? config.scope.trim().toLowerCase() : '';
  const scope: WunderlandTaskOutcomeTelemetryScope =
    scopeRaw === 'global'
    || scopeRaw === 'session'
    || scopeRaw === 'persona'
    || scopeRaw === 'tenant'
      ? (scopeRaw as WunderlandTaskOutcomeTelemetryScope)
      : 'tenant_persona';

  return {
    enabled: config?.enabled !== false,
    rollingWindowSize: clampInteger(config?.rollingWindowSize, 100, 5, 5000),
    scope,
    persist: config?.persist !== false,
    tableName: sanitizeTableName(config?.tableName ?? DEFAULT_TABLE_NAME),
    storage: { ...(config?.storage ?? {}) },
    emitAlerts: config?.emitAlerts !== false,
    alertBelowWeightedSuccessRate: Math.max(
      0,
      Math.min(1, Number(config?.alertBelowWeightedSuccessRate ?? 0.55)),
    ),
    alertMinSamples: clampInteger(config?.alertMinSamples, 8, 1, 10000),
    alertCooldownMs: clampInteger(config?.alertCooldownMs, 60000, 0, 86400000),
  };
}

function resolveAdaptiveExecutionConfig(
  config: WunderlandAdaptiveExecutionConfig | undefined,
): ResolvedAdaptiveExecutionConfig {
  return {
    enabled: config?.enabled !== false,
    minSamples: clampInteger(config?.minSamples, 5, 1, 1000),
    minWeightedSuccessRate: Math.max(
      0,
      Math.min(1, Number(config?.minWeightedSuccessRate ?? 0.7)),
    ),
    forceAllToolsWhenDegraded: config?.forceAllToolsWhenDegraded !== false,
    forceFailOpenWhenDegraded: config?.forceFailOpenWhenDegraded !== false,
  };
}

function evaluateTaskOutcome(args: {
  replyText: string;
  didFail: boolean;
  degraded: boolean;
  toolCallCount: number;
  statusOverride?: TaskOutcomeStatus;
  scoreOverride?: number;
}): TaskOutcomeAssessment {
  const overrideStatus = args.statusOverride;
  if (overrideStatus) {
    const normalizedScore = Number.isFinite(args.scoreOverride)
      ? Math.max(0, Math.min(1, Number(args.scoreOverride)))
      : overrideStatus === 'success'
        ? 1
        : overrideStatus === 'partial'
          ? 0.6
          : 0;
    return {
      status: overrideStatus,
      score: normalizedScore,
      reason: 'taskOutcome override applied.',
      source: 'override',
    };
  }

  if (args.didFail) {
    return {
      status: 'failed',
      score: 0,
      reason: 'Turn ended with a runtime failure.',
      source: 'heuristic',
    };
  }

  const text = String(args.replyText || '').trim();
  if (text.length >= 48) {
    return {
      status: 'success',
      score: args.degraded ? 0.85 : 0.95,
      reason: 'Turn produced a complete response.',
      source: 'heuristic',
    };
  }

  if (text.length > 0 || args.toolCallCount > 0) {
    return {
      status: 'partial',
      score: args.degraded ? 0.5 : 0.6,
      reason: 'Turn completed with a limited response.',
      source: 'heuristic',
    };
  }

  return {
    status: 'failed',
    score: 0.1,
    reason: 'No usable response was produced.',
    source: 'heuristic',
  };
}

export class WunderlandAdaptiveExecutionRuntime {
  private readonly logger: LoggerLike;
  private readonly telemetry: ResolvedTaskOutcomeTelemetryConfig;
  private readonly adaptive: ResolvedAdaptiveExecutionConfig;
  private readonly defaultToolFailureMode: WunderlandToolFailureMode;
  private readonly kpiWindows = new Map<string, TaskOutcomeKpiWindowEntry[]>();
  private readonly alertState = new Map<string, number>();
  private storageAdapter: StorageAdapter | null = null;
  private storageInitialized = false;

  constructor(config: WunderlandAdaptiveExecutionRuntimeConfig = {}) {
    this.logger = config.logger ?? {};
    this.telemetry = resolveTaskOutcomeTelemetryConfig(config.taskOutcomeTelemetry);
    this.adaptive = resolveAdaptiveExecutionConfig(config.adaptiveExecution);
    this.defaultToolFailureMode = normalizeToolFailureMode(config.toolFailureMode, 'fail_open');
  }

  async initialize(): Promise<void> {
    if (!this.telemetry.enabled || !this.telemetry.persist || this.storageInitialized) return;

    try {
      this.storageAdapter = await resolveStorageAdapter(this.telemetry.storage);
      await this.ensureStorageSchema();

      const rows = await this.storageAdapter.all<{ scope_key: string; entries_json: string }>(
        `SELECT scope_key, entries_json FROM ${this.telemetry.tableName}`,
      );

      const cap = this.telemetry.rollingWindowSize;
      for (const row of rows) {
        const scopeKey = typeof row?.scope_key === 'string' ? row.scope_key.trim() : '';
        if (!scopeKey) continue;
        try {
          const parsed = JSON.parse(String(row.entries_json ?? '[]'));
          if (!Array.isArray(parsed)) continue;
          const normalized = parsed
            .map((entry) => sanitizeKpiEntry(entry))
            .filter((entry): entry is TaskOutcomeKpiWindowEntry => Boolean(entry))
            .sort((a, b) => a.timestamp - b.timestamp);
          if (normalized.length === 0) continue;
          this.kpiWindows.set(scopeKey, normalized.slice(Math.max(0, normalized.length - cap)));
        } catch {
          // ignore malformed rows to preserve runtime availability.
        }
      }

      this.storageInitialized = true;
    } catch (error) {
      this.logger.warn?.(
        '[wunderland/adaptive] Failed to initialize SQL telemetry persistence; continuing with in-memory windows.',
        { error: error instanceof Error ? error.message : String(error) },
      );
      this.storageAdapter = null;
      this.storageInitialized = false;
    }
  }

  async close(): Promise<void> {
    if (!this.storageAdapter) return;
    await this.storageAdapter.close();
    this.storageAdapter = null;
    this.storageInitialized = false;
  }

  resolveTurnDecision(args: {
    scope: WunderlandAdaptiveTurnScope;
    requestedToolFailureMode?: unknown;
  }): WunderlandAdaptiveExecutionDecision {
    const scopeKey = this.resolveScopeKey(args.scope);
    const kpi = this.summarizeTaskOutcomeWindow(scopeKey);
    const explicitRequestedMode = maybeParseExplicitToolFailureMode(args.requestedToolFailureMode);
    const requestedMode = explicitRequestedMode ?? this.defaultToolFailureMode;

    if (!this.adaptive.enabled || !kpi || kpi.sampleCount < this.adaptive.minSamples) {
      return {
        scopeKey,
        toolFailureMode: requestedMode,
        degraded: false,
        kpi,
      };
    }

    if (kpi.weightedSuccessRate >= this.adaptive.minWeightedSuccessRate) {
      return {
        scopeKey,
        toolFailureMode: requestedMode,
        degraded: false,
        kpi,
      };
    }

    let forcedToolSelectionMode = false;
    let forcedToolFailureMode = false;
    let preservedRequestedFailClosed = false;
    let mode = requestedMode;
    const reasons: string[] = [
      `weightedSuccessRate=${kpi.weightedSuccessRate.toFixed(3)} below threshold=${this.adaptive.minWeightedSuccessRate.toFixed(3)}`,
    ];

    if (this.adaptive.forceAllToolsWhenDegraded) {
      forcedToolSelectionMode = true;
      reasons.push('toolSelectionMode switched discovered -> all');
    }

    if (this.adaptive.forceFailOpenWhenDegraded && mode !== 'fail_open') {
      if (explicitRequestedMode === 'fail_closed') {
        preservedRequestedFailClosed = true;
        reasons.push('preserved explicit request override toolFailureMode=fail_closed');
      } else {
        mode = 'fail_open';
        forcedToolFailureMode = true;
        reasons.push('toolFailureMode switched fail_closed -> fail_open');
      }
    }

    return {
      scopeKey,
      toolFailureMode: mode,
      degraded: forcedToolSelectionMode || forcedToolFailureMode || preservedRequestedFailClosed,
      kpi,
      reason: reasons.join('; '),
      actions: {
        forcedToolSelectionMode: forcedToolSelectionMode || undefined,
        forcedToolFailureMode: forcedToolFailureMode || undefined,
        preservedRequestedFailClosed: preservedRequestedFailClosed || undefined,
      },
    };
  }

  async recordTurnOutcome(args: {
    scope: WunderlandAdaptiveTurnScope;
    degraded: boolean;
    replyText: string;
    didFail: boolean;
    toolCallCount?: number;
    statusOverride?: TaskOutcomeStatus;
    scoreOverride?: number;
  }): Promise<{
    assessment: TaskOutcomeAssessment;
    kpi: WunderlandTaskOutcomeKpiSummary | null;
    alert: WunderlandTaskOutcomeKpiAlert | null;
  }> {
    const scopeKey = this.resolveScopeKey(args.scope);
    const assessment = evaluateTaskOutcome({
      replyText: args.replyText,
      didFail: args.didFail,
      degraded: args.degraded,
      toolCallCount: clampInteger(args.toolCallCount ?? 0, 0, 0, 1000000),
      statusOverride: args.statusOverride,
      scoreOverride: args.scoreOverride,
    });

    if (!this.telemetry.enabled) {
      return { assessment, kpi: null, alert: null };
    }

    const now = Date.now();
    const window = this.kpiWindows.get(scopeKey) ?? [];
    window.push({
      status: assessment.status,
      score: Math.max(0, Math.min(1, Number(assessment.score) || 0)),
      timestamp: now,
    });
    if (window.length > this.telemetry.rollingWindowSize) {
      window.splice(0, window.length - this.telemetry.rollingWindowSize);
    }
    this.kpiWindows.set(scopeKey, window);

    if (this.telemetry.persist) {
      await this.saveScopeWindow(scopeKey, window);
    }

    const kpi = this.summarizeTaskOutcomeWindow(scopeKey);
    const alert = this.maybeBuildAlert(kpi);
    if (alert) {
      this.logger.warn?.('[wunderland/adaptive] Task outcome KPI alert', alert);
    }
    return { assessment, kpi, alert };
  }

  private resolveScopeKey(scope: WunderlandAdaptiveTurnScope): string {
    const mode = this.telemetry.scope;
    const sessionId = String(scope.sessionId || '').trim() || 'none';
    const personaId = String(scope.personaId || '').trim() || 'unknown';
    const tenantId = String(scope.tenantId || '').trim() || 'none';

    if (mode === 'global') return 'global';
    if (mode === 'session') return `session:${sessionId}`;
    if (mode === 'persona') return `persona:${personaId}`;
    if (mode === 'tenant') return `tenant:${tenantId}`;
    return `tenant:${tenantId}|persona:${personaId}`;
  }

  private summarizeTaskOutcomeWindow(scopeKey: string): WunderlandTaskOutcomeKpiSummary | null {
    const window = this.kpiWindows.get(scopeKey) ?? [];
    if (window.length === 0) return null;

    let successCount = 0;
    let partialCount = 0;
    let failedCount = 0;
    let scoreSum = 0;

    for (const entry of window) {
      if (entry.status === 'success') successCount += 1;
      else if (entry.status === 'partial') partialCount += 1;
      else failedCount += 1;
      scoreSum += entry.score;
    }

    const sampleCount = window.length;
    const successRate = sampleCount > 0 ? successCount / sampleCount : 0;
    const averageScore = sampleCount > 0 ? scoreSum / sampleCount : 0;

    return {
      scopeKey,
      scopeMode: this.telemetry.scope,
      windowSize: this.telemetry.rollingWindowSize,
      sampleCount,
      successCount,
      partialCount,
      failedCount,
      successRate,
      averageScore,
      weightedSuccessRate: averageScore,
      timestamp: new Date().toISOString(),
    };
  }

  private maybeBuildAlert(kpi: WunderlandTaskOutcomeKpiSummary | null): WunderlandTaskOutcomeKpiAlert | null {
    if (!this.telemetry.enabled || !this.telemetry.emitAlerts || !kpi) return null;
    if (kpi.sampleCount < this.telemetry.alertMinSamples) return null;
    if (kpi.weightedSuccessRate >= this.telemetry.alertBelowWeightedSuccessRate) return null;

    const now = Date.now();
    const lastAlertAt = this.alertState.get(kpi.scopeKey) ?? 0;
    if (this.telemetry.alertCooldownMs > 0 && now - lastAlertAt < this.telemetry.alertCooldownMs) {
      return null;
    }
    this.alertState.set(kpi.scopeKey, now);

    const severity: 'warning' | 'critical' =
      kpi.weightedSuccessRate < this.telemetry.alertBelowWeightedSuccessRate * 0.6
        ? 'critical'
        : 'warning';

    return {
      scopeKey: kpi.scopeKey,
      severity,
      reason:
        `Weighted success rate ${kpi.weightedSuccessRate.toFixed(3)} below alert threshold ` +
        `${this.telemetry.alertBelowWeightedSuccessRate.toFixed(3)}.`,
      threshold: this.telemetry.alertBelowWeightedSuccessRate,
      value: kpi.weightedSuccessRate,
      sampleCount: kpi.sampleCount,
      timestamp: new Date(now).toISOString(),
    };
  }

  private async ensureStorageSchema(): Promise<void> {
    if (!this.storageAdapter) return;
    const updatedAtIndex = sanitizeTableName(`${this.telemetry.tableName}_updated_at_idx`);
    await this.storageAdapter.exec(`
      CREATE TABLE IF NOT EXISTS ${this.telemetry.tableName} (
        scope_key TEXT PRIMARY KEY,
        entries_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS ${updatedAtIndex}
        ON ${this.telemetry.tableName} (updated_at);
    `);
  }

  private async saveScopeWindow(scopeKey: string, entries: TaskOutcomeKpiWindowEntry[]): Promise<void> {
    if (!this.storageAdapter || !scopeKey) return;
    const payload = JSON.stringify(entries);
    const updatedAt = Date.now();

    try {
      if (this.storageAdapter.kind !== 'postgres') {
        await this.storageAdapter.run(
          `INSERT OR REPLACE INTO ${this.telemetry.tableName} (scope_key, entries_json, updated_at) VALUES (?, ?, ?)`,
          [scopeKey, payload, updatedAt],
        );
        return;
      }

      const existing = await this.storageAdapter.get<{ scope_key: string }>(
        `SELECT scope_key FROM ${this.telemetry.tableName} WHERE scope_key = ?`,
        [scopeKey],
      );
      if (existing) {
        await this.storageAdapter.run(
          `UPDATE ${this.telemetry.tableName} SET entries_json = ?, updated_at = ? WHERE scope_key = ?`,
          [payload, updatedAt, scopeKey],
        );
      } else {
        await this.storageAdapter.run(
          `INSERT INTO ${this.telemetry.tableName} (scope_key, entries_json, updated_at) VALUES (?, ?, ?)`,
          [scopeKey, payload, updatedAt],
        );
      }
    } catch (error) {
      this.logger.warn?.(
        `[wunderland/adaptive] Failed to persist task-outcome window for scope '${scopeKey}'.`,
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }
}
