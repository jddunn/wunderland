// @ts-nocheck
/**
 * @fileoverview `wunderland mission` — natural language missions, YAML files, or explain.
 *
 * Three entry modes:
 *   1. `wunderland mission "Research AI papers and write a blog post"` — NL goal
 *   2. `wunderland mission run <file.yaml>` — YAML mission file
 *   3. `wunderland mission explain <file.yaml>` — preview plan without executing
 *
 * NL mode uses the Tree of Thought MissionPlanner with configurable autonomy,
 * provider strategy, cost caps, and streaming CLI output via MissionStreamRenderer.
 *
 * @module wunderland/cli/commands/mission
 */

import { resolveRuntimeConfig } from './workflows.js';
import { shutdownWunderlandOtel, startWunderlandOtel } from '../../observability/otel.js';
import type { GlobalFlags } from '../types.js';
import type { ProviderStrategyConfig, ProviderStrategyName } from '@framers/agentos/orchestration';

const SUBCOMMANDS = new Set(['run', 'explain', 'help']);

/**
 * Render a node/run output as a human-friendly string for report files.
 * Strings pass through unchanged; objects/arrays are pretty-printed JSON.
 */
function stringifyForReport(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Format the optional GMI telemetry attached to a `node_end` event into a
 * compact one-line summary for inclusion in mission reports. Returns an
 * empty string when telemetry is absent or empty.
 */
function formatTelemetry(t?: {
  iterations?: number;
  toolCalls?: number;
  toolErrors?: number;
  iterationsExhausted?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUSD?: number;
}): string {
  if (!t) return '';
  const hasActivity = t.iterations || t.toolCalls || t.toolErrors;
  const hasUsage = t.totalTokens || t.costUSD;
  if (!hasActivity && !hasUsage) return '';
  const parts: string[] = [];
  if (t.iterations !== undefined) parts.push(`${t.iterations} iteration${t.iterations === 1 ? '' : 's'}`);
  if (t.toolCalls) parts.push(`${t.toolCalls} tool call${t.toolCalls === 1 ? '' : 's'}`);
  if (t.toolErrors) parts.push(`${t.toolErrors} tool error${t.toolErrors === 1 ? '' : 's'}`);
  if (t.iterationsExhausted) parts.push('hit max-iter cap');
  // Token usage and cost — token count is the primary signal users want
  // for tuning maxIterations/parallelTools; dollar cost is only shown
  // when the provider returned it so we don't display "$0" misleadingly
  // when usage was tracked but pricing wasn't computed.
  if (typeof t.totalTokens === 'number' && t.totalTokens > 0) {
    parts.push(`${t.totalTokens.toLocaleString()} tokens`);
  }
  if (typeof t.costUSD === 'number' && t.costUSD > 0) {
    // Three decimals so sub-cent rounds show up; very small calls show
    // as e.g. $0.001 instead of $0.00.
    parts.push(`$${t.costUSD.toFixed(3)}`);
  }
  return parts.join(', ');
}

type MissionProviderCandidate = {
  env: string;
  id: string;
  runtimeId: string;
  baseUrlEnv?: string;
  defaultBaseUrl?: string;
  apiKeyLiteral?: string;
};

function resolveProviderBaseUrl(
  candidate: MissionProviderCandidate,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return (candidate.baseUrlEnv ? env[candidate.baseUrlEnv] : undefined) ?? candidate.defaultBaseUrl;
}

function resolveProviderApiKey(
  candidate: MissionProviderCandidate,
  env: NodeJS.ProcessEnv,
): string | undefined {
  return candidate.apiKeyLiteral ?? env[candidate.env];
}

export default async function missionCommand(
  args: string[],
  flags?: Record<string, string | boolean>,
  globals?: GlobalFlags,
): Promise<void> {
  // Load .env files into process.env so curated tool secrets (PEXELS_API_KEY,
  // UNSPLASH_ACCESS_KEY, GIPHY_API_KEY, etc.) and provider keys flow through
  // to ToolRegistry.buildSecretsMap and resolveRuntimeConfig the same way they
  // do for `wunderland chat` and `wunderland start`.
  // Without this, missions invoked from a directory without an `.env` would
  // see only the parent shell's environment and silently skip optional tools.
  const { loadDotEnvIntoProcessUpward } = await import('../config/env-manager.js');
  await loadDotEnvIntoProcessUpward({
    startDir: process.cwd(),
    configDirOverride: globals?.config,
  });

  const first = args[0] ?? 'help';

  // -----------------------------------------------------------------------
  // NL goal mode: first arg is NOT a known subcommand → treat as goal string
  // -----------------------------------------------------------------------
  if (first && !SUBCOMMANDS.has(first)) {
    await runNaturalLanguageMission(first, flags ?? {}, globals);
    return;
  }

  const subcommand = first;

  switch (subcommand) {
    case 'run': {
      const target = args[1];
      if (!target) { console.error('Usage: wunderland mission run <file> [--input \'{"key":"val"}\']'); return; }
      if (/\.(mjs|js|ts)$/i.test(target)) {
        console.error('wunderland mission run executes YAML/JSON mission definitions. Run code-authored graphs with node/tsx and createWunderland().runGraph(...).');
        process.exitCode = 1;
        return;
      }
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const { compileMissionYaml } = await import('../../orchestration/yaml-compiler.js');
      const { createWunderland } = await import('../../public/index.js');

      const yamlPath = resolve(process.cwd(), target);
      const content = await readFile(yamlPath, 'utf-8');

      // Parse the YAML once up front so we can decide whether the LLM-
      // driven planner needs an llmCaller before compileMissionYaml runs.
      const yaml = await import('yaml');
      const { MissionCompiler } = await import('@framers/agentos/orchestration');
      const docForStyle = yaml.parse(content) as { planner?: { style?: string }; goal?: string } | null;
      const explicitStyle = docForStyle?.planner?.style;

      // Build an llmCaller for the 'llm' planner style. Reuses the runtime
      // LLM config (provider, apiKey, model, baseUrl) so the planner uses
      // the same provider the agent will use to execute. The result is a
      // simple prompt-string → response-string function — generateLlmPlan
      // wraps the JSON parsing and validation.
      //
      // 1024 max_tokens is plenty for a 2-8 step JSON plan and stays well
      // under most pay-as-you-go credit ceilings; using 2000 hit OpenRouter
      // 402 errors on accounts with small balances.
      let compileOpts: { llmCaller?: (prompt: string) => Promise<string> } | undefined = undefined;
      if (explicitStyle === 'llm') {
        const baseRuntime = resolveRuntimeConfig();
        const { chatCompletionsRequest } = await import('../../runtime/tool-helpers.js');
        compileOpts = {
          llmCaller: async (prompt: string) => {
            const result = await chatCompletionsRequest(
              {
                providerId: String(baseRuntime.llm.providerId ?? 'openai'),
                apiKey: baseRuntime.llm.apiKey as any,
                model: String(baseRuntime.llm.model),
                baseUrl: baseRuntime.llm.baseUrl,
              } as any,
              [{ role: 'user', content: prompt }],
              [], // no tools — pure text completion
              0.2,
              1024,
            );
            return String(result.message.content ?? '');
          },
        };
      }

      const compiled = compileOpts
        ? await compileMissionYaml(content, compileOpts)
        : compileMissionYaml(content);
      const ir = compiled.toIR();

      // Resolve the planner style for display so the user can see WHICH
      // template the mission ran under and WHY (explicit YAML field vs
      // auto-classified from the goal). Useful when an unexpected plan
      // shape shows up in the report.
      const resolvedStyle = explicitStyle
        ?? MissionCompiler.classifyGoal(String(docForStyle?.goal ?? ''));
      const styleLabel = explicitStyle
        ? `${resolvedStyle} (explicit)`
        : `${resolvedStyle} (auto-classified)`;

      // Parse --input flag
      const inputFlag = flags?.['input'] as string | undefined;
      let input: Record<string, unknown> = {};
      if (inputFlag) {
        try {
          input = JSON.parse(inputFlag);
        } catch (e: any) {
          console.error('Invalid JSON input: ' + e.message);
          process.exitCode = 1;
          return;
        }
      }

      // Parse --output / --format flags
      const outputFlag = flags?.['output'] ?? flags?.['o'];
      const outputPath = typeof outputFlag === 'string' && outputFlag.trim() ? outputFlag.trim() : '';
      const formatRaw = typeof flags?.['format'] === 'string' ? String(flags['format']).toLowerCase().trim() : '';
      const explicitFormat = (['md', 'markdown', 'json', 'txt', 'text'].includes(formatRaw))
        ? (formatRaw === 'markdown' ? 'md' : formatRaw === 'text' ? 'txt' : (formatRaw as 'md' | 'json' | 'txt'))
        : '';
      // Format inferred from output path extension if not given explicitly.
      const inferredFormat = (() => {
        if (!outputPath) return '';
        const ext = outputPath.toLowerCase().split('.').pop();
        if (ext === 'json') return 'json';
        if (ext === 'md' || ext === 'markdown') return 'md';
        if (ext === 'txt' || ext === 'text') return 'txt';
        return '';
      })();
      const format: 'md' | 'json' | 'txt' = (explicitFormat || inferredFormat || 'md') as 'md' | 'json' | 'txt';

	      const baseRuntime = resolveRuntimeConfig();
        const runtimeProviderId = String(baseRuntime.llm.providerId ?? 'openai');
        const runtimeModel = String(baseRuntime.llm.model);
	      await startWunderlandOtel({ serviceName: 'wunderland-mission' });
	      const app = await createWunderland({
          configDirOverride: globals?.config,
	        llm: {
          providerId: runtimeProviderId as any,
          apiKey: baseRuntime.llm.apiKey as any,
          model: runtimeModel,
          baseUrl: baseRuntime.llm.baseUrl,
        },
        tools: 'curated',
        approvals: { mode: 'auto-all' },
      });

      console.log(`\n  ● Mission: ${ir.name}  ·  style: ${styleLabel}`);
      const startTime = Date.now();

      // Collect node outputs + run_end finalOutput so we can write a report file.
      // `telemetry` carries the GMI executor's iteration / tool-call counters
      // when present (older agentos releases will leave it undefined).
      type NodeTelemetry = {
        iterations?: number;
        toolCalls?: number;
        toolErrors?: number;
        iterationsExhausted?: boolean;
        promptTokens?: number;
        completionTokens?: number;
        totalTokens?: number;
        costUSD?: number;
      };
      const nodeOutputs: Array<{
        nodeId: string;
        output: unknown;
        durationMs: number;
        telemetry?: NodeTelemetry;
      }> = [];
      let finalOutput: unknown = undefined;
      const errors: Array<{ nodeId?: string; message: string; code: string }> = [];

      try {
        for await (const event of app.streamGraph(compiled, input)) {
          if (event.type === 'node_start') process.stdout.write(`  ├── running ${event.nodeId}...`);
          if (event.type === 'node_end') {
            const tele = (event as any).telemetry as NodeTelemetry | undefined;
            const teleSuffix = tele?.iterations
              ? ` (${tele.iterations} iter${tele.iterations === 1 ? '' : 's'}` +
                (tele.toolCalls ? `, ${tele.toolCalls} tool${tele.toolCalls === 1 ? '' : 's'}` : '') +
                (tele.toolErrors ? `, ${tele.toolErrors} err${tele.toolErrors === 1 ? '' : 's'}` : '') +
                (tele.iterationsExhausted ? ', max-iter' : '') +
                (typeof tele.totalTokens === 'number' && tele.totalTokens > 0 ? `, ${tele.totalTokens.toLocaleString()} tok` : '') +
                (typeof tele.costUSD === 'number' && tele.costUSD > 0 ? `, $${tele.costUSD.toFixed(3)}` : '') +
                ')'
              : '';
            process.stdout.write(` [${event.durationMs}ms${teleSuffix}]\n`);
            nodeOutputs.push({
              nodeId: event.nodeId,
              output: event.output,
              durationMs: event.durationMs,
              telemetry: tele,
            });
          }
          if (event.type === 'run_end') {
            finalOutput = event.finalOutput;
          }
          if (event.type === 'error') {
            console.error(`  ├── error: ${event.error.message}`);
            errors.push({ nodeId: event.nodeId, message: event.error.message, code: event.error.code });
          }
        }
	      } finally {
	        await app.close();
	        await shutdownWunderlandOtel();
	      }

      const totalMs = Date.now() - startTime;
      console.log(`  └── ✓ complete [${totalMs}ms]\n`);

      // Write report if --output given OR if -o given. (Silent default: don't write
      // anywhere; preserves prior behavior for users who don't pass the flag.)
      if (outputPath) {
        const { writeFile, mkdir } = await import('node:fs/promises');
        const path = await import('node:path');
        const absPath = path.isAbsolute(outputPath)
          ? outputPath
          : path.resolve(process.cwd(), outputPath);
        // Treat as a directory only when path ends with a separator. A bare name
        // like "report" or "out/today" is a file — we just append the format
        // extension if one wasn't given.
        const endsWithSep = absPath.endsWith(path.sep) || absPath.endsWith('/');
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const safeName = (ir.name.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 60) || 'mission');
        const finalPath = (() => {
          if (endsWithSep) return path.join(absPath, `mission-${safeName}-${ts}.${format}`);
          if (!path.extname(absPath)) return `${absPath}.${format}`;
          return absPath;
        })();
        await mkdir(path.dirname(finalPath), { recursive: true });

        let body: string;
        if (format === 'json') {
          body = JSON.stringify({
            mission: ir.name,
            style: { resolved: resolvedStyle, explicit: !!explicitStyle },
            input,
            finalOutput,
            nodes: nodeOutputs,
            errors,
            totalDurationMs: totalMs,
            timestamp: new Date().toISOString(),
          }, null, 2);
        } else if (format === 'txt') {
          const parts: string[] = [
            `Mission: ${ir.name}`,
            `Style: ${styleLabel}`,
            `Started: ${new Date(startTime).toISOString()}`,
            `Duration: ${totalMs}ms`,
            '',
          ];
          if (finalOutput !== undefined) {
            parts.push('=== Final Output ===', stringifyForReport(finalOutput), '');
          }
          for (const n of nodeOutputs) {
            const tele = formatTelemetry(n.telemetry);
            const header = tele
              ? `--- ${n.nodeId} (${n.durationMs}ms — ${tele}) ---`
              : `--- ${n.nodeId} (${n.durationMs}ms) ---`;
            parts.push(header, stringifyForReport(n.output), '');
          }
          if (errors.length) {
            parts.push('=== Errors ===');
            for (const e of errors) parts.push(`[${e.code}] ${e.nodeId ?? '<graph>'}: ${e.message}`);
          }
          body = parts.join('\n');
        } else {
          // markdown
          const parts: string[] = [
            `# Mission: ${ir.name}`,
            '',
            `- Style: ${styleLabel}`,
            `- Started: ${new Date(startTime).toISOString()}`,
            `- Duration: ${totalMs}ms`,
            `- Nodes: ${nodeOutputs.length}`,
            '',
          ];
          if (finalOutput !== undefined) {
            parts.push('## Final Output', '', '```', stringifyForReport(finalOutput), '```', '');
          }
          if (nodeOutputs.length) {
            parts.push('## Node Outputs', '');
            for (const n of nodeOutputs) {
              const tele = formatTelemetry(n.telemetry);
              const header = tele
                ? `### ${n.nodeId} (${n.durationMs}ms — ${tele})`
                : `### ${n.nodeId} (${n.durationMs}ms)`;
              parts.push(header, '', '```', stringifyForReport(n.output), '```', '');
            }
          }
          if (errors.length) {
            parts.push('## Errors', '');
            for (const e of errors) parts.push(`- **[${e.code}] ${e.nodeId ?? '<graph>'}**: ${e.message}`);
          }
          body = parts.join('\n');
        }

        await writeFile(finalPath, body, 'utf8');
        console.log(`  ◆ Report written: ${finalPath}\n`);
      }
      break;
    }
    case 'explain': {
      const target = args[1];
      if (!target) { console.error('Usage: wunderland mission explain <file>'); return; }
      const { readFile } = await import('node:fs/promises');
      const { resolve } = await import('node:path');
      const { compileMissionYaml } = await import('../../orchestration/yaml-compiler.js');
      const yamlPath = resolve(process.cwd(), target);
      const content = await readFile(yamlPath, 'utf-8');
      const compiled = compileMissionYaml(content);
      const plan = await compiled.explain({});
      console.log(`\n  Mission Plan:`);
      for (const step of plan.steps) {
        console.log(`  ├── ${step.id} (${step.type})`);
      }
      console.log();
      break;
    }
    default:
      console.log(`
Usage:
  wunderland mission "<goal>"                       Natural language mission
  wunderland mission run <file.yaml> [--input '{}'  YAML mission file
  wunderland mission explain <file.yaml>            Preview plan

YAML Mission Flags:
  --input '<json>'            Mission input as JSON object
  --output <path>             Write report to file or directory.
                              Format inferred from extension; if path is a
                              directory, a default filename is generated.
  --format <md|json|txt>      Override format detection (default: md)

NL Mission Flags:
  --autonomy <mode>           autonomous | guided | guardrailed (default: guardrailed)
  --provider-strategy <name>  best | cheapest | balanced | explicit | mixed (default: balanced)
  --cost-cap <dollars>        Maximum spend in USD (default: 10.00)
  --max-agents <count>        Maximum concurrent agents (default: 10)
  --branches <count>          Tree of Thought branches (default: 3)
  --planner-model <model>     Model for ToT planning (e.g. claude-opus-4-6)
  --execution-model <model>   Model for agent execution (e.g. gpt-5.4)
  --verbose                   Show planning phases, scores, checkpoints
  --json                      Raw JSON event stream (one per line)
  --quiet                     Final output + cost summary only
  --resume <checkpoint-id>    Resume from a saved checkpoint
`);
  }
}

// ---------------------------------------------------------------------------
// Natural Language Mission Runner
// ---------------------------------------------------------------------------

async function runNaturalLanguageMission(
  goal: string,
  flags: Record<string, string | boolean>,
  globals?: GlobalFlags,
): Promise<void> {
  // Lazy imports to avoid loading heavy modules for help/explain
  const {
    DEFAULT_THRESHOLDS,
    ManageGraphTool,
    MissionPlanner,
    RequestExpansionTool,
    buildSplitCallers,
    createMissionExpansionHandler,
  } = await import('@framers/agentos/orchestration');
  const { resolveModelOption } = await import('@framers/agentos');
  const { MissionStreamRenderer } = await import('../renderers/MissionStreamRenderer.js');
  const { createWunderland } = await import('../../public/index.js');

  // Parse flags
  const autonomy = (String(flags['autonomy'] ?? 'guardrailed')) as 'autonomous' | 'guided' | 'guardrailed';
  const providerStrategy = String(flags['provider-strategy'] ?? flags['providerStrategy'] ?? 'balanced');
  const costCap = parseFloat(String(flags['cost-cap'] ?? flags['costCap'] ?? '10.00'));
  const maxAgents = parseInt(String(flags['max-agents'] ?? flags['maxAgents'] ?? '10'), 10);
  const branchCount = parseInt(String(flags['branches'] ?? '3'), 10);
  const plannerModelFlag = flags['planner-model'] as string | undefined;
  const executionModelFlag = flags['execution-model'] as string | undefined;
  const verbose = flags['verbose'] === true;
  const json = flags['json'] === true;
  const quiet = flags['quiet'] === true;

  // Determine output mode
  const outputMode = json ? 'json' as const : quiet ? 'quiet' as const : verbose ? 'verbose' as const : 'default' as const;
  const renderer = new MissionStreamRenderer(outputMode);

  // Build wunderland runtime for LLM access
  await startWunderlandOtel({ serviceName: 'wunderland-mission' });
  const baseRuntime = resolveRuntimeConfig();
  const runtimeProviderId = String(baseRuntime.llm.providerId ?? 'openai');
  const runtimeModel = String(baseRuntime.llm.model);
  const runtimeApiKey = await Promise.resolve(baseRuntime.llm.apiKey);
  const app = await createWunderland({
    configDirOverride: globals?.config,
    llm: {
      providerId: runtimeProviderId as any,
      apiKey: baseRuntime.llm.apiKey as any,
      model: runtimeModel,
      baseUrl: baseRuntime.llm.baseUrl,
    },
    tools: {
      curated: {},
      custom: [new RequestExpansionTool(), new ManageGraphTool()],
    },
    approvals: {
      mode: autonomy === 'autonomous' ? 'auto-all' : 'custom',
      onRequest: async (approval) =>
        approval.tool.name === 'request_expansion'
        || approval.tool.name === 'manage_graph',
    },
  });

  try {
    // Build LLM callers — supports ALL provider types including CLI (claude-code-cli, gemini-cli)
    // Uses the full AgentOS provider resolution chain: resolveModelOption → resolveProvider → createProviderManager
    const plannerProvider = plannerModelFlag?.includes('/') ? plannerModelFlag.split('/')[0] : undefined;
    const plannerModel = plannerModelFlag?.includes('/') ? plannerModelFlag.split('/')[1] : plannerModelFlag;
    const execProvider = executionModelFlag?.includes('/') ? executionModelFlag.split('/')[0] : undefined;
    const execModel = executionModelFlag?.includes('/') ? executionModelFlag.split('/')[1] : executionModelFlag;

    const { plannerCaller, executionCaller, plannerModel: resolvedPlannerModel, executionModel: resolvedExecModel } =
      await buildSplitCallers(
        {
          provider: plannerProvider ?? runtimeProviderId,
          model: plannerModel ?? runtimeModel,
          apiKey: runtimeApiKey,
          baseUrl: baseRuntime.llm.baseUrl,
        },
        executionModelFlag
          ? {
              provider: execProvider ?? runtimeProviderId,
              model: execModel ?? runtimeModel,
              apiKey: runtimeApiKey,
              baseUrl: baseRuntime.llm.baseUrl,
            }
          : undefined, // Same as planner if not specified
      );

    if (verbose) {
      console.log(`  Planner model: ${resolvedPlannerModel}`);
      console.log(`  Execution model: ${resolvedExecModel}`);
    }

    // Detect available execution providers and build node-level runtime overrides.
    const availableProviders: string[] = [];
    const providerConfigs: Record<string, { providerId?: string; apiKey: string; model?: string; baseUrl?: string }> = {};
    const providerEnvMap = [
      { env: 'OPENROUTER_API_KEY', id: 'openrouter', runtimeId: 'openrouter', defaultBaseUrl: 'https://openrouter.ai/api/v1' },
      { env: 'OPENAI_API_KEY', id: 'openai', runtimeId: 'openai', baseUrlEnv: 'OPENAI_BASE_URL' },
      { env: 'ANTHROPIC_API_KEY', id: 'anthropic', runtimeId: 'anthropic', baseUrlEnv: 'ANTHROPIC_BASE_URL' },
      { env: 'GEMINI_API_KEY', id: 'gemini', runtimeId: 'gemini', baseUrlEnv: 'GEMINI_BASE_URL', defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' },
      { env: 'GROQ_API_KEY', id: 'groq', runtimeId: 'openai', baseUrlEnv: 'GROQ_BASE_URL', defaultBaseUrl: 'https://api.groq.com/openai/v1' },
      { env: 'TOGETHER_API_KEY', id: 'together', runtimeId: 'openai', baseUrlEnv: 'TOGETHER_BASE_URL', defaultBaseUrl: 'https://api.together.xyz/v1' },
      { env: 'MISTRAL_API_KEY', id: 'mistral', runtimeId: 'openai', baseUrlEnv: 'MISTRAL_BASE_URL', defaultBaseUrl: 'https://api.mistral.ai/v1' },
      { env: 'XAI_API_KEY', id: 'xai', runtimeId: 'openai', baseUrlEnv: 'XAI_BASE_URL', defaultBaseUrl: 'https://api.x.ai/v1' },
      { env: 'OLLAMA_BASE_URL', id: 'ollama', runtimeId: 'ollama', baseUrlEnv: 'OLLAMA_BASE_URL', defaultBaseUrl: 'http://localhost:11434/v1', apiKeyLiteral: 'ollama' },
    ] as const satisfies readonly MissionProviderCandidate[];
    for (const candidate of providerEnvMap) {
      if (!process.env[candidate.env]) continue;
      const resolved = resolveModelOption({ provider: candidate.id }, 'text');
      const baseUrl = resolveProviderBaseUrl(candidate, process.env);
      providerConfigs[candidate.id] = {
        providerId: candidate.runtimeId,
        apiKey: String(resolveProviderApiKey(candidate, process.env) || '').trim(),
        model: resolved.modelId,
        baseUrl,
      };
      availableProviders.push(candidate.id);
    }
    if (!providerConfigs[runtimeProviderId]) {
      providerConfigs[runtimeProviderId] = {
        providerId: runtimeProviderId,
        apiKey: runtimeApiKey,
        model: runtimeModel,
        baseUrl: baseRuntime.llm.baseUrl,
      };
    }
    if (!availableProviders.includes(runtimeProviderId)) {
      availableProviders.push(runtimeProviderId);
    }

    // Discover available tools from the wunderland runtime
    const toolList = ((app as {
      listTools?: () => Array<{ name: string; description: string }>;
    }).listTools?.() ?? []).map((t) => ({
      name: t.name,
      description: t.description,
    }));

    // Parse explicit provider assignments from strategy string
    // e.g. "claude for research, gpt-4o for writing" or just "balanced"
    let strategyConfig: ProviderStrategyConfig;
    if (['best', 'cheapest', 'balanced'].includes(providerStrategy)) {
      strategyConfig = { strategy: providerStrategy as ProviderStrategyName };
    } else {
      // Treat as NL provider assignment — pass through, planner will parse
      strategyConfig = { strategy: 'mixed', fallback: 'balanced' };
    }

    // Build planner — uses split callers for planner vs execution models
    const planner = new MissionPlanner({
      branchCount,
      autonomy,
      providerStrategy: strategyConfig,
      thresholds: { ...DEFAULT_THRESHOLDS, maxTotalCost: costCap, maxAgentCount: maxAgents },
      costCap,
      maxAgents,
      maxToolForges: 5,
      maxExpansions: 8,
      maxDepth: 3,
      reevalInterval: 3,
      llmCaller: executionCaller,
      plannerLlmCaller: plannerCaller,
      plannerModel: resolvedPlannerModel,
      executionModel: resolvedExecModel,
    });

    // Run planning pipeline with event streaming
    const result = await planner.plan(
      goal,
      { tools: toolList, providers: availableProviders },
      (event) => renderer.render(event as any),
    );

    // Log assignments in verbose mode
    if (verbose) {
      console.log('\n  Provider assignments:');
      for (const a of result.selectedBranch.providerAssignments) {
        console.log(`    ${a.nodeId}: ${a.provider}/${a.model} (complexity: ${a.complexity.toFixed(2)})`);
      }
    }

    // Execute the compiled graph through the wunderland runtime
    const startTime = Date.now();
    const expansionHandler = createMissionExpansionHandler({
      autonomy,
      thresholds: { ...DEFAULT_THRESHOLDS, maxTotalCost: costCap, maxAgentCount: maxAgents },
      llmCaller: plannerCaller,
      costCap,
      maxAgents,
      availableTools: toolList,
      availableProviders,
      providerStrategy: strategyConfig,
      defaultLlm: {
        providerId: runtimeProviderId,
        model: runtimeModel,
      },
      initialEstimatedCost: result.selectedBranch.estimatedCost,
    });

    for await (const event of app.streamGraph(result.compiledGraph, {}, {
      llmByProvider: providerConfigs,
      expansionHandler,
      reevalInterval: 3,
    })) {
      renderer.render(event as any);
    }

    // Emit completion event
    renderer.render({
      type: 'mission:complete',
      summary: result.selectedBranch.summary,
      totalCost: result.selectedBranch.estimatedCost,
      totalDurationMs: Date.now() - startTime,
      agentCount: result.compiledGraph.nodes.length,
    });
  } finally {
    await app.close();
    await shutdownWunderlandOtel();
  }
}
