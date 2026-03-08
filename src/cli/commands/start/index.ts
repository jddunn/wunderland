/**
 * @fileoverview `wunderland start` — start local agent server.
 * Orchestrates modular startup phases.
 * @module wunderland/cli/commands/start
 */

import type { GlobalFlags } from '../../types.js';
import { loadAndValidateConfig } from './config-loader.js';
import { initializeSeed } from './seed-initializer.js';
import { setupLlmProvider } from './llm-provider-setup.js';
import { loadExtensions } from './extension-loader.js';
import { setupSkillsAndDiscovery } from './skills-discovery-setup.js';
import { initAdaptiveRuntime } from './adaptive-runtime-init.js';
import { initPairing } from './pairing-init.js';
import { initChannelRuntime, wireDiscordExtensions, subscribeChannelAdapters } from './channel-handler.js';
import { createAgentHttpServer } from './http-server.js';
import { startServerAndDisplay } from './startup-display.js';

export default async function cmdStart(
  _args: string[],
  flags: Record<string, string | boolean>,
  globals: GlobalFlags,
): Promise<void> {
  const ctx: any = {
    flags,
    globals,
    startTime: Date.now(),
  };

  // Phase 1: Load or create agent config
  const configOk = await loadAndValidateConfig(ctx);
  if (!configOk) return;

  // Phase 2: Create agent seed (identity, security, OTEL)
  await initializeSeed(ctx);

  // Phase 3: Resolve LLM provider, auth, model
  const llmOk = await setupLlmProvider(ctx);
  if (!llmOk) return;

  // Phase 4: Load extensions, tools, channel adapters
  await loadExtensions(ctx);

  // Phase 5: Skills registry + capability discovery
  await setupSkillsAndDiscovery(ctx);

  // Phase 6: Adaptive execution runtime + system prompt
  await initAdaptiveRuntime(ctx);

  // Phase 7: Pairing manager
  initPairing(ctx);

  // Phase 8: Channel runtime (adapter map, Discord extensions, subscriptions)
  initChannelRuntime(ctx);
  await wireDiscordExtensions(ctx);
  subscribeChannelAdapters(ctx);

  // Phase 9: HTTP server + startup display
  const server = createAgentHttpServer(ctx);
  await startServerAndDisplay(ctx, server);
}
