/**
 * @fileoverview Chat route handlers for the Wunderland API server.
 * @module wunderland/api/routes/chat
 *
 * Endpoints handled:
 *  - `POST /chat` — Send a message and receive the agent's reply.
 *                    Supports session management, persona switching,
 *                    HITL tool-call approvals, adaptive execution,
 *                    research depth escalation, and capability discovery.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import {
  runToolCallingTurn,
  safeJsonStringify,
  type ToolInstance,
} from '../../runtime/tool-calling.js';
import {
  buildPersonaSessionKey,
  createRequestScopedToolMap,
  extractRequestedPersonaId,
  resolveRequestScopedPersonaRuntime,
} from '../../runtime/request-persona.js';
import { buildOllamaRuntimeOptions } from '../../runtime/ollama-options.js';

import { readBody, sendJson } from '../server-helpers.js';
import type { ServerDeps, RouteHandlerResult } from './types.js';

/**
 * Map a tool to an AgentOS approval category based on its name and metadata.
 * Used to classify HITL approval requests for the operator UI.
 */
type AgentosApprovalCategory = 'data_modification' | 'external_api' | 'financial' | 'communication' | 'system' | 'other';

function toAgentosApprovalCategory(
  tool: ToolInstance,
): AgentosApprovalCategory {
  const name = String(tool?.name || '').toLowerCase();
  if (
    name.startsWith('file_') ||
    name.includes('shell_') ||
    name.includes('run_command') ||
    name.includes('exec')
  ) {
    return 'system';
  }
  if (name.startsWith('browser_') || name.includes('web_')) return 'external_api';
  const cat = String((tool as any)?.category || '').toLowerCase();
  if (cat.includes('financial')) return 'financial';
  if (cat.includes('communication')) return 'communication';
  if (cat.includes('external') || cat.includes('api') || cat === 'research' || cat === 'search') return 'external_api';
  if (cat.includes('data')) return 'data_modification';
  if (cat.includes('system') || cat.includes('filesystem')) return 'system';
  return 'other';
}

/**
 * Attempt to handle chat-related routes.
 *
 * @param req  - Incoming HTTP request
 * @param res  - Server response
 * @param url  - Parsed request URL
 * @param deps - Shared server dependencies
 * @returns `true` if the request was handled, `false` to fall through
 */
export async function handleChatRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: ServerDeps,
): Promise<RouteHandlerResult> {
  if (url.pathname !== '/chat' || req.method !== 'POST') return false;

  const {
    seedId,
    displayName,
    activePersonaId,
    availablePersonas,
    providerId,
    model,
    llmApiKey,
    llmBaseUrl,
    canUseLLM,
    openrouterFallback,
    seed,
    cfg,
    rawAgentConfig,
    policy,
    toolMap,
    sessions,
    systemPrompt,
    adaptiveRuntime,
    strictToolNames,
    autoApproveToolCalls,
    turnApprovalMode,
    defaultTenantId,
    workspaceAgentId,
    workspaceBaseDir,
    hitlManager,
    sessionTextLogger,
    logger,
    lazyTools,
    skillsPrompt,
    workingDirectory,
    loadedChannelAdapters,
    configDirOverride,
  } = deps;

  const body = await readBody(req);
  const parsed = JSON.parse(body || '{}');
  const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
  if (!message) {
    sendJson(res, 400, { error: 'Missing "message" in JSON body.' });
    return true;
  }

  let reply = '';
  let turnFailed = false;
  let fallbackTriggered = false;
  let toolCallCount = 0;
  let turnError: unknown;
  const sessionId =
    typeof parsed.sessionId === 'string' && parsed.sessionId.trim() ? parsed.sessionId.trim().slice(0, 128) : 'default';
  const requestedPersonaId = extractRequestedPersonaId(parsed);
  let requestActivePersonaId = activePersonaId;
  let requestSystemPrompt = systemPrompt;
  let requestToolMap = toolMap;

  if (requestedPersonaId && requestedPersonaId !== activePersonaId) {
    const personaRuntime = await resolveRequestScopedPersonaRuntime({
      rawAgentConfig,
      requestedPersonaId,
      workingDirectory,
      logger,
      policy,
      mode: 'server',
      lazyTools,
      autoApproveToolCalls,
      turnApprovalMode,
      skillsPrompt: skillsPrompt || undefined,
      channelNames:
        loadedChannelAdapters.length > 0
          ? loadedChannelAdapters
            .map((adapter: any) => adapter.displayName || adapter.platform)
            .filter((name: unknown): name is string => typeof name === 'string' && name.trim().length > 0)
          : undefined,
    });

    if (!personaRuntime) {
      sendJson(res, 400, {
        error: `Persona '${requestedPersonaId}' not found.`,
        availablePersonaIds: Array.isArray(availablePersonas) ? availablePersonas.map((persona) => persona.id) : [],
      });
      return true;
    }

    requestActivePersonaId = personaRuntime.activePersonaId;
    requestSystemPrompt = personaRuntime.systemPrompt;
    requestToolMap = createRequestScopedToolMap(toolMap, personaRuntime.agentConfig);
  }

  const internalSessionId = buildPersonaSessionKey(sessionId, requestActivePersonaId);
  const requestedToolFailureMode =
    typeof parsed.toolFailureMode === 'string' ? parsed.toolFailureMode : undefined;
  const tenantId =
    (typeof parsed.tenantId === 'string' && parsed.tenantId.trim())
    || defaultTenantId;
  const adaptiveDecision = adaptiveRuntime.resolveTurnDecision({
    scope: {
      sessionId,
      userId: sessionId,
      personaId: requestActivePersonaId,
      tenantId: tenantId || undefined,
    },
    requestedToolFailureMode,
  });

  if (parsed.reset === true) {
    sessions.delete(internalSessionId);
  }

  let messages = sessions.get(internalSessionId);
  if (!messages) {
    messages = [{ role: 'system', content: requestSystemPrompt }];
    sessions.set(internalSessionId, messages);
  }

  /* Keep a soft cap to avoid unbounded memory in long-running servers. */
  if (messages.length > 200) {
    messages = [messages[0], ...messages.slice(-120)];
    sessions.set(internalSessionId, messages);
  }

  messages.push({ role: 'user', content: message });

  try {
    if (canUseLLM) {
      const toolContext: Record<string, unknown> = {
        gmiId: `wunderland-server-${internalSessionId}`,
        sessionId,
        personaId: requestActivePersonaId,
        userContext: {
          userId: sessionId,
          ...(tenantId ? { organizationId: tenantId } : null),
        },
        ...(configDirOverride ? { wunderlandConfigDir: configDirOverride } : null),
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

      reply = await runToolCallingTurn({
        providerId,
        apiKey: llmApiKey,
        model,
        messages,
        toolMap: requestToolMap,
        toolContext,
        maxRounds: 8,
        dangerouslySkipPermissions: autoApproveToolCalls,
        strictToolNames,
        toolFailureMode: adaptiveDecision.toolFailureMode,
        ollamaOptions: buildOllamaRuntimeOptions(cfg?.ollama),
        onToolCall: () => {
          toolCallCount += 1;
        },
        askPermission: async (tool, args) => {
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
            context: { toolName: tool.name, args, sessionId, personaId: requestActivePersonaId },
            reversible: tool.hasSideEffects !== true,
            requestedAt: new Date(),
            timeoutMs: 5 * 60_000,
          });
          return decision.approved === true;
        },
        askCheckpoint:
          turnApprovalMode === 'off'
            ? undefined
            : async ({ round, toolCalls }) => {
                if (autoApproveToolCalls) return true;
                const checkpointId = `checkpoint-${seedId}-${internalSessionId}-${round}-${randomUUID()}`;
                const completedWork = toolCalls.map((c) => {
                  const effect = c.hasSideEffects ? 'side effects' : 'read-only';
                  const preview = safeJsonStringify(c.args, 800);
                  return `${c.toolName} (${effect})\n${preview}`;
                });
                const timeoutMs = 5 * 60_000;
                const checkpointPromise = hitlManager
                  .checkpoint({
                    checkpointId,
                    workflowId: `chat-${internalSessionId}`,
                    currentPhase: `tool-round-${round}`,
                    progress: Math.min(1, (round + 1) / 8),
                    completedWork,
                    upcomingWork: ['Continue to next LLM round'],
                    issues: [],
                    notes: 'Continue?',
                    checkpointAt: new Date(),
                  })
                  .catch(() => ({ decision: 'abort' as const }));
                const timeoutPromise = new Promise<{ decision: 'abort' }>((resolve) =>
                  setTimeout(() => resolve({ decision: 'abort' }), timeoutMs),
                );
                const decision = (await Promise.race([checkpointPromise, timeoutPromise])) as any;
                if (decision?.decision !== 'continue') {
                  try {
                    await hitlManager.cancelRequest(checkpointId, 'checkpoint_timeout_or_abort');
                  } catch {
                    // ignore
                  }
                }
                return decision?.decision === 'continue';
              },
        baseUrl: llmBaseUrl,
        fallback: providerId === 'openai' ? openrouterFallback : undefined,
        onFallback: (err, provider) => {
          fallbackTriggered = true;
          logger.warn?.('[wunderland/api] fallback activated', { error: err.message, provider });
        },
      });
    } else {
      reply =
        'No LLM credentials configured. I can run, but I cannot generate real replies yet.\n\n' +
        'Set an API key in .env (OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY) or use Ollama, then retry.\n\n' +
        `You said: ${message}`;
    }
  } catch (error) {
    turnFailed = true;
    turnError = error;
    throw error;
  } finally {
    try {
      await adaptiveRuntime.recordTurnOutcome({
        scope: {
          sessionId,
          userId: sessionId,
          personaId: requestActivePersonaId,
          tenantId: tenantId || undefined,
        },
        degraded: adaptiveDecision.degraded || fallbackTriggered,
        replyText: reply,
        didFail: turnFailed,
        toolCallCount,
      });
    } catch (error) {
      logger.warn?.('[wunderland/api][chat] failed to record adaptive outcome', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    await sessionTextLogger.logTurn({
      meta: {
        agentId: workspaceAgentId,
        seedId,
        displayName,
        providerId: String(providerId),
        model,
        personaId: requestActivePersonaId,
      },
      sessionId,
      userText: message,
      reply,
      error: turnError,
      toolCallCount,
      durationMs: 0,
      fallbackTriggered,
    });
  }

  sendJson(res, 200, { reply, personaId: requestActivePersonaId });
  return true;
}
