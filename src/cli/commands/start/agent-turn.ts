// @ts-nocheck
/**
 * @fileoverview `runAgentTurn` — run a full agent tool-calling turn from the
 * persistent server context, out-of-band from any HTTP request.
 * @module wunderland/cli/commands/start/agent-turn
 *
 * The `/chat` route wraps `runToolCallingTurn` in ~250 lines of request-scoped
 * assembly (SSE, research escalation, interactive HITL). Webhook wakes and cron
 * dispatch have no request and no human, so they need a leaner runner that:
 *  - assembles history/persona/tools from `CliServerDeps`,
 *  - serializes turns on the same session (shared history is a plain Map),
 *  - gates tools autonomously (read-only auto-approved; side-effect tools run
 *    only under an explicit skip/auto-approve flag — never an interactive prompt
 *    that would hang a headless turn, never a silent side effect), and with
 *    `hitl.mode: "remote"` asks the server before an outward tool,
 *  - persists the reply back onto the session the `/chat` reader also uses,
 *  - sends the turn where `/chat` sends it: the primary provider's base URL
 *    (`deps.llmBaseUrl`) and, when the primary fails, the fallback candidate
 *    (`deps.openrouterFallback`).
 */

import { runToolCallingTurn } from '../../../runtime/tools/tool-calling.js';
import { buildPersonaSessionKey } from '../../../runtime/execution/request-persona.js';
import { KeyedMutex } from '../../../runtime/execution/keyed-mutex.js';
import { allowedToolNamesFor } from '../../../runtime/tools/tool-allow-list.js';
import { startReportedTurn } from './hosted-events.js';
import { askRemoteApproval, outwardApprovalFor } from './remote-approvals.js';

/** One shared mutex per process: serializes turns that share a session key. */
const sessionMutex = new KeyedMutex();

export interface AgentTurnRequest {
  /** Logical session id, e.g. "webhook:gh" | "cron:{jobId}". */
  sessionId: string;
  /** The stimulus text. */
  message: string;
  /** Provenance tag for logging/observability, e.g. "webhook:gh". */
  source: string;
  /** Persona override; defaults to the server's active persona. */
  personaId?: string;
}

export interface AgentTurnResult {
  reply: string;
  toolCallCount: number;
  failed: boolean;
}

const HISTORY_HARD_CAP = 200;
const HISTORY_KEEP_TAIL = 120;

/**
 * Autonomous tool-approval policy: read-only tools are always allowed;
 * side-effect tools require an explicit skip/auto-approve flag. Returns false
 * (deny) otherwise — a headless turn must never block on a human it has no way
 * to reach, and must never run a side effect the operator did not authorize.
 * With `hitl.mode: "remote"` it has a way: the server is asked instead of a deny.
 */
function makeAutonomousAskPermission(deps: any, reportedTurn: any) {
  const allowSideEffects =
    deps.dangerouslySkipPermissions === true || deps.autoApproveToolCalls === true;
  return async (tool: { name?: string; hasSideEffects?: boolean }, args: Record<string, unknown>): Promise<boolean> => {
    if (tool?.hasSideEffects !== true) return true;
    if (allowSideEffects) return true;
    if (!deps.remoteApprovalHandler) return false;
    return (await askRemoteApproval(deps.remoteApprovalHandler, tool, args, { reportedTurn })).approved;
  };
}

/**
 * Run one agent turn from server context. Never throws for turn-level failures
 * (LLM errors, tool errors) — those surface as `{ failed: true }` so callers
 * (webhook bridge, cron dispatch) can fire-and-forget with a single `.catch`
 * for truly unexpected errors only.
 */
export async function runAgentTurn(
  deps: any,
  req: AgentTurnRequest,
): Promise<AgentTurnResult> {
  const personaId = req.personaId ?? deps.activePersonaId ?? 'default';
  const sessionKey = buildPersonaSessionKey(req.sessionId, personaId);

  return sessionMutex.runExclusive(sessionKey, async () => {
    let toolCallCount = 0;

    if (deps.canUseLLM === false) {
      return { reply: '', toolCallCount, failed: true };
    }

    // Load / seed / cap history the same way the /chat route does.
    let messages = deps.sessions.get(sessionKey);
    if (!messages) {
      messages = [{ role: 'system', content: deps.systemPrompt }];
      deps.sessions.set(sessionKey, messages);
    }
    if (messages.length > HISTORY_HARD_CAP) {
      messages = [messages[0], ...messages.slice(-HISTORY_KEEP_TAIL)];
      deps.sessions.set(sessionKey, messages);
    }
    messages.push({ role: 'user', content: req.message });

    // Shallow copy so a mid-flight failure can't leave orphaned tool_calls in
    // the persisted history.
    const workingMessages = [...messages];

    const reportedTurn = startReportedTurn(deps.eventsReporter);
    try {
      const reply = await runToolCallingTurn({
        providerId: deps.providerId,
        apiKey: deps.llmApiKey,
        model: deps.model,
        messages: workingMessages,
        toolMap: deps.toolMap,
        // tools.allow: offer and run only the listed tools; any other call is
        // answered tool_not_allowed at dispatch.
        allowedToolNames: allowedToolNamesFor(deps.cfg),
        toolContext: {
          seedId: deps.seedId,
          sessionId: req.sessionId,
          personaId,
          source: req.source,
        },
        maxRounds: 8,
        dangerouslySkipPermissions: deps.dangerouslySkipPermissions === true,
        // hitl.mode "remote": outward tools ask first, whatever the tiers and flags say.
        outwardApproval: outwardApprovalFor(deps.remoteApprovalHandler, { reportedTurn }),
        askPermission: makeAutonomousAskPermission(deps, reportedTurn),
        // The same provider routing the /chat route uses: the primary
        // provider's base URL (its base-URL variable), the fallback candidate
        // and the OAuth key resolver.
        baseUrl: deps.llmBaseUrl,
        fallback: deps.openrouterFallback,
        onFallback: (err: Error, provider: string) => {
          console.warn(`[runAgentTurn] primary provider failed (${err.message}), routing to ${provider} source=${req.source}`);
        },
        getApiKey: deps.oauthGetApiKey,
        onUsage: reportedTurn.usage,
        onProviderError: reportedTurn.providerError,
        onToolCall: (tool: { name?: string }, args: Record<string, unknown>) => {
          toolCallCount += 1;
          reportedTurn.toolCalled(tool?.name);
          deps.broadcastAgentEvent?.({
            type: 'tool_call',
            toolName: tool?.name ?? 'unknown',
            message: `Tool invoked (${req.source})`,
            args,
          });
        },
      });

      const cleaned =
        typeof reply === 'string'
          ? reply.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim()
          : String(reply ?? '');

      messages.push({ role: 'assistant', content: cleaned });
      deps.broadcastAgentEvent?.({ type: 'agent_reply', source: req.source, reply: cleaned });
      return { reply: cleaned, toolCallCount, failed: false };
    } catch (err) {
      console.warn(`[runAgentTurn] turn failed source=${req.source}:`, err);
      deps.broadcastAgentEvent?.({
        type: 'agent_turn_failed',
        source: req.source,
        error: err instanceof Error ? err.message : String(err),
      });
      return { reply: '', toolCallCount, failed: true };
    } finally {
      reportedTurn.finished();
    }
  });
}
