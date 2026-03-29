/**
 * @fileoverview Chat route handlers for the CLI HTTP server.
 * @module wunderland/cli/commands/start/routes/chat
 *
 * Endpoints handled:
 *  - `POST /chat` — Send a message and receive the agent's reply.
 *                    Supports session management, persona switching,
 *                    HITL tool-call approvals, adaptive execution,
 *                    research depth classification (auto + explicit),
 *                    SSE streaming mode, and capability discovery.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';

import {
  buildToolDefs,
  runToolCallingTurn,
  safeJsonStringify,
  type ToolInstance,
} from '../../../../runtime/tool-calling.js';
import {
  classifyResearchDepth,
  buildResearchPrefix,
  createResearchClassifierLlmCall,
  shouldInjectResearch,
  type ResearchDepth,
} from '../../../../runtime/research-classifier.js';
import {
  buildPersonaSessionKey,
  createRequestScopedToolMap,
  extractRequestedPersonaId,
  resolveRequestScopedPersonaRuntime,
} from '../../../../runtime/request-persona.js';
import { buildOllamaRuntimeOptions } from '../../../../runtime/ollama-options.js';

import {
  readBody,
  sendJson,
  getHeaderString,
  isChatAuthorized,
  isLoopbackRequest,
} from './helpers.js';
import type { CliServerDeps, RouteHandlerResult } from './types.js';

/** Map a tool to an AgentOS approval category based on its name and metadata. */
type AgentosApprovalCategory = 'data_modification' | 'external_api' | 'financial' | 'communication' | 'system' | 'other';

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

/**
 * Attempt to handle chat-related routes.
 *
 * @returns `true` if the request was handled, `false` to fall through
 */
export async function handleChatRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: CliServerDeps,
): Promise<RouteHandlerResult> {
  if (req.method !== 'POST' || url.pathname !== '/chat') return false;

  const {
    seedId,
    displayName,
    activePersonaId,
    availablePersonas,
    seed,
    providerId,
    model,
    llmApiKey,
    llmBaseUrl,
    canUseLLM,
    openrouterFallback,
    oauthGetApiKey,
    cfg,
    rawAgentConfig,
    globalConfig,
    configDir,
    policy,
    toolMap,
    sessions,
    systemPrompt,
    adaptiveRuntime,
    discoveryManager,
    strictToolNames,
    autoApproveToolCalls,
    dangerouslySkipPermissions,
    turnApprovalMode,
    defaultTenantId,
    workspaceAgentId,
    workspaceBaseDir,
    lazyTools,
    skillsPrompt,
    chatSecret,
    hitlManager,
    sessionTextLogger,
  } = deps;

  if (!isChatAuthorized(req, url, chatSecret)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return true;
  }

  const body = await readBody(req);
  const parsed = JSON.parse(body || '{}');
  let message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
  if (!message) {
    sendJson(res, 400, { error: 'Missing "message" in JSON body.' });
    return true;
  }

  /* ── Research depth escalation ──────────────────────────────────────────── */
  const researchMatch = message.match(/^\/(research|deep)\s+(.+)/is);
  let researchDepth: string | null = parsed.research === true ? 'moderate'
    : parsed.research === 'deep' ? 'deep'
    : parsed.research === 'quick' ? 'quick'
    : researchMatch ? (researchMatch[1].toLowerCase() === 'deep' ? 'deep' : 'moderate')
    : null;
  if (researchMatch) message = researchMatch[2].trim();

  /* Auto-classify with LLM-as-judge when no explicit depth */
  const autoClassifyEnabled = cfg?.research?.autoClassify !== false && parsed.autoClassify !== false;
  if (!researchDepth && autoClassifyEnabled) {
    try {
      const classifierResult = await classifyResearchDepth(message, {
        enabled: true,
        llmCall: createResearchClassifierLlmCall({
          providerId,
          apiKey: llmApiKey,
          baseUrl: llmBaseUrl,
        }),
      });
      const minDepth = (cfg?.research?.minDepthToInject as ResearchDepth) || 'quick';
      if (shouldInjectResearch(classifierResult.depth, minDepth)) {
        researchDepth = classifierResult.depth;
      }
    } catch {
      // Classification failure -- proceed without research injection
    }
  }

  if (researchDepth) {
    const prefix = buildResearchPrefix(researchDepth as ResearchDepth);
    if (prefix) message = `${prefix}\n\n${message}`;
  }

  const streamMode = parsed.stream === true;

  /* When streaming, switch to SSE so progress events can be pushed to the client. */
  if (streamMode) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
  }

  let reply = '';
  let turnFailed = false;
  let fallbackTriggered = false;
  let toolCallCount = 0;
  let turnError: unknown;
  const sessionId = typeof parsed.sessionId === 'string' && parsed.sessionId.trim()
    ? parsed.sessionId.trim().slice(0, 128)
    : 'default';
  const requestedPersonaId = extractRequestedPersonaId(parsed);
  let requestActivePersonaId = activePersonaId;
  let requestSystemPrompt = systemPrompt;
  let requestToolMap = toolMap;

  if (requestedPersonaId && requestedPersonaId !== activePersonaId) {
    const personaRuntime = await resolveRequestScopedPersonaRuntime({
      rawAgentConfig: rawAgentConfig ?? cfg,
      requestedPersonaId,
      workingDirectory: configDir ?? process.cwd(),
      policy,
      mode: 'server',
      lazyTools: lazyTools === true,
      autoApproveToolCalls,
      turnApprovalMode,
      skillsPrompt: skillsPrompt || undefined,
      globalAgentName: globalConfig?.agentName,
    });

    if (!personaRuntime) {
      sendJson(res, 400, {
        error: `Persona '${requestedPersonaId}' not found.`,
        availablePersonaIds: Array.isArray(availablePersonas) ? availablePersonas.map((persona: any) => persona.id) : [],
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
    messages = [messages[0]!, ...messages.slice(-120)];
    sessions.set(internalSessionId, messages);
  }

  messages.push({ role: 'user', content: message });

  /*
   * Work on a shallow copy so a mid-flight tool-call failure
   * doesn't corrupt the persisted session history with orphaned
   * tool_calls entries.
   */
  const workingMessages = [...messages];

  try {
    if (canUseLLM) {
      /* ── Capability discovery — inject tiered context AND build filtered tool set ── */
      let apiDiscoveredToolNames: Set<string> | null = null;
      try {
        const discoveryResult = await discoveryManager?.discoverForTurn?.(message);
        if (discoveryResult) {
          for (let i = workingMessages.length - 1; i >= 1; i--) {
            if (typeof workingMessages[i]?.content === 'string' && String(workingMessages[i]!.content).startsWith('[Capability Context]')) {
              workingMessages.splice(i, 1);
            }
          }
          const ctxParts: string[] = ['[Capability Context]', discoveryResult.tier0];
          if (discoveryResult.tier1.length > 0) {
            ctxParts.push('Relevant capabilities:\n' + discoveryResult.tier1.map((r: any) => r.summaryText).join('\n'));
          }
          if (discoveryResult.tier2.length > 0) {
            ctxParts.push(discoveryResult.tier2.map((r: any) => r.fullText).join('\n'));
          }
          workingMessages.splice(1, 0, { role: 'system', content: ctxParts.join('\n') });

          /* Extract discovered tool names for filtered tool defs */
          const names = new Set<string>();
          for (const r of discoveryResult.tier1) {
            if (r.capability?.kind === 'tool') {
              const toolName = r.capability.id?.startsWith('tool:') ? r.capability.id.slice(5) : r.capability.name;
              names.add(toolName);
            }
          }
          for (const r of discoveryResult.tier2) {
            if (r.capability?.kind === 'tool') {
              const toolName = r.capability.id?.startsWith('tool:') ? r.capability.id.slice(5) : r.capability.name;
              names.add(toolName);
            }
          }
          for (const [name] of requestToolMap) {
            if (name.startsWith('extensions_') || name === 'discover_capabilities') names.add(name);
          }
          if (names.size > 0) apiDiscoveredToolNames = names;
        }
      } catch {
        // Non-fatal
      }

      const toolContext = {
        gmiId: `wunderland-server-${internalSessionId}`,
        personaId: requestActivePersonaId,
        userContext: {
          userId: sessionId,
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

      /* Build filtered tool defs based on discovery. */
      const useFilteredToolDefs =
        apiDiscoveredToolNames && adaptiveDecision.actions?.forcedToolSelectionMode !== true;
      const apiFilteredGetToolDefs = useFilteredToolDefs
        ? () => {
          const filtered = new Map<string, ToolInstance>();
          for (const [name, tool] of requestToolMap) {
            if (apiDiscoveredToolNames!.has(name)) {
              filtered.set(name, tool);
            }
          }
          return buildToolDefs(filtered, { strictToolNames });
        }
        : undefined;

      reply = await runToolCallingTurn({
        providerId,
        apiKey: llmApiKey,
        model,
        messages: workingMessages,
        toolMap: requestToolMap,
        ...(apiFilteredGetToolDefs && { getToolDefs: apiFilteredGetToolDefs }),
        toolContext,
        maxRounds: 8,
        dangerouslySkipPermissions,
        strictToolNames,
        toolFailureMode: adaptiveDecision.toolFailureMode,
        ollamaOptions: buildOllamaRuntimeOptions(cfg?.ollama),
        onToolCall: (tool: ToolInstance, args: Record<string, unknown>) => {
          toolCallCount += 1;
          deps.broadcastAgentEvent?.({
            type: 'tool_call',
            toolName: tool?.name ?? 'unknown',
            message: 'Tool invoked',
            args,
          });
        },
        askPermission: async (tool: ToolInstance, args: Record<string, unknown>) => {
          if (autoApproveToolCalls) return true;

          /* Auto-approve read-only tools via HTTP API */
          if (tool.hasSideEffects !== true) return true;

          /* Explicit auto-approval for side-effect tools (loopback or authenticated) */
          const explicitAutoApprove =
            getHeaderString(req, 'x-auto-approve').toLowerCase() === 'true';
          if (
            explicitAutoApprove &&
            (isLoopbackRequest(req) || (!!chatSecret && isChatAuthorized(req, url, chatSecret)))
          ) {
            return true;
          }

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
          } as any);
          return decision.approved === true;
        },
        askCheckpoint: turnApprovalMode === 'off' ? undefined : async ({ round, toolCalls }: any) => {
          if (autoApproveToolCalls) return true;

          const checkpointId = `checkpoint-${seedId}-${internalSessionId}-${round}-${randomUUID()}`;
          const completedWork = toolCalls.map((c: any) => {
            const effect = c.hasSideEffects ? 'side effects' : 'read-only';
            const preview = safeJsonStringify(c.args, 800);
            return `${c.toolName} (${effect})\n${preview}`;
          });

          const timeoutMs = 5 * 60_000;
          const checkpointPromise = hitlManager.checkpoint({
            checkpointId,
            workflowId: `chat-${internalSessionId}`,
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
        onFallback: (err: any, provider: any) => {
          fallbackTriggered = true;
          console.warn(`[fallback] Primary provider failed (${err.message}), routing to ${provider}`);
        },
        getApiKey: oauthGetApiKey as any,
        onToolProgress: streamMode
          ? (info) => {
              try {
                const chunk = JSON.stringify({
                  type: 'SYSTEM_PROGRESS',
                  toolName: info.toolName,
                  phase: info.phase,
                  message: info.message,
                  progress: info.progress ?? null,
                });
                res.write(`event: progress\ndata: ${chunk}\n\n`);
              } catch {
                // Connection may have been closed
              }
            }
          : undefined,
      });
    } else {
      reply =
        'No LLM credentials configured. I can run, but I cannot generate real replies yet.\n\n' +
        'Set an API key in .env (OPENAI_API_KEY / OPENROUTER_API_KEY / ANTHROPIC_API_KEY) or use Ollama, then retry.\n\n' +
        `You said: ${message}`;
    }
    /* Turn succeeded — commit working messages back to the session. */
    sessions.set(internalSessionId, workingMessages);
  } catch (error) {
    turnFailed = true;
    turnError = error;
    if (streamMode) {
      try {
        const errChunk = JSON.stringify({
          type: 'ERROR',
          error: error instanceof Error ? error.message : String(error),
        });
        res.write(`event: error\ndata: ${errChunk}\n\n`);
      } catch { /* ignore */ }
    } else {
      throw error;
    }
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
      console.warn('[wunderland/start][api] failed to record adaptive outcome', error);
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

  /* Strip <think>...</think> blocks from models like qwen3. */
  if (typeof reply === 'string') {
    reply = reply.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
    reply = reply.replace(/\*{0,2}<think>[\s\S]*?<\/think>\*{0,2}\s*/g, '').trim();
  }

  if (streamMode) {
    if (!turnFailed) {
      try {
        const finalChunk = JSON.stringify({
          type: 'REPLY',
          reply,
          personaId: requestActivePersonaId,
        });
        res.write(`event: reply\ndata: ${finalChunk}\n\n`);
      } catch { /* ignore */ }
    }
    res.end();
  } else {
    sendJson(res, 200, { reply, personaId: requestActivePersonaId });
  }
  return true;
}
