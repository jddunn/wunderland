// @ts-nocheck
/**
 * @fileoverview Shared dependency interface for the multi-agent dashboard server.
 * @module wunderland/cli/commands/dashboard/routes/types
 *
 * Minimal dependency bag for the hub dashboard — no LLM, no tool maps,
 * no per-agent runtime state. Just the admin secret and startup metadata.
 */

/**
 * Shared dependencies injected into dashboard route handlers.
 * Assembled once in `createDashboardServer()` and forwarded
 * to each route handler.
 */
export interface DashboardDeps {
  /** Admin secret required for all `/api/*` endpoints. */
  adminSecret: string;

  /** ISO 8601 timestamp of when the dashboard server started. */
  startedAt: string;

  /** Port the dashboard server is listening on. */
  port: number;
}
