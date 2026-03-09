/**
 * @fileoverview Server lifecycle + startup status display.
 * Extracted from start.ts lines 2637-2730.
 */

import * as path from 'node:path';
import * as fmt from '../../ui/format.js';
import { accent, dim, success as sColor, info as iColor, warn as wColor } from '../../ui/theme.js';
import { shutdownWunderlandOtel } from '../../observability/otel.js';
import { recordAgentStart } from '../../config/agent-history.js';

export async function startServerAndDisplay(ctx: any, server: import('node:http').Server): Promise<void> {
  const {
    port,
    displayName,
    seedId,
    providerId,
    model,
    canUseLLM,
    openrouterFallback,
    toolMap,
    adapterByPlatform,
    discoveryManager,
    adaptiveRuntime,
    pairingEnabled,
    autoApproveToolCalls,
    policy,
    hitlSecret,
    turnApprovalMode,
    channelUnsubs,
    activePacks,
    startupLines,
    origLog,
    origInfo,
    origWarn,
  } = ctx;

  const isOllamaProvider = providerId === 'ollama';

  await new Promise<void>((resolve, reject) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use.\n`
          + `  Try a different port:  wunderland start --port ${port + 1}\n`
          + `  Or kill the process using port ${port}:  lsof -ti:${port} | xargs kill`,
        ));
      } else {
        reject(err);
      }
    });
    server.listen(port, '0.0.0.0', () => resolve());
  });

  // Record this agent in history for `wunderland agents`
  recordAgentStart({
    seedId,
    displayName,
    configPath: path.resolve(process.cwd(), 'agent.config.json'),
  }).catch(() => { /* best-effort */ });

  // Best-effort OTEL shutdown on exit.
  const handleExit = async () => {
    try {
      // Channel subscriptions + extension teardown (best-effort)
      for (const unsub of channelUnsubs) {
        try { unsub(); } catch { /* ignore */ }
      }
      await Promise.allSettled(
        (activePacks || [])
          .map((p: any) =>
            typeof p?.onDeactivate === 'function'
              ? p.onDeactivate({ logger: console })
              : null
          )
          .filter(Boolean),
      );
      await discoveryManager.close();
      await adaptiveRuntime.close();
      await shutdownWunderlandOtel();
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGINT', () => void handleExit());
  process.once('SIGTERM', () => void handleExit());

  // Status display
  // ── Restore console and render captured startup output in a panel ────────
  console.log = origLog;
  console.info = origInfo;
  console.warn = origWarn;
  if (startupLines.length > 0) {
    const { stripAnsi } = await import('../../ui/ansi-utils.js');
    // Filter out empty lines and deduplicate
    const filtered = startupLines
      .filter((l: string) => stripAnsi(l).trim().length > 0);
    if (filtered.length > 0) {
      await fmt.panel({ title: 'Startup', content: filtered.join('\n'), style: 'info' });
    }
  }

  fmt.section('Agent Server Running');
  fmt.kvPair('Agent', accent(displayName));
  fmt.kvPair('Seed ID', seedId);
  if (ctx.selectedPersona) {
    fmt.kvPair('AgentOS Persona', `${accent(ctx.selectedPersona.name)} ${dim(`(${ctx.selectedPersona.id})`)}`);
  }
  fmt.kvPair('LLM Provider', providerId);
  fmt.kvPair('Model', model);
  fmt.kvPair('API Key', canUseLLM ? sColor('configured') : wColor('not set'));
  if (providerId === 'openai' && openrouterFallback) {
    fmt.kvPair('Fallback', sColor('OpenRouter (auto)'));
  }
  fmt.kvPair('Port', String(port));
  fmt.kvPair('Tools', `${toolMap.size} loaded`);
  fmt.kvPair('Channels', `${adapterByPlatform.size} loaded`);
  const dStats = discoveryManager.getStats();
  fmt.kvPair('Discovery', dStats.initialized ? sColor(`${dStats.capabilityCount} capabilities`) : wColor('disabled'));
  fmt.kvPair('Pairing', pairingEnabled ? sColor('enabled') : wColor('disabled'));
  fmt.kvPair(
    'Authorization',
    autoApproveToolCalls
      ? wColor('fully autonomous (all auto-approved)')
      : policy.executionMode === 'human-all'
        ? sColor('human-all (approve every tool call)')
        : sColor('human-dangerous (approve Tier 3 tools)'),
  );
  fmt.kvPair('Admin Secret', accent(hitlSecret));
  if (turnApprovalMode !== 'off') fmt.kvPair('Turn Checkpoints', sColor(turnApprovalMode));
  if (isOllamaProvider) {
    fmt.kvPair('Ollama', sColor('http://localhost:11434'));
  }
  fmt.blank();
  fmt.ok(`Health: ${iColor(`http://localhost:${port}/health`)}`);
  fmt.ok(`Chat:   ${iColor(`POST http://localhost:${port}/chat`)}`);
  fmt.ok(`HITL:   ${iColor(`http://localhost:${port}/hitl`)}`);
  fmt.ok(`Pairing: ${iColor(`http://localhost:${port}/pairing`)}`);
  if (!autoApproveToolCalls) {
    fmt.note(`CLI HITL: ${accent(`wunderland hitl watch --server http://localhost:${port} --secret ${hitlSecret}`)}`);
  }
  fmt.blank();
}
