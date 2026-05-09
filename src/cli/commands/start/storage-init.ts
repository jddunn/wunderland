// @ts-nocheck
/**
 * @fileoverview Phase 2.5: Per-agent storage initialization for `wunderland start`.
 * @module wunderland/cli/commands/start/storage-init
 */

import {
  AgentStorageManager,
  resolveAgentStorageConfig,
} from '../../../memory-new/storage/storage-index.js';

/**
 * Initialize per-agent storage (SQLite or cloud) and attach it to the startup context.
 *
 * Expects `ctx.agentConfig` (parsed agent.config.json) and `ctx.seedId` to be set
 * by earlier phases.
 */
export async function initializeAgentStorage(ctx: any): Promise<void> {
  const cfg = ctx.agentConfig ?? ctx.cfg ?? {};
  const seedId: string = ctx.seedId ?? cfg.seedId ?? `seed_${Date.now()}`;

  const storageConfig = resolveAgentStorageConfig(seedId, cfg.storage);
  const storageManager = new AgentStorageManager(storageConfig);
  await storageManager.initialize();

  // Attach to context for downstream phases
  ctx.agentStorageManager = storageManager;
  ctx.storageConfig = storageConfig;
}
