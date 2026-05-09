// @ts-nocheck
/**
 * @fileoverview Wunderland execution bridge for AgentOS compiled graphs.
 * @module wunderland/runtime/graph-runner
 *
 * This adapter lets Wunderland execute the new AgentOS orchestration graphs
 * using Wunderland's existing LLM/tool runtime, approvals, and tool registry.
 *
 * Scope:
 * - Supports `gmi`, `tool`, `router`, `guardrail`, and `human` nodes
 * - Reuses `runToolCallingTurn()` for GMI nodes
 * - Reuses the loaded Wunderland tool map for tool nodes
 * - Persists checkpoints through the injected `ICheckpointStore`
 *
 * Current limits:
 * - `extension` and `subgraph` nodes are not yet executed here
 * - discovery/personality edges are still limited by the underlying AgentOS runtime
 */

import {
  type CompiledExecutionGraph,
  type GraphExpansionHandler,
  type GraphNode,
  type GraphState,
  type GraphEvent,
  type ICheckpointStore,
  InMemoryCheckpointStore,
  GraphRuntime,
  NodeExecutor,
  type NodeExecutionResult,
} from './agentos-runtime.js';

import { runToolCallingTurn, safeJsonStringify, type LLMProviderConfig, type ToolInstance } from './tool-calling.js';
import { synthesizeEmptyOutputFallback } from './empty-output-fallback.js';

export type WunderlandGraphLike =
  | CompiledExecutionGraph
  | {
      toIR: () => CompiledExecutionGraph;
    };

export interface WunderlandGraphRunConfig {
  llm: {
    providerId?: string;
    apiKey: string | Promise<string>;
    model: string;
    baseUrl?: string;
    fallback?: LLMProviderConfig;
    getApiKey?: () => string | Promise<string>;
    ollamaOptions?: Record<string, unknown>;
  };
  llmByProvider?: Record<string, {
    providerId?: string;
    apiKey: string | Promise<string>;
    model?: string;
    baseUrl?: string;
    fallback?: LLMProviderConfig;
    getApiKey?: () => string | Promise<string>;
    ollamaOptions?: Record<string, unknown>;
  }>;
  systemPrompt: string;
  toolMap: Map<string, ToolInstance>;
  toolContext: Record<string, unknown>;
  askPermission: (tool: ToolInstance, args: Record<string, unknown>) => Promise<boolean>;
  checkpointStore?: ICheckpointStore;
  expansionHandler?: GraphExpansionHandler;
  reevalInterval?: number;
  strictToolNames?: boolean;
  debug?: boolean;
}

type GraphPayload =
  | {
      output?: unknown;
      scratch?: Record<string, unknown>;
      artifacts?: Record<string, unknown>;
      routeTarget?: string;
    }
  | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function stripJsonFence(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1]!.trim() : trimmed;
}

function toGraphExpansionRequest(
  toolName: string,
  args: Record<string, unknown>,
): NonNullable<NodeExecutionResult['expansionRequests']>[number] | null {
  if (toolName === 'request_expansion' && typeof args.need === 'string') {
    return {
      trigger: 'agent_request',
      reason: args.need,
      request: {
        need: args.need,
        urgency: typeof args.urgency === 'string' ? args.urgency : 'would_improve',
      },
    };
  }

  if (toolName === 'manage_graph' && typeof args.action === 'string') {
    return {
      trigger: 'supervisor_manage',
      reason: typeof args.reason === 'string' ? args.reason : args.action,
      request: {
        action: args.action,
        spec: isRecord(args.spec) ? args.spec : {},
        reason: typeof args.reason === 'string' ? args.reason : args.action,
      },
    };
  }

  return null;
}

function parseStructuredPayload(value: unknown): GraphPayload {
  if (isRecord(value)) {
    return value;
  }
  if (typeof value !== 'string') {
    return undefined;
  }

  const candidate = stripJsonFence(value);
  if (!candidate.startsWith('{') || !candidate.endsWith('}')) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(candidate);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeNodeResult(node: GraphNode, result: NodeExecutionResult): NodeExecutionResult {
  const payload = parseStructuredPayload(result.output);

  const explicitScratch = payload && isRecord(payload.scratch) ? payload.scratch : undefined;
  const explicitArtifacts = payload && isRecord(payload.artifacts) ? payload.artifacts : undefined;
  const explicitRouteTarget =
    payload && typeof payload.routeTarget === 'string' && payload.routeTarget.trim()
      ? payload.routeTarget.trim()
      : undefined;
  const explicitOutput =
    payload && Object.prototype.hasOwnProperty.call(payload, 'output')
      ? payload.output
      : result.output;

  const next: NodeExecutionResult = {
    ...result,
    output: explicitOutput,
    routeTarget: result.routeTarget ?? explicitRouteTarget,
    scratchUpdate: result.scratchUpdate ?? explicitScratch,
    artifactsUpdate: result.artifactsUpdate ?? explicitArtifacts,
  };

  if (!next.scratchUpdate && next.output !== undefined && node.type !== 'router' && node.type !== 'guardrail') {
    next.scratchUpdate = { [node.id]: next.output };
  }

  return next;
}

function buildNodePrompt(node: GraphNode, state: Partial<GraphState>, systemPrompt: string): Array<Record<string, unknown>> {
  const instructions =
    node.executorConfig.type === 'gmi'
      ? node.executorConfig.instructions
      : 'Execute the current orchestration node.';

  const context = safeJsonStringify(
    {
      input: state.input ?? {},
      scratch: state.scratch ?? {},
      artifacts: state.artifacts ?? {},
      visitedNodes: state.visitedNodes ?? [],
      iteration: state.iteration ?? 0,
    },
    12000,
  );

  return [
    {
      role: 'system',
      content: `${systemPrompt}

[Graph Node Execution]
You are executing orchestration node "${node.id}".

[Node Instructions]
${instructions}

[State Contract]
- Use the provided graph state as the source of truth.
- If you need to update graph state, return JSON like {"output":"...", "scratch": {...}, "artifacts": {...}}.
- Any other JSON object will be stored at scratch["${node.id}"].
- Plain text is allowed when no structured state update is needed.
- Do not fabricate tool results. Use tools when required.`,
    },
    {
      role: 'user',
      content: `Current graph state:\n${context}\n\nReturn the best result for node "${node.id}".`,
    },
  ];
}

class WunderlandNodeExecutor extends NodeExecutor {
  constructor(private readonly config: WunderlandGraphRunConfig) {
    super({
      toolOrchestrator: {
        processToolCall: async ({ toolCallRequest }) => {
          const tool = config.toolMap.get(toolCallRequest.toolName);
          if (!tool) {
            return { success: false, error: `Tool not found: ${toolCallRequest.toolName}` };
          }

          if (tool.hasSideEffects === true) {
            const allowed = await config.askPermission(tool, toolCallRequest.arguments);
            if (!allowed) {
              return {
                success: false,
                error: `Permission denied for tool: ${tool.name}`,
              };
            }
          }

          try {
            const output = await tool.execute(toolCallRequest.arguments, config.toolContext);
            return { success: true, output };
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        },
      },
    });
  }

  private resolveNodeLlm(node: GraphNode): WunderlandGraphRunConfig['llm'] {
    const override = node.llm;
    if (!override) {
      return this.config.llm;
    }

    const providerConfig = this.config.llmByProvider?.[override.providerId];
    if (providerConfig) {
      return {
        providerId: providerConfig.providerId ?? override.providerId,
        apiKey: providerConfig.apiKey,
        model: override.model || providerConfig.model || this.config.llm.model,
        baseUrl: providerConfig.baseUrl,
        fallback: providerConfig.fallback,
        getApiKey: providerConfig.getApiKey,
        ollamaOptions: providerConfig.ollamaOptions ?? this.config.llm.ollamaOptions,
      };
    }

    if (
      override.providerId === this.config.llm.providerId ||
      !this.config.llm.providerId
    ) {
      return {
        ...this.config.llm,
        model: override.model || this.config.llm.model,
      };
    }

    throw new Error(`No LLM config registered for graph node provider "${override.providerId}".`);
  }

  override async execute(node: GraphNode, state: Partial<GraphState>): Promise<NodeExecutionResult> {
    if (node.executorConfig.type === 'tool') {
      const tool = this.config.toolMap.get(node.executorConfig.toolName);
      if (!tool) {
        return {
          success: false,
          error: `Tool not found: ${node.executorConfig.toolName}`,
        };
      }

      const args = {
        ...(isRecord(state.input) ? state.input : {}),
        ...(isRecord(state.scratch) ? state.scratch : {}),
        ...(isRecord(state.artifacts) ? state.artifacts : {}),
        ...(node.executorConfig.args ?? {}),
      };

      if (tool.hasSideEffects === true) {
        const allowed = await this.config.askPermission(tool, args);
        if (!allowed) {
          return {
            success: false,
            error: `Permission denied for tool: ${tool.name}`,
          };
        }
      }

      try {
        const output = await tool.execute(args, this.config.toolContext);
        return normalizeNodeResult(node, {
          success: true,
          output,
        });
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    if (node.executorConfig.type === 'gmi') {
      const llm = this.resolveNodeLlm(node);
      const maxRounds =
        node.executionMode === 'single_turn'
          ? 1
          : Math.max(1, node.executorConfig.maxInternalIterations ?? 4);
      const emittedEvents: GraphEvent[] = [];
      const expansionRequests: NonNullable<NodeExecutionResult['expansionRequests']> = [];
      // Per-node telemetry counters + captured tool activity. The arrays
      // double as data for the empty-output fallback if runToolCallingTurn
      // returns an empty string after multiple tool calls (matching the
      // defense-in-depth fallback in agentos's NodeExecutor.executeGmi).
      let toolCallCount = 0;
      let toolErrorCount = 0;
      const fallbackResults: Array<{ name: string; content: string }> = [];
      const fallbackErrors: Array<{ name: string; error: string }> = [];
      // Per-node token usage and cost accumulators. Populated by the
      // onUsage callback fired once per LLM round in runToolCallingTurn —
      // omitted from the returned metadata when no usage data was seen
      // (e.g. an Ollama provider that doesn't report usage).
      let promptTokens = 0;
      let completionTokens = 0;
      let totalTokens = 0;
      let costUSD = 0;
      let sawUsage = false;

      const reply = await runToolCallingTurn({
        providerId: llm.providerId,
        apiKey: llm.apiKey,
        model: llm.model,
        messages: buildNodePrompt(node, state, this.config.systemPrompt),
        toolMap: this.config.toolMap,
        toolContext: this.config.toolContext,
        maxRounds,
        dangerouslySkipPermissions: false,
        strictToolNames: this.config.strictToolNames,
        askPermission: this.config.askPermission,
        baseUrl: llm.baseUrl,
        fallback: llm.fallback,
        getApiKey: llm.getApiKey,
        ollamaOptions: llm.ollamaOptions,
        onTextDelta: (content) => {
          emittedEvents.push({ type: 'text_delta', nodeId: node.id, content });
        },
        onToolCall: (tool, args) => {
          toolCallCount += 1;
          emittedEvents.push({
            type: 'tool_call',
            nodeId: node.id,
            toolName: tool.name,
            args,
          });
        },
        onToolResult: (info) => {
          if (info.success) {
            // Capture the output for the empty-output fallback. JSON.stringify
            // returns undefined for top-level undefined/functions and throws
            // on BigInt — the helper handles those by falling through to
            // String() at synthesis time, but we serialise here so the
            // captured snapshot doesn't share state with later mutations.
            const out = info.output;
            const content: string = typeof out === 'string'
              ? out
              : (() => {
                  try { return JSON.stringify(out) ?? String(out ?? ''); }
                  catch { return String(out ?? ''); }
                })();
            fallbackResults.push({ name: info.toolName, content });
          } else {
            toolErrorCount += 1;
            fallbackErrors.push({ name: info.toolName, error: String(info.error ?? 'unknown error') });
          }
          emittedEvents.push({
            type: 'tool_result',
            nodeId: node.id,
            toolName: info.toolName,
            result: {
              success: info.success,
              durationMs: info.durationMs,
              ...(info.output !== undefined ? { output: info.output } : {}),
              ...(info.error ? { error: info.error } : {}),
            },
          });

          if (info.success) {
            const request = toGraphExpansionRequest(info.toolName, info.args);
            if (request) {
              expansionRequests.push(request);
            }
          }
        },
        onUsage: (u) => {
          sawUsage = true;
          if (typeof u.prompt_tokens === 'number') promptTokens += u.prompt_tokens;
          if (typeof u.completion_tokens === 'number') completionTokens += u.completion_tokens;
          if (typeof u.total_tokens === 'number') totalTokens += u.total_tokens;
          if (typeof u.costUSD === 'number') costUSD += u.costUSD;
        },
        debug: this.config.debug,
      });

      // If the LLM returned no text but tools ran, synthesise a fallback so
      // downstream graph nodes have data to work with instead of an empty
      // string. We can't observe whether maxIterations was specifically the
      // termination reason from runToolCallingTurn (it returns only the
      // string), so iterationsExhausted is left false — the header will read
      // "no text response from model" which is accurate either way.
      const replyTrimmed = (reply ?? '').trim();
      const finalOutput = replyTrimmed.length === 0 && (fallbackResults.length > 0 || fallbackErrors.length > 0)
        ? synthesizeEmptyOutputFallback({
            results: fallbackResults,
            errors: fallbackErrors,
            iterationsExhausted: false,
          })
        : reply;

      return normalizeNodeResult(node, {
        success: true,
        output: finalOutput,
        events: emittedEvents,
        ...(expansionRequests.length > 0 ? { expansionRequests } : {}),
        metadata: {
          // toolCallCount is the total number of tool invocations; rounds is
          // bounded by maxRounds and at least 1 turn happened to get the reply.
          iterations: Math.max(1, toolCallCount),
          toolCalls: toolCallCount,
          toolErrors: toolErrorCount,
          // Token usage and cost are omitted when the provider didn't
          // surface any usage data (e.g. some self-hosted endpoints) so
          // downstream renderers can distinguish "missing" from "zero".
          ...(sawUsage ? {
            promptTokens,
            completionTokens,
            totalTokens,
            costUSD: costUSD > 0 ? costUSD : undefined,
          } : {}),
        },
      });
    }

    if (node.executorConfig.type === 'extension' || node.executorConfig.type === 'subgraph') {
      return {
        success: false,
        error: `${node.executorConfig.type} nodes are not yet executable through Wunderland's graph bridge`,
      };
    }

    const result = await super.execute(node, state);
    return normalizeNodeResult(node, result);
  }
}

export function resolveCompiledGraph(graph: WunderlandGraphLike): CompiledExecutionGraph {
  if (typeof (graph as { toIR?: unknown }).toIR === 'function') {
    return (graph as { toIR: () => CompiledExecutionGraph }).toIR();
  }
  return graph as CompiledExecutionGraph;
}

export function createWunderlandGraphRuntime(config: WunderlandGraphRunConfig): GraphRuntime {
  return new GraphRuntime({
    checkpointStore: config.checkpointStore ?? new InMemoryCheckpointStore(),
    nodeExecutor: new WunderlandNodeExecutor(config),
    expansionHandler: config.expansionHandler,
    reevalInterval: config.reevalInterval,
  });
}

export async function invokeWunderlandGraph(
  graph: WunderlandGraphLike,
  input: unknown,
  config: WunderlandGraphRunConfig,
): Promise<unknown> {
  const runtime = createWunderlandGraphRuntime(config);
  return runtime.invoke(resolveCompiledGraph(graph), input);
}

export async function* streamWunderlandGraph(
  graph: WunderlandGraphLike,
  input: unknown,
  config: WunderlandGraphRunConfig,
): AsyncIterable<GraphEvent> {
  const runtime = createWunderlandGraphRuntime(config);
  yield* runtime.stream(resolveCompiledGraph(graph), input);
}

export async function resumeWunderlandGraph(
  graph: WunderlandGraphLike,
  runOrCheckpointId: string,
  config: WunderlandGraphRunConfig,
): Promise<unknown> {
  const runtime = createWunderlandGraphRuntime(config);
  return runtime.resume(resolveCompiledGraph(graph), runOrCheckpointId);
}

export async function* streamResumeWunderlandGraph(
  graph: WunderlandGraphLike,
  runOrCheckpointId: string,
  config: WunderlandGraphRunConfig,
): AsyncIterable<GraphEvent> {
  const runtime = createWunderlandGraphRuntime(config);
  yield* runtime.streamResume(resolveCompiledGraph(graph), runOrCheckpointId);
}
