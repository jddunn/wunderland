/**
 * @fileoverview Channel runtime — inbound/outbound message handling, Discord
 * extension wiring, and adapter subscriptions.
 *
 * Extracted from `start.ts` to keep the main command file manageable.
 */

import { randomUUID } from 'node:crypto';
import type { ChannelMessage, IChannelAdapter } from '@framers/agentos';
import {
  buildToolDefs,
  runToolCallingTurn,
  safeJsonStringify,
  type ToolInstance,
} from '../../../runtime/tool-calling.js';
import { buildOllamaRuntimeOptions } from '../../../runtime/ollama-options.js';
import * as fmt from '../../ui/format.js';

// ── Types ────────────────────────────────────────────────────────────────────

type AgentosApprovalCategory =
  | 'data_modification'
  | 'external_api'
  | 'financial'
  | 'communication'
  | 'system'
  | 'other';

/** Shared runtime context threaded through every channel helper. */
export interface ChannelRuntimeCtx {
  loadedChannelAdapters: IChannelAdapter[];
  permissions: { network: { externalApis?: boolean }; system: { cliExecution?: boolean } };
  LOCAL_ONLY_CHANNELS: Set<string>;
  CLI_REQUIRED_CHANNELS: Set<string>;
  pairingEnabled: boolean;
  pairingGroupTrigger: string;
  pairingGroupTriggerEnabled: boolean;
  pairing: any;
  systemPrompt: string;
  channelSessions: Map<string, any[]>;
  channelQueues: Map<string, Promise<void>>;
  channelUnsubs: Array<() => void>;
  discoveryManager: any;
  adaptiveRuntime: any;
  defaultTenantId: string;
  toolMap: Map<string, ToolInstance>;
  canUseLLM: boolean;
  seed: any;
  seedId: string;
  providerId: string;
  model: string;
  llmApiKey: string;
  llmBaseUrl?: string;
  policy: any;
  autoApproveToolCalls: boolean;
  dangerouslySkipPermissions: boolean;
  strictToolNames: boolean;
  openrouterFallback: any;
  oauthGetApiKey: any;
  hitlManager: any;
  broadcastHitlUpdate: (payload: any) => void;
  workspaceAgentId: string;
  workspaceBaseDir: string;
  turnApprovalMode: string;
  activePacks: any[];
  cfg: any;
  adapterByPlatform: Map<string, IChannelAdapter>;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function toAgentosApprovalCategory(tool: ToolInstance): AgentosApprovalCategory {
  const name = String(tool?.name || '').toLowerCase();
  if (name.startsWith('file_') || name.includes('shell_') || name.includes('run_command') || name.includes('exec')) return 'system';
  if (name.startsWith('browser_') || name.includes('web_')) return 'external_api';
  const cat = String(tool?.category || '').toLowerCase();
  if (cat.includes('financial')) return 'financial';
  if (cat.includes('communication')) return 'communication';
  if (cat.includes('external') || cat.includes('api') || cat === 'research' || cat === 'search') return 'external_api';
  if (cat.includes('data')) return 'data_modification';
  if (cat.includes('system') || cat.includes('filesystem')) return 'system';
  return 'other';
}

function enqueueChannelTurn(ctx: ChannelRuntimeCtx, key: string, fn: () => Promise<void>): void {
  const prev = ctx.channelQueues.get(key) ?? Promise.resolve();
  const next = prev
    .catch(() => undefined)
    .then(fn)
    .catch((err) => {
      console.warn(`[channels] Turn failed for ${key}:`, err instanceof Error ? err.message : String(err));
    })
    .finally(() => {
      if (ctx.channelQueues.get(key) === next) ctx.channelQueues.delete(key);
    });
  ctx.channelQueues.set(key, next);
}

function chunkText(text: string, maxLen = 1800): string[] {
  const t = String(text ?? '');
  if (t.length <= maxLen) return [t];
  const chunks: string[] = [];
  let i = 0;
  while (i < t.length) {
    chunks.push(t.slice(i, i + maxLen));
    i += maxLen;
  }
  return chunks;
}

function normalizeDiscordChannelName(name: string): string {
  return String(name ?? '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/[\u{FE0F}\u{200D}]/gu, '')
    .replace(/^[#\s\-_]+/, '')
    .replace(/[#\s\-_]+$/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}

export async function resolveCuratedPicksChannelId(cfg: any, discordService: any): Promise<string | undefined> {
  const channels = (cfg as any)?.feeds?.channels ?? {};

  const explicit =
    (typeof channels.curated_picks === 'string' && channels.curated_picks)
    || (typeof channels.general === 'string' && channels.general);
  if (explicit) return explicit;

  try {
    const client = discordService?.getClient?.();
    const guilds = client?.guilds?.cache;
    if (guilds?.size) {
      for (const guild of guilds.values()) {
        const fetched = await guild.channels.fetch();
        const general = fetched.find((channel: any) =>
          channel
          && 'name' in channel
          && 'send' in channel
          && normalizeDiscordChannelName(channel.name) === 'general');
        if (general?.id) return general.id;
      }
    }
  } catch {
    // Fall through to config-backed defaults.
  }

  return (
    (typeof channels.community === 'string' && channels.community)
    || (typeof channels.info === 'string' && channels.info)
    || (typeof channels.welcome === 'string' && channels.welcome)
    || undefined
  );
}

function getSenderLabel(m: ChannelMessage): string {
  const d = (m.sender && typeof m.sender === 'object') ? m.sender : ({} as any);
  const display = typeof d.displayName === 'string' && d.displayName.trim() ? d.displayName.trim() : '';
  const user = typeof d.username === 'string' && d.username.trim() ? d.username.trim() : '';
  return display || (user ? `@${user}` : '') || String(d.id || 'unknown');
}

function isChannelAllowedByPolicy(ctx: ChannelRuntimeCtx, platform: string): boolean {
  if (ctx.LOCAL_ONLY_CHANNELS.has(platform)) return true;
  if (ctx.permissions.network.externalApis !== true) return false;
  if (ctx.CLI_REQUIRED_CHANNELS.has(platform) && ctx.permissions.system.cliExecution !== true) return false;
  return true;
}

async function sendChannelText(
  ctx: ChannelRuntimeCtx,
  opts: { platform: string; conversationId: string; text: string; replyToMessageId?: string },
): Promise<void> {
  if (!isChannelAllowedByPolicy(ctx, opts.platform)) return;
  const adapter = ctx.adapterByPlatform.get(opts.platform);
  if (!adapter) return;

  const parts = chunkText(opts.text, 1800).filter((p) => p.trim().length > 0);
  for (const part of parts) {
    await adapter.sendMessage(opts.conversationId, {
      blocks: [{ type: 'text', text: part }],
      ...(opts.replyToMessageId ? { replyToMessageId: opts.replyToMessageId } : null),
    });
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the `adapterByPlatform` map from the loaded channel adapters.
 * Must be called before any other channel-handler export.
 */
export function initChannelRuntime(ctx: ChannelRuntimeCtx): void {
  // Ensure the map exists (it's never pre-initialized on ctx).
  if (!ctx.adapterByPlatform) (ctx as any).adapterByPlatform = new Map();
  const { adapterByPlatform, loadedChannelAdapters } = ctx;
  for (const adapter of loadedChannelAdapters) {
    const platform = (adapter as any)?.platform;
    if (typeof platform !== 'string' || !platform.trim()) continue;
    // Keep first adapter per platform (registry shouldn't load duplicates).
    if (!adapterByPlatform.has(platform)) adapterByPlatform.set(platform, adapter);
  }
}

/**
 * Handle a single inbound channel message: pairing check, LLM turn, tool
 * calling, explain trace, and reply delivery.
 */
export async function handleInboundChannelMessage(ctx: ChannelRuntimeCtx, message: ChannelMessage): Promise<void> {
  const {
    pairingEnabled,
    pairingGroupTriggerEnabled,
    pairingGroupTrigger,
    pairing,
    systemPrompt,
    channelSessions,
    discoveryManager,
    adaptiveRuntime,
    defaultTenantId,
    toolMap,
    canUseLLM,
    seed,
    seedId,
    providerId,
    model,
    llmApiKey,
    llmBaseUrl,
    policy,
    autoApproveToolCalls,
    dangerouslySkipPermissions,
    strictToolNames,
    openrouterFallback,
    oauthGetApiKey,
    hitlManager,
    broadcastHitlUpdate,
    workspaceAgentId,
    workspaceBaseDir,
    turnApprovalMode,
    adapterByPlatform,
  } = ctx;

  const platform = String(message.platform || '').trim();
  const conversationId = String(message.conversationId || '').trim();
  if (!platform || !conversationId) return;

  const text = String(message.text || '').trim();
  if (!text) return;

  const rawEvent = message.rawEvent;
  const rawMeta = rawEvent && typeof rawEvent === 'object' ? (rawEvent as any) : null;
  const explicitInvocation = rawMeta?.explicitInvocation === true;
  const explain = rawMeta?.explain === true;

  const senderId = String((message.sender as any)?.id || '').trim() || 'unknown';
  const isGroupPairingRequest = (() => {
    if (!pairingGroupTriggerEnabled) return false;
    if (message.conversationType === 'direct') return false;
    const t = text.trim();
    if (!t) return false;
    const trig = pairingGroupTrigger;
    const lowerT = t.toLowerCase();
    const lowerTrig = trig.toLowerCase();
    if (lowerT === lowerTrig) return true;
    if (lowerT.startsWith(`${lowerTrig} `)) return true;
    return false;
  })();

  // Pairing / allowlist guardrail (default: enabled).
  if (pairingEnabled) {
    const isAllowed = await pairing.isAllowed(platform, senderId);
    if (!isAllowed) {
      // Avoid spamming group channels with pairing prompts from random participants.
      if (message.conversationType !== 'direct' && !isGroupPairingRequest && !explicitInvocation) {
        return;
      }

      const meta: Record<string, string> = {
        sender: getSenderLabel(message),
        platform,
        conversationId,
      };

      const { code, created } = await pairing.upsertRequest(platform, senderId, meta);
      if (created) {
        void broadcastHitlUpdate({ type: 'pairing_request', platform, senderId, conversationId });
      }

      const prompt =
        code && code.trim()
          ? isGroupPairingRequest
            ? `Pairing requested.\n\nCode: ${code}\n\nAsk the assistant owner to approve this code.`
            : `Pairing required.\n\nCode: ${code}\n\nAsk the assistant owner to approve this code, then retry.`
          : 'Pairing queue is full. Ask the assistant owner to clear/approve pending requests, then retry.';

      await sendChannelText(ctx, { platform, conversationId, text: prompt, replyToMessageId: message.messageId });
      return;
    }
  }

  const sessionKey = `${platform}:${conversationId}`;
  // Explicit invocations (slash commands like /ask, /summarize, /deepdive) get a
  // fresh session each time to prevent stale conversation patterns from affecting
  // tool-calling behavior (e.g. model repeating "I don't have real-time data").
  let messages = explicitInvocation ? null : channelSessions.get(sessionKey);
  if (!messages) {
    messages = [{ role: 'system', content: systemPrompt }];
    channelSessions.set(sessionKey, messages);
  }

  // Soft cap to avoid unbounded memory.
  if (messages.length > 200) {
    messages = [messages[0]!, ...messages.slice(-120)];
    channelSessions.set(sessionKey, messages);
  }

  const userPrefix = message.conversationType === 'direct' ? '' : `[${getSenderLabel(message)}] `;
  messages.push({ role: 'user', content: `${userPrefix}${text}` });

  // Optional typing indicator while processing.
  try {
    const adapter = adapterByPlatform.get(platform);
    if (adapter) await adapter.sendTypingIndicator(conversationId, true);
  } catch {
    // ignore
  }

  const traceCalls: Array<{ toolName: string; hasSideEffects: boolean; args: Record<string, unknown> }> = [];

  // Capability discovery — inject tiered context AND build filtered tool set for this turn
  let discoveredToolNames: Set<string> | null = null;
  try {
    const discoveryResult = await discoveryManager.discoverForTurn(text);
    if (discoveryResult) {
      for (let i = messages.length - 1; i >= 1; i--) {
        if (typeof messages[i]?.content === 'string' && String(messages[i]!.content).startsWith('[Capability Context]')) {
          messages.splice(i, 1);
        }
      }
      const ctxParts: string[] = ['[Capability Context]', discoveryResult.tier0];
      if (discoveryResult.tier1.length > 0) {
        ctxParts.push('Relevant capabilities:\n' + discoveryResult.tier1.map((r: any) => r.summaryText).join('\n'));
      }
      if (discoveryResult.tier2.length > 0) {
        ctxParts.push(discoveryResult.tier2.map((r: any) => r.fullText).join('\n'));
      }
      messages.splice(1, 0, { role: 'system', content: ctxParts.join('\n') });

      // Extract discovered tool names for filtered tool defs.
      // Send tier2 (top 3 semantic matches) plus always-on core tools.
      // The full toolMap is still passed for execution, so any tool can
      // still be called if the model requests it via discover_capabilities.
      const names = new Set<string>();
      for (const r of discoveryResult.tier2) {
        const capName = r.capability?.name;
        if (capName && r.capability?.kind === 'tool') {
          const toolName = r.capability.id?.startsWith('tool:') ? r.capability.id.slice(5) : capName;
          names.add(toolName);
        }
      }
      // Always include schema-on-demand meta tools and discover_capabilities
      for (const [name] of toolMap) {
        if (name.startsWith('extensions_') || name === 'discover_capabilities') names.add(name);
      }
      // Always include general-purpose search tools so the model can
      // look things up regardless of discovery ranking.
      const alwaysInclude = ['web_search', 'news_search'];
      for (const coreTool of alwaysInclude) {
        if (toolMap.has(coreTool)) names.add(coreTool);
      }
      if (names.size > 0) discoveredToolNames = names;
    }
  } catch {
    // Non-fatal
  }

  const tenantId =
    (typeof (message as any)?.organizationId === 'string' && String((message as any).organizationId).trim())
    || defaultTenantId;
  const activePersonaId =
    typeof ctx.cfg?.selectedPersonaId === 'string' && ctx.cfg.selectedPersonaId.trim()
      ? ctx.cfg.selectedPersonaId.trim()
      : seed.seedId;
  const adaptiveDecision = adaptiveRuntime.resolveTurnDecision({
    scope: {
      sessionId: sessionKey,
      userId: senderId,
      personaId: activePersonaId,
      tenantId: tenantId || undefined,
    },
  });

  let reply = '';
  let turnFailed = false;
  let fallbackTriggered = false;
  let toolCallCount = 0;
  try {
    if (canUseLLM) {
      const toolContext = {
        gmiId: `wunderland-channel-${sessionKey}`,
        personaId: activePersonaId,
        userContext: {
          userId: senderId,
          platform,
          conversationId,
          ...(tenantId ? { organizationId: tenantId } : null),
        },
        agentWorkspace: { agentId: workspaceAgentId, baseDir: workspaceBaseDir },
        permissionSet: policy.permissionSet,
        securityTier: policy.securityTier,
        executionMode: policy.executionMode,
        toolAccessProfile: policy.toolAccessProfile,
        interactiveSession: false,
        turnApprovalMode,
        toolFailureMode: adaptiveDecision.toolFailureMode,
        adaptiveExecution: {
          degraded: adaptiveDecision.degraded,
          reason: adaptiveDecision.reason,
          actions: adaptiveDecision.actions,
          kpi: adaptiveDecision.kpi ?? undefined,
        },
        ...(policy.folderPermissions ? { folderPermissions: policy.folderPermissions } : null),
        wrapToolOutputs: policy.wrapToolOutputs,
        strictToolNames,
      };

      // Build filtered tool defs based on discovery (reduces context for small models).
      // In degraded mode, force full toolset exposure for recovery.
      const useFilteredToolDefs =
        discoveredToolNames && adaptiveDecision.actions?.forcedToolSelectionMode !== true;
      const filteredGetToolDefs = useFilteredToolDefs
        ? () => {
          const filtered = new Map<string, ToolInstance>();
          for (const [name, tool] of toolMap) {
            if (discoveredToolNames!.has(name)) {
              filtered.set(name, tool);
            }
          }
          return buildToolDefs(filtered, { strictToolNames });
        }
        : undefined;

      // Debug: log messages and tool names being sent to LLM
      const toolNames = filteredGetToolDefs
        ? filteredGetToolDefs().map((t: any) => t?.function?.name).filter(Boolean)
        : [...toolMap.keys()];
      console.log(`[channel-llm] Sending ${messages.length} messages, ${toolNames.length} tools: [${toolNames.join(', ')}]`);
      for (const m of messages) {
        const role = String(m.role || '');
        const content = String(m.content || '').slice(0, 120);
        console.log(`[channel-llm]   ${role}: ${content}`);
      }

      reply = await runToolCallingTurn({
        providerId,
        apiKey: llmApiKey,
        model,
        messages,
        toolMap,
        ...(filteredGetToolDefs && { getToolDefs: filteredGetToolDefs }),
        toolContext,
        maxRounds: 8,
        dangerouslySkipPermissions,
        strictToolNames,
        toolFailureMode: adaptiveDecision.toolFailureMode,
        ollamaOptions: buildOllamaRuntimeOptions(ctx.cfg?.ollama),
        onToolCall: (tool: ToolInstance, args: Record<string, unknown>) => {
          toolCallCount += 1;
          if (!explain) return;
          try {
            traceCalls.push({
              toolName: String((tool as any)?.name || 'unknown'),
              hasSideEffects: (tool as any)?.hasSideEffects === true,
              args: args || {},
            });
          } catch {
            // ignore
          }
        },
        askPermission: async (tool: ToolInstance, args: Record<string, unknown>) => {
          if (autoApproveToolCalls) return true;

          const preview = safeJsonStringify(args, 1800);
          const effectLabel = tool.hasSideEffects === true ? 'side effects' : 'read-only';
          const actionId = `tool-${seedId}-${randomUUID()}`;
          const decision = await hitlManager.requestApproval({
            actionId,
            description: `Allow ${tool.name} (${effectLabel})?\n\n${preview}`,
            severity: tool.hasSideEffects === true ? 'high' : 'low',
            category: toAgentosApprovalCategory(tool),
            agentId: seed.seedId,
            context: { toolName: tool.name, args, sessionId: sessionKey, platform, conversationId },
            reversible: tool.hasSideEffects !== true,
            requestedAt: new Date(),
            timeoutMs: 5 * 60_000,
          } as any);
          return decision.approved === true;
        },
        askCheckpoint: turnApprovalMode === 'off' ? undefined : async ({ round, toolCalls }: any) => {
          if (autoApproveToolCalls) return true;

          const checkpointId = `checkpoint-${seedId}-${sessionKey}-${round}-${randomUUID()}`;
          const completedWork = toolCalls.map((c: any) => {
            const effect = c.hasSideEffects ? 'side effects' : 'read-only';
            const preview = safeJsonStringify(c.args, 800);
            return `${c.toolName} (${effect})\n${preview}`;
          });

          const timeoutMs = 5 * 60_000;
          const checkpointPromise = hitlManager.checkpoint({
            checkpointId,
            workflowId: `channel-${sessionKey}`,
            currentPhase: `tool-round-${round}`,
            progress: Math.min(1, (round + 1) / 8),
            completedWork,
            upcomingWork: ['Continue to next LLM round'],
            issues: [],
            notes: 'Continue?',
            checkpointAt: new Date(),
          } as any).catch(() => ({ decision: 'abort' as const }));

          const timeoutPromise = new Promise<{ decision: 'abort' }>((resolve) =>
            setTimeout(() => resolve({ decision: 'abort' }), timeoutMs),
          );

          const decision = await Promise.race([checkpointPromise, timeoutPromise]);
          if ((decision as any)?.decision !== 'continue') {
            try {
              await hitlManager.cancelRequest(checkpointId, 'checkpoint_timeout_or_abort');
            } catch {
              // ignore
            }
          }
          return (decision as any)?.decision === 'continue';
        },
        baseUrl: llmBaseUrl,
        fallback: providerId === 'openai' ? openrouterFallback : undefined,
        onFallback: (err: Error, provider: string) => {
          fallbackTriggered = true;
          console.warn(`[fallback] Primary provider failed (${err.message}), routing to ${provider}`);
        },
        getApiKey: oauthGetApiKey,
      });
    } else {
      reply = `No LLM credentials configured. You said: ${text}`;
      messages.push({ role: 'assistant', content: reply });
    }
  } catch (error) {
    turnFailed = true;
    throw error;
  } finally {
    try {
      await adaptiveRuntime.recordTurnOutcome({
        scope: {
          sessionId: sessionKey,
          userId: senderId,
          personaId: activePersonaId,
          tenantId: tenantId || undefined,
        },
        degraded: adaptiveDecision.degraded || fallbackTriggered,
        replyText: reply,
        didFail: turnFailed,
        toolCallCount,
      });
    } catch (error) {
      console.warn('[wunderland/start][channels] failed to record adaptive outcome', error);
    }
    try {
      const adapter = adapterByPlatform.get(platform);
      if (adapter) await adapter.sendTypingIndicator(conversationId, false);
    } catch {
      // ignore
    }
  }

  if (typeof reply === 'string' && reply.trim()) {
    // Strip <think>...</think> blocks from models like qwen3 that expose thinking tokens.
    let cleanReply = reply.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    cleanReply = cleanReply.replace(/\*{0,2}<think>[\s\S]*?<\/think>\*{0,2}\s*/g, '').trim();
    if (cleanReply) {
      await sendChannelText(ctx, { platform, conversationId, text: cleanReply, replyToMessageId: message.messageId });
    }
  }

  if (explain) {
    const redact = (value: unknown, depth: number): unknown => {
      if (depth <= 0) return '[truncated]';
      if (value === null || value === undefined) return value;
      if (typeof value === 'string') {
        const t = value.trim();
        return t.length > 200 ? `${t.slice(0, 200)}…` : t;
      }
      if (typeof value === 'number' || typeof value === 'boolean') return value;
      if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth - 1));
      if (typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          const key = String(k);
          if (/(api[-_]?key|token|secret|password|auth)/i.test(key)) {
            out[key] = '[REDACTED]';
          } else {
            out[key] = redact(v, depth - 1);
          }
        }
        return out;
      }
      return String(value);
    };

    const maxCalls = 8;
    const shown = traceCalls.slice(0, maxCalls);
    const lines: string[] = [];
    for (const c of shown) {
      const effect = c.hasSideEffects ? 'side effects' : 'read-only';
      const argsPreview = safeJsonStringify(redact(c.args, 4), 700);
      lines.push(`- ${c.toolName} (${effect}) ${argsPreview}`);
    }
    if (traceCalls.length > maxCalls) {
      lines.push(`- … +${traceCalls.length - maxCalls} more`);
    }
    const traceText = lines.length > 0
      ? `Tool trace (what I called):\n${lines.join('\n')}`
      : 'Tool trace: (no tool calls)';

    await sendChannelText(ctx, { platform, conversationId, text: traceText, replyToMessageId: message.messageId });
  }
}

/**
 * Wire Discord-specific extension integrations: Founders, Verify, Channel
 * Subscriptions, Welcome handler, and Curated Picks.
 */
export async function wireDiscordExtensions(ctx: ChannelRuntimeCtx): Promise<void> {
  const { activePacks, adapterByPlatform, cfg } = ctx;

  // ── Founders Extension Integration (Discord) ────────────────────────────
  {
    const foundersPack = activePacks.find(
      (p: any) => p?.name === '@framers/agentos-ext-founders',
    ) as any;
    const discordAdapter = adapterByPlatform.get('discord') as any;

    if (foundersPack?.metadata && discordAdapter) {
      try {
        // Read founders channel config from agent.config.json feeds.founders.
        const foundersChannels = cfg?.feeds?.founders as Record<string, string> | undefined;

        // Register slash command definitions with the Discord service.
        const slashCommands = foundersPack.metadata.slashCommands;
        if (slashCommands?.length && discordAdapter.service?.registerSlashCommands) {
          discordAdapter.service.registerSlashCommands(slashCommands);
        }

        // Create the interaction handler (pass channel IDs from agent config) and register it.
        if (typeof foundersPack.metadata.createHandler === 'function') {
          const handler = foundersPack.metadata.createHandler(foundersChannels);
          if (typeof discordAdapter.registerExternalInteractionHandler === 'function') {
            discordAdapter.registerExternalInteractionHandler(
              handler.handleInteraction,
            );
          }
          // Set up the welcome post after a short delay (give Discord gateway time).
          if (typeof handler.ensureWelcomePost === 'function') {
            const client = discordAdapter.service?.getClient?.();
            if (client) {
              setTimeout(() => {
                handler.ensureWelcomePost(client).catch((err: Error) => {
                  console.warn('[Founders] Welcome post setup failed:', err.message);
                });
              }, 5000);
            }
          }
          fmt.ok('Founders extension integrated with Discord adapter');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fmt.warning(`Founders extension integration failed: ${msg}`);
      }
    }
  }

  // ── Verify Extension Integration (Discord) ─────────────────────────────
  {
    const verifyPack = activePacks.find(
      (p: any) => p?.name === '@framers/agentos-ext-verify',
    ) as any;
    const discordAdapterVerify = adapterByPlatform.get('discord') as any;

    if (verifyPack?.metadata && discordAdapterVerify) {
      try {
        const verifyChannels = (cfg as any)?.feeds?.verify as Record<string, string> | undefined;

        const slashCommands = verifyPack.metadata.slashCommands;
        if (slashCommands?.length && discordAdapterVerify.service?.registerSlashCommands) {
          discordAdapterVerify.service.registerSlashCommands(slashCommands);
        }

        if (typeof verifyPack.metadata.createHandler === 'function') {
          const handler = verifyPack.metadata.createHandler(verifyChannels);
          if (typeof discordAdapterVerify.registerExternalInteractionHandler === 'function') {
            discordAdapterVerify.registerExternalInteractionHandler(
              handler.handleInteraction,
            );
          }
          fmt.ok('Verify extension integrated with Discord adapter');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fmt.warning(`Verify extension integration failed: ${msg}`);
      }
    }
  }

  // ── Channel Subscriptions Integration (Discord) ──────────────────────────
  {
    const discordAdapterSubs = adapterByPlatform.get('discord') as any;
    const channelSettingsId = (cfg as any)?.feeds?.channels?.channel_settings as string | undefined;

    if (discordAdapterSubs && channelSettingsId) {
      try {
        const { createChannelSubsHandler } = await import('../../../discord/channelSubsHandler.js');
        const subsHandler = createChannelSubsHandler({
          guildId: String(process.env.DISCORD_GUILD_ID || ''),
          channelSettingsId,
        });
        if (typeof discordAdapterSubs.registerExternalInteractionHandler === 'function') {
          discordAdapterSubs.registerExternalInteractionHandler(
            subsHandler.handleInteraction,
          );
        }
        const subsClient = discordAdapterSubs.service?.getClient?.();
        if (subsClient) {
          setTimeout(() => {
            subsHandler.ensureSubsPost(subsClient).catch((err: Error) => {
              console.warn('[ChannelSubs] Post setup failed:', err.message);
            });
          }, 6000);
        }
        fmt.ok('Channel subscriptions integrated with Discord adapter');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fmt.warning(`Channel subscriptions integration failed: ${msg}`);
      }
    }
  }

  // ── Welcome Handler Integration (Discord) ──────────────────────────────────
  {
    const discordAdapterWelcome = adapterByPlatform.get('discord') as any;
    const welcomeChannelId = (cfg as any)?.feeds?.channels?.welcome as string | undefined;
    const openaiApiKey = process.env.OPENAI_API_KEY;

    if (discordAdapterWelcome && welcomeChannelId && openaiApiKey) {
      try {
        const { createWelcomeHandler } = await import('../../../discord/welcomeHandler.js');
        const welcomeHandler = createWelcomeHandler({
          channelId: welcomeChannelId,
          openaiApiKey,
          systemPrompt: (cfg as any)?.systemPrompt || '',
          model: 'gpt-4o',  // Always use gpt-4o for welcome messages — personalization quality matters
        });
        if (discordAdapterWelcome.service) {
          welcomeHandler.registerOnService(discordAdapterWelcome.service);
          fmt.ok('Welcome handler integrated with Discord adapter');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fmt.warning(`Welcome handler integration failed: ${msg}`);
      }
    }
  }

  // ── Curated Picks Integration (Discord) ────────────────────────────
  {
    const discordAdapterPicks = adapterByPlatform.get('discord') as any;
    const openaiKeyPicks = process.env.OPENAI_API_KEY;
    const scraperUrl = (cfg as any)?.feeds?.scraperApiUrl || 'http://localhost:8420';
    const curatedPicksChannelId = discordAdapterPicks
      ? await resolveCuratedPicksChannelId(cfg, discordAdapterPicks.service)
      : undefined;

    if (discordAdapterPicks && curatedPicksChannelId && openaiKeyPicks) {
      try {
        const { createCuratedPicksHandler } = await import('../../../discord/curatedPicksHandler.js');
        const picksHandler = createCuratedPicksHandler({
          channelId: curatedPicksChannelId,
          openaiApiKey: openaiKeyPicks,
          systemPrompt: (cfg as any)?.systemPrompt || '',
          scraperApiUrl: scraperUrl,
          model: 'gpt-4o',  // Always use gpt-4o for curated picks — quality matters
          newsBotToken: process.env.WUNDERBOT_NEWS_TOKEN,  // Post as "Wunderland News" bot
        });
        if (discordAdapterPicks.service) {
          picksHandler.startSchedule(discordAdapterPicks.service);
          fmt.ok('Curated picks handler started');
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        fmt.warning(`Curated picks failed: ${msg}`);
      }
    } else if (discordAdapterPicks && openaiKeyPicks) {
      fmt.warning('Curated picks channel could not be resolved');
    }
  }
}

/**
 * Subscribe every allowed channel adapter to inbound messages and enqueue
 * them for sequential per-conversation processing.
 */
export function subscribeChannelAdapters(ctx: ChannelRuntimeCtx): void {
  const { adapterByPlatform, channelUnsubs } = ctx;

  if (adapterByPlatform.size > 0) {
    for (const [platform, adapter] of adapterByPlatform.entries()) {
      if (!isChannelAllowedByPolicy(ctx, platform)) continue;
      try {
        const unsub = adapter.on(async (event: any) => {
          if (!event || event.type !== 'message') return;
          const data = event.data as ChannelMessage;
          if (!data) return;
          const key = `${platform}:${String(data.conversationId || '').trim()}`;
          enqueueChannelTurn(ctx, key, async () => {
            await handleInboundChannelMessage(ctx, data);
          });
        }, ['message']);
        channelUnsubs.push(unsub);
      } catch (err) {
        console.warn(`[channels] Failed to subscribe to ${platform} adapter:`, err instanceof Error ? err.message : String(err));
      }
    }
  }
}
