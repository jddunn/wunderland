/**
 * @fileoverview `wunderland start` — start local agent server.
 * Orchestrates modular startup phases.
 * @module wunderland/cli/commands/start
 */

import type { GlobalFlags } from '../../types.js';
import * as fmt from '../../ui/format.js';
import { loadAndValidateConfig } from './config-loader.js';
import { initializeSeed } from './seed-initializer.js';
import { setupLlmProvider } from './llm-provider-setup.js';
import { loadExtensions } from './extension-loader.js';
import { setupSkillsAndDiscovery } from './skills-discovery-setup.js';
import { initAdaptiveRuntime } from './adaptive-runtime-init.js';
import { initPairing } from './pairing-init.js';
import { initializeAgentStorage } from './storage-init.js';
import { initChannelRuntime, wireDiscordExtensions, subscribeChannelAdapters } from './channel-handler.js';
import { createAgentHttpServer } from './http-server.js';
import { startServerAndDisplay } from './startup-display.js';
import { bootstrapRagKnowledge } from './rag-bootstrap.js';

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

  // Helper: run a startup phase with error handling + progress.
  // If console is captured (phases 4+), errors restore it first so the user sees output.
  async function phase<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      // Restore console if it was captured during extension loading.
      if (ctx.origLog) {
        console.log = ctx.origLog;
        console.info = ctx.origInfo ?? ctx.origLog;
        console.warn = ctx.origWarn ?? ctx.origLog;
      }
      const message = err instanceof Error ? err.message : String(err);
      fmt.errorBlock(`Startup failed (${name})`, message);
      if (err instanceof Error && err.stack) {
        console.error(err.stack.split('\n').slice(1, 4).join('\n'));
      }
      process.exitCode = 1;
      throw err; // re-throw to stop startup
    }
  }

  try {
    // Phase 1: Load or create agent config
    const configOk = await phase('config', () => loadAndValidateConfig(ctx));
    if (!configOk) return;

    // Phase 2: Create agent seed (identity, security, OTEL)
    await phase('seed', () => initializeSeed(ctx));

    // Phase 2.5: Per-agent storage (SQLite or cloud)
    await phase('storage', () => initializeAgentStorage(ctx));

    // Phase 3: Resolve LLM provider, auth, model
    const llmOk = await phase('llm', () => setupLlmProvider(ctx));
    if (!llmOk) return;

    // Phase 3.5: Seed RAG knowledge base (first run only, skips if already seeded)
    // Non-blocking: failures here don't stop startup.
    try {
      await bootstrapRagKnowledge(ctx);
    } catch (err: any) {
      console.warn('[RAG Bootstrap] Failed (non-critical):', err?.message ?? err);
    }

    // Phase 4: Load extensions, tools, channel adapters
    // Note: console is captured inside loadExtensions — errors restored in phase() wrapper.
    await phase('extensions', () => loadExtensions(ctx));

    // Phase 5: Skills registry + capability discovery
    await phase('discovery', () => setupSkillsAndDiscovery(ctx));

    // Phase 6: Adaptive execution runtime + system prompt
    await phase('runtime', () => initAdaptiveRuntime(ctx));

    // Phase 7: Pairing manager
    phase('pairing', () => initPairing(ctx));

    // Phase 8: Channel runtime (adapter map, Discord extensions, subscriptions)
    await phase('channels', async () => {
      initChannelRuntime(ctx);
      await wireDiscordExtensions(ctx);
      subscribeChannelAdapters(ctx);
    });

    // Phase 9: HTTP server + startup display
    await phase('server', async () => {
      const server = createAgentHttpServer(ctx);
      await startServerAndDisplay(ctx, server);
    });

    // If TUI mode, launch the interactive dashboard (also keeps process alive).
    // Otherwise, block forever — process exits via SIGINT/SIGTERM handlers.
    const shouldTui = globals.tui || (!globals.noTui && !globals.quiet && process.stdout.isTTY);
    if (shouldTui) {
      const { launchTui } = await import('../../tui/index.js');
      await launchTui(globals);
    } else {
      await new Promise(() => {});
    }
  } catch {
    // Error already displayed by phase() wrapper — just exit.
  }
}
