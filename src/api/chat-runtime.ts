// @ts-nocheck
/**
 * @fileoverview High-level in-process chat runtime for Wunderland.
 * @module wunderland/api/chat-runtime
 *
 * This is the programmatic counterpart to `wunderland chat`:
 * - Loads tools from extension packs (optional)
 * - Applies permission-set + tool-access-profile filtering
 * - Runs the OpenAI/Anthropic tool-calling loop with guardrails
 *
 * It intentionally does NOT start an HTTP server. Use `wunderland start` when you
 * want the full server + HITL UI + channel runtime.
 *
 * Internally delegates to {@link AgentBootstrap.create} for the 14-step
 * initialization sequence, then wraps the bootstrapped agent in the
 * session-based {@link WunderlandChatRuntime} API.
 */

import type { NormalizedRuntimePolicy } from '../runtime/policy.js';
import { runToolCallingTurn, type ToolInstance } from '../runtime/tool-calling.js';
import { buildOllamaRuntimeOptions } from '../runtime/ollama-options.js';
import type { WunderlandAgentConfig, WunderlandLLMConfig, WunderlandWorkspace } from './types.js';
import { AgentMemory } from '@framers/agentos';
import type { ICognitiveMemoryManager } from '@framers/agentos/memory';
import { injectMemoryContext } from '../memory/index.js';
import { AgentBootstrap } from '../bootstrap/index.js';

type LoggerLike = {
  debug?: (msg: string, meta?: unknown) => void;
  info?: (msg: string, meta?: unknown) => void;
  warn?: (msg: string, meta?: unknown) => void;
  error?: (msg: string, meta?: unknown) => void;
};

export type WunderlandChatRuntime = {
  readonly policy: NormalizedRuntimePolicy;
  readonly toolMap: Map<string, ToolInstance>;
  readonly memory?: AgentMemory;
  /** Returns a copy of the current message history for a session. */
  getMessages: (sessionId?: string) => Array<Record<string, unknown>>;
  /** Run one user turn and return the assistant's text reply. */
  runTurn: (
    input: string,
    opts?: {
      sessionId?: string;
      onToolCall?: (tool: ToolInstance, args: Record<string, unknown>) => void;
    },
  ) => Promise<string>;
};

/**
 * Resolve an {@link AgentMemory} or {@link ICognitiveMemoryManager} input
 * into a canonical {@link AgentMemory} instance (or undefined).
 */
function resolveAgentMemory(
  input: AgentMemory | ICognitiveMemoryManager | undefined,
): AgentMemory | undefined {
  if (!input) return undefined;
  const candidate = input as { remember?: unknown; recall?: unknown; raw?: unknown };
  if (
    input instanceof AgentMemory ||
    (
      typeof input === 'object' &&
      typeof candidate.remember === 'function' &&
      typeof candidate.recall === 'function' &&
      'raw' in candidate
    )
  ) {
    return input as unknown as AgentMemory;
  }
  return AgentMemory.wrap(input);
}

/**
 * Create a high-level in-process chat runtime.
 *
 * Delegates the 14-step agent initialization to {@link AgentBootstrap.create},
 * then wraps the result in a session-based API with `getMessages()` and
 * `runTurn()`.
 */
export async function createWunderlandChatRuntime(opts: {
  agentConfig?: WunderlandAgentConfig;
  llm: WunderlandLLMConfig;
  workspace?: Partial<WunderlandWorkspace>;
  workingDirectory?: string;
  memory?: AgentMemory | ICognitiveMemoryManager;
  /**
   * When true, bypasses Tier-3 approvals (fully autonomous). Still enforces:
   * - permission sets
   * - tool access profiles
   * - SafeGuardrails validation
   */
  autoApproveToolCalls?: boolean;
  /**
   * Required unless `autoApproveToolCalls` is true or the config's `executionMode`
   * is `autonomous`.
   */
  askPermission?: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
  logger?: LoggerLike;
}): Promise<WunderlandChatRuntime> {
  const memory = resolveAgentMemory(opts.memory);
  const workingDirectory = opts.workingDirectory ?? process.cwd();

  // ── Delegate bootstrap to shared AgentBootstrap ───────────────────────
  const agent = await AgentBootstrap.create({
    agentConfig: opts.agentConfig ?? {},
    providerId: opts.llm.providerId,
    apiKey: opts.llm.apiKey,
    baseUrl: opts.llm.baseUrl,
    mode: 'library',
    autoApproveToolCalls: opts.autoApproveToolCalls,
    workspaceId: opts.workspace?.agentId,
    workspaceBaseDir: opts.workspace?.baseDir,
    workingDirectory,
    logger: opts.logger,
  });

  const { policy, toolMap, toolContext, systemPrompt, agentConfig, strictToolNames } = agent;

  const sessions = new Map<string, Array<Record<string, unknown>>>();
  const autoApprove =
    opts.autoApproveToolCalls === true || policy.executionMode === 'autonomous';

  if (!autoApprove && typeof opts.askPermission !== 'function') {
    throw new Error(
      'createWunderlandChatRuntime: askPermission is required unless autoApproveToolCalls=true or executionMode="autonomous".',
    );
  }

  const askPermission = async (tool: ToolInstance, args: Record<string, unknown>) => {
    if (autoApprove) return true;
    return (opts.askPermission as any)(tool, args);
  };

  return {
    policy,
    toolMap,
    memory,
    getMessages: (sessionId?: string) => {
      const key = sessionId && sessionId.trim() ? sessionId.trim() : 'default';
      const msgs = sessions.get(key) ?? [];
      return msgs.map((m) => ({ ...m }));
    },
    runTurn: async (input: string, runOpts) => {
      const key = runOpts?.sessionId && runOpts.sessionId.trim() ? runOpts.sessionId.trim() : 'default';
      const history = sessions.get(key) ?? [
        { role: 'system', content: systemPrompt },
      ];

      const userContent = String(input ?? '');
      history.push({ role: 'user', content: userContent });

      // Feed user message to memory observer (automatic observation extraction)
      if (memory?.observe) {
        memory.observe('user', userContent).catch(() => {});
      }

      // Retrieve and inject memory context
      if (agent.memorySystem) {
        await injectMemoryContext(history as any, agent.memorySystem, userContent).catch(() => {});
      }

      const reply = await runToolCallingTurn({
        providerId: opts.llm.providerId,
        apiKey: opts.llm.apiKey,
        model: opts.llm.model,
        messages: history,
        toolMap,
        toolContext,
        maxRounds: 8,
        dangerouslySkipPermissions: false,
        strictToolNames,
        askPermission,
        onToolCall: runOpts?.onToolCall,
        baseUrl: opts.llm.baseUrl,
        ollamaOptions: buildOllamaRuntimeOptions(agentConfig.ollama),
        fallback: opts.llm.fallback,
      });

      // Feed assistant reply to memory observer
      if (memory?.observe && reply) {
        memory.observe('assistant', String(reply)).catch(() => {});
      }

      sessions.set(key, history);
      return reply;
    },
  };
}
