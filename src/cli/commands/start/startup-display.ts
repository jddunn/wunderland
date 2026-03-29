/**
 * @fileoverview Server lifecycle + startup status display.
 * Extracted from start.ts lines 2637-2730.
 */

import * as path from 'node:path';
import * as fmt from '../../ui/format.js';
import { accent, dim, success as sColor, info as iColor, warn as wColor } from '../../ui/theme.js';
import { shutdownWunderlandOtel } from '../../../observability/otel.js';
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

  // Auto-find a free port if the requested one is in use.
  const maxPortAttempts = 10;
  let actualPort = port;
  for (let attempt = 0; attempt < maxPortAttempts; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: NodeJS.ErrnoException) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(actualPort, '0.0.0.0');
      });
      break; // success
    } catch (err: any) {
      if (err?.code === 'EADDRINUSE') {
        const nextPort = actualPort + 1;
        if (attempt < maxPortAttempts - 1) {
          console.warn(`Port ${actualPort} in use, trying ${nextPort}...`);
          server.close();
          actualPort = nextPort;
          continue;
        }
        throw new Error(
          `Ports ${port}-${actualPort} are all in use.\n`
          + `  Try a different port:  wunderland start --port ${actualPort + 1}\n`
          + `  Or kill the process using port ${port}:  lsof -ti:${port} | xargs kill`,
        );
      }
      throw err;
    }
  }
  // Update ctx.port so downstream display/URLs reflect the actual port
  if (actualPort !== port) {
    ctx.port = actualPort;
    fmt.note(`Using port ${actualPort} (${port} was in use).`);
  }

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
  if (openrouterFallback) {
    const fbModel = openrouterFallback.model || 'auto';
    const fbLabel = openrouterFallback.baseUrl?.includes('openrouter') ? 'OpenRouter'
      : openrouterFallback.baseUrl?.includes('anthropic') ? 'Anthropic'
      : fbModel.startsWith('gemini') ? 'Gemini'
      : fbModel.startsWith('claude') ? 'Anthropic'
      : fbModel.startsWith('gpt') ? 'OpenAI'
      : 'auto';
    fmt.kvPair('Fallback', sColor(`${fbLabel} (${fbModel})`));
  }
  const activePort = ctx.port;
  fmt.kvPair('Port', String(activePort));
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
  fmt.ok(`Dashboard: ${iColor(`http://localhost:${activePort}/`)}`);
  fmt.ok(`Health:    ${iColor(`http://localhost:${activePort}/health`)}`);
  fmt.ok(`Chat:      ${iColor(`POST http://localhost:${activePort}/chat`)}`);
  fmt.ok(`HITL:      ${iColor(`http://localhost:${activePort}/hitl`)}`);
  fmt.ok(`Pairing:   ${iColor(`http://localhost:${activePort}/pairing`)}`);
  if (!autoApproveToolCalls) {
    fmt.note(`CLI HITL: ${accent(`wunderland hitl watch --server http://localhost:${activePort} --secret ${hitlSecret}`)}`);
  }
  fmt.blank();
}
