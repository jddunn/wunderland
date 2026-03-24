/**
 * @fileoverview Library-first Wunderland API (developer-friendly entrypoint).
 * @module wunderland/public
 *
 * Golden path:
 * ```ts
 * import { createWunderland } from 'wunderland';
 *
 * const app = await createWunderland({ llm: { providerId: 'openai' } });
 * const session = app.session();
 * const out = await session.sendText('Hello!');
 * console.log(out.text);
 * ```
 */

import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import { AgentMemory, type ITool } from '@framers/agentos';
import {
  AgentGraph as AgentGraphBuilder,
  mission as createMission,
  workflow as createWorkflow,
  type GraphState,
  type MemoryConsistencyMode,
  type StateReducers,
} from '@framers/agentos/orchestration';
import type { ICognitiveMemoryManager } from '@framers/agentos/memory';

import { createWunderlandTools, getToolAvailability } from '../tools/ToolRegistry.js';
import {
  runToolCallingTurn,
  safeJsonStringify,
  type ToolInstance,
} from '../runtime/tool-calling.js';
import { WunderlandAdaptiveExecutionRuntime } from '../runtime/adaptive-execution.js';
import { resolveStrictToolNames } from '../runtime/tool-function-names.js';
import { buildOllamaRuntimeOptions } from '../runtime/ollama-options.js';
import { planTurnToolDefinitions } from './turn-tool-selection.js';
import {
  filterToolMapByPolicy,
  getPermissionsForSet,
  normalizeRuntimePolicy,
  type NormalizedRuntimePolicy,
} from '../runtime/policy.js';
import { resolveAgentWorkspaceBaseDir, sanitizeAgentWorkspaceId } from '../runtime/workspace.js';
import { resolveAgentDisplayName } from '../runtime/agent-identity.js';
import { createEnvSecretResolver } from '../cli/security/env-secrets.js';
import { mergeExtensionOverrides } from '../cli/extensions/settings.js';

import type {
  WunderlandAdaptiveExecutionConfig,
  WunderlandAgentConfig,
  WunderlandTaskOutcomeTelemetryConfig,
  WunderlandWorkspace,
} from '../api/types.js';
import { WunderlandConfigError } from '../config/errors.js';
import { loadAgentConfig, resolveLlmConfig } from '../config/load.js';
import {
  buildDiscoveryOptionsFromAgentConfig,
  resolveEffectiveAgentConfig,
} from '../config/effective-agent-config.js';
import { WunderlandDiscoveryManager } from '../discovery/index.js';
import type { WunderlandDiscoveryConfig, DiscoverySkillEntry } from '../discovery/index.js';
import {
  createWunderlandSeed,
  DEFAULT_INFERENCE_HIERARCHY,
  DEFAULT_SECURITY_PROFILE,
  DEFAULT_STEP_UP_AUTH_CONFIG,
} from '../core/index.js';
import { resolveSkillContext } from '../core/resolve-skill-context.js';
import { createConfiguredRagTools } from '../rag/runtime-tools.js';
import { buildAgenticSystemPrompt } from '../runtime/system-prompt-builder.js';
import { createSpeechExtensionEnvOverrides } from '../voice/speech-catalog.js';
import { invokeWunderlandGraph, streamWunderlandGraph, type WunderlandGraphLike } from '../runtime/graph-runner.js';

// Public types extracted to types.ts
export type {
  WunderlandMessage,
  ToolCallRecord,
  WunderlandTurnResult,
  WunderlandDiagnostics,
  ToolApprovalRequest,
  WunderlandApprovalsMode,
  WunderlandOptions,
  WunderlandSession,
  WunderlandApp,
  WunderlandGraphLike,
} from './types.js';
import type {
  WunderlandMessage,
  ToolCallRecord,
  WunderlandDiagnostics,
  ToolApprovalRequest,
  WunderlandApprovalsMode,
  WunderlandOptions,
  WunderlandSession,
  WunderlandApp,
} from './types.js';


// =============================================================================
// Internal helpers
// =============================================================================

function consoleLogger(): Required<NonNullable<WunderlandOptions['logger']>> {
  return {
    debug: (msg, meta) => console.debug(msg, meta ?? ''),
    info: (msg, meta) => console.log(msg, meta ?? ''),
    warn: (msg, meta) => console.warn(msg, meta ?? ''),
    error: (msg, meta) => console.error(msg, meta ?? ''),
  };
}

function toPublicMessages(raw: Array<Record<string, unknown>>): WunderlandMessage[] {
  const out: WunderlandMessage[] = [];
  for (const msg of raw) {
    const role = typeof msg?.role === 'string' ? msg.role : '';
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
    const content = typeof msg?.content === 'string' ? msg.content : '';
    // Skip synthetic assistant tool-call frames that have no content.
    if (role === 'assistant' && !content.trim() && Array.isArray((msg as any)?.tool_calls)) continue;
    out.push({ role, content: String(content ?? '') });
  }
  return out;
}

function toToolInstance(tool: ITool): ToolInstance {
  const category =
    typeof (tool as any).category === 'string' && String((tool as any).category).trim()
      ? String((tool as any).category).trim()
      : 'productivity';

  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema as any,
    hasSideEffects: tool.hasSideEffects,
    category,
    requiredCapabilities: tool.requiredCapabilities,
    execute: ((input: any, context: any) => tool.execute(input, context)) as any,
  };
}

function resolveAgentMemory(
  input: WunderlandOptions['memory'],
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
  return AgentMemory.wrap(input as ICognitiveMemoryManager);
}

async function resolveToolMap(opts: {
  tools: WunderlandOptions['tools'];
  policy: NormalizedRuntimePolicy;
  logger: Required<NonNullable<WunderlandOptions['logger']>>;
}): Promise<{
  toolMap: Map<string, ToolInstance>;
  droppedByPolicy: Array<{ tool: string; reason: string }>;
  availability?: Record<string, { available: boolean; reason?: string }>;
}> {
  const permissions = getPermissionsForSet(opts.policy.permissionSet);

  const toolsOpt = opts.tools ?? 'none';
  const useCurated = toolsOpt === 'curated' || (typeof toolsOpt === 'object' && !!toolsOpt?.curated);
  const curatedConfig = typeof toolsOpt === 'object' ? toolsOpt.curated : undefined;
  const customTools = typeof toolsOpt === 'object' ? (toolsOpt.custom ?? []) : [];

  const rawTools: ITool[] = [];

  if (useCurated) {
    try {
      rawTools.push(...(await createWunderlandTools(curatedConfig)));
    } catch (err) {
      opts.logger.warn?.('[wunderland] failed to load curated tools (continuing without)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const t of customTools) rawTools.push(t);

  const toolMap = new Map<string, ToolInstance>();
  for (const t of rawTools) {
    if (!t?.name) continue;
    toolMap.set(t.name, toToolInstance(t));
  }

  const filtered = filterToolMapByPolicy({ toolMap, toolAccessProfile: opts.policy.toolAccessProfile, permissions });
  return {
    toolMap: filtered.toolMap,
    droppedByPolicy: filtered.dropped,
    availability: useCurated ? getToolAvailability(curatedConfig) : undefined,
  };
}

async function resolveSkillsFromOpts(opts: {
  skills: WunderlandOptions['skills'];
  agentConfig?: WunderlandAgentConfig;
  logger: Required<NonNullable<WunderlandOptions['logger']>>;
}): Promise<{
  skillsPrompt: string;
  skillEntries: DiscoverySkillEntry[];
  skillNames: string[];
}> {
  const empty = { skillsPrompt: '', skillEntries: [], skillNames: [] as string[] };
  const skillsOpt = opts.skills;
  const configSkills = Array.isArray(opts.agentConfig?.skills) ? opts.agentConfig.skills : [];

  // Collect all named skills (from option + preset, deduplicated)
  let namedSkills: string[] = [];
  let dirs: string[] = [];
  let includeDefaults = false;

  if (skillsOpt === 'all') {
    namedSkills = ['all'];
  } else if (Array.isArray(skillsOpt)) {
    namedSkills = [...skillsOpt];
  } else if (typeof skillsOpt === 'object' && skillsOpt !== null) {
    namedSkills = [...(skillsOpt.names ?? [])];
    dirs = [...(skillsOpt.dirs ?? [])];
    includeDefaults = skillsOpt.includeDefaults ?? false;
  }

  // Merge config-declared skills (dedup)
  if (configSkills.length > 0 && !namedSkills.includes('all')) {
    const existing = new Set(namedSkills);
    for (const name of configSkills) {
      if (!existing.has(name)) namedSkills.push(name);
    }
  }

  if (namedSkills.length === 0 && dirs.length === 0 && !includeDefaults) {
    return empty;
  }

  const promptParts: string[] = [];
  const scanDirs = [...dirs];
  if (includeDefaults) {
    const skillsMod: any = await import('../skills/index.js');
    const resolveDefaultSkillsDirs = skillsMod.resolveDefaultSkillsDirs;
    if (typeof resolveDefaultSkillsDirs === 'function') {
      scanDirs.push(...resolveDefaultSkillsDirs({ cwd: process.cwd() }));
    }
  }

  const resolved = await resolveSkillContext({
    filesystemDirs: scanDirs,
    curatedSkills: namedSkills.includes('all') ? 'all' : namedSkills,
    platform: process.platform,
    logger: opts.logger,
    warningPrefix: '[wunderland]',
  });

  if (resolved.skillsPrompt) {
    promptParts.push(resolved.skillsPrompt);
  }

  return {
    skillsPrompt: promptParts.filter(Boolean).join('\n\n'),
    skillEntries: resolved.skillEntries,
    skillNames: resolved.skillNames,
  };
}

async function resolveExtensionsFromOpts(opts: {
  extensions: WunderlandOptions['extensions'];
  agentConfig?: WunderlandAgentConfig;
  logger: Required<NonNullable<WunderlandOptions['logger']>>;
}): Promise<{
  extensionTools: ITool[];
  extensionNames: string[];
  mergedOverrides: Record<string, { enabled?: boolean; priority?: number; options?: unknown }>;
  cfgSecrets?: Record<string, string>;
  getSecret: (secretId: string) => string | undefined;
  secrets: Record<string, string>;
}> {
  const cfgSecrets =
    opts.agentConfig?.secrets && typeof opts.agentConfig.secrets === 'object' && !Array.isArray(opts.agentConfig.secrets)
      ? (opts.agentConfig.secrets as Record<string, string>)
      : undefined;
  const getSecret = createEnvSecretResolver({ configSecrets: cfgSecrets });
  const secrets = new Proxy<Record<string, string>>({} as any, {
    get: (_target, prop) => (typeof prop === 'string' ? getSecret(prop) : undefined),
  });
  const extOpt = opts.extensions;
  const configExt = opts.agentConfig?.extensions;

  // Collect extension names by category
  let toolExts = [...(configExt?.tools ?? [])];
  let voiceExts = [...(configExt?.voice ?? [])];
  let prodExts = [...(configExt?.productivity ?? [])];
  const overrides = mergeExtensionOverrides(
    (opts.agentConfig?.extensionOverrides as Record<string, any> | undefined) ?? {},
    (extOpt?.overrides as Record<string, any> | undefined) ?? {},
  );
  const empty = {
    extensionTools: [],
    extensionNames: [] as string[],
    mergedOverrides: {} as Record<string, { enabled?: boolean; priority?: number; options?: unknown }>,
    cfgSecrets,
    getSecret,
    secrets: secrets as Record<string, string>,
  };

  const mergeDedup = (target: string[], source: string[] | undefined) => {
    const existing = new Set(target);
    for (const name of source ?? []) {
      if (!existing.has(name)) target.push(name);
    }
  };
  mergeDedup(toolExts, extOpt?.tools);
  mergeDedup(voiceExts, extOpt?.voice);
  mergeDedup(prodExts, extOpt?.productivity);

  const envOverrides: Record<string, { options: Record<string, string | undefined> }> = {
    'web-search': {
      options: {
        serperApiKey: process.env['SERPER_API_KEY'],
        serpApiKey: process.env['SERPAPI_API_KEY'],
        braveApiKey: process.env['BRAVE_API_KEY'],
      },
    },
    'web-browser': {
      options: {
        headless: 'true',
        executablePath:
          process.env['PUPPETEER_EXECUTABLE_PATH'] ||
          process.env['CHROME_EXECUTABLE_PATH'] ||
          process.env['CHROME_PATH'] || '',
      },
    },
    giphy: { options: { giphyApiKey: process.env['GIPHY_API_KEY'] || '' } },
    'image-search': {
      options: {
        pexelsApiKey: process.env['PEXELS_API_KEY'],
        unsplashApiKey: process.env['UNSPLASH_ACCESS_KEY'],
        pixabayApiKey: process.env['PIXABAY_API_KEY'],
      },
    },
    ...createSpeechExtensionEnvOverrides(),
    'news-search': { options: { newsApiKey: process.env['NEWSAPI_API_KEY'] || '' } },
  };
  const mergedOverrides: Record<string, any> = mergeExtensionOverrides(
    envOverrides as Record<string, any>,
    overrides as Record<string, any>,
  );

  // Default extensions when none specified — matches CLI defaults
  if (toolExts.length === 0 && voiceExts.length === 0 && prodExts.length === 0) {
    toolExts = [
      'cli-executor', 'web-search', 'web-browser', 'content-extraction',
      'giphy', 'image-search', 'news-search', 'weather', 'deep-research', 'github',
    ];
  }

  try {
    const { resolveExtensionsByNames } = await import('../core/PresetExtensionResolver.js');

    const result = await resolveExtensionsByNames(toolExts, voiceExts, prodExts, mergedOverrides, {
      secrets: secrets as any,
    });

    if (result.missing.length > 0) {
      opts.logger.warn?.(`[wunderland] Some extensions not available: ${result.missing.join(', ')}`);
    }

    // Invoke factories and extract ITool instances from extension pack descriptors
    const tools: ITool[] = [];
    const names: string[] = [];

    for (const pack of result.manifest.packs) {
      try {
        const extensionPack = typeof pack.factory === 'function' ? await pack.factory() : null;
        if (!extensionPack || typeof extensionPack !== 'object') continue;

        // Extension packs return { name, version, descriptors, onActivate, onDeactivate }
        // Tools live inside descriptors[].payload where descriptor.kind === 'tool'
        const descriptors = (extensionPack as any).descriptors;
        if (Array.isArray(descriptors)) {
          for (const descriptor of descriptors) {
            if (descriptor?.kind === 'tool' && descriptor.payload && typeof descriptor.payload.execute === 'function') {
              tools.push(descriptor.payload as ITool);
              names.push(descriptor.payload.name ?? descriptor.name ?? pack.name);
            }
          }
        } else {
          // Fallback: maybe it's a flat tool or array of tools
          const toolArray = Array.isArray(extensionPack) ? extensionPack : [extensionPack];
          for (const instance of toolArray) {
            if (instance && typeof instance === 'object' && 'name' in instance && typeof (instance as any).execute === 'function') {
              tools.push(instance as ITool);
              names.push((instance as any).name);
            }
          }
        }
      } catch (err) {
        opts.logger.warn?.(`[wunderland] Failed to initialize extension pack "${pack.name}"`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      extensionTools: tools,
      extensionNames: names,
      mergedOverrides,
      cfgSecrets,
      getSecret,
      secrets: secrets as Record<string, string>,
    };
  } catch (err) {
    opts.logger.warn?.('[wunderland] Failed to resolve extensions (continuing without)', {
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      ...empty,
      mergedOverrides,
    };
  }
}

function buildLibrarySystemPrompt(agentConfig: WunderlandAgentConfig, policy: NormalizedRuntimePolicy, skillsPrompt?: string, lazyTools = false): string {
  const displayName = resolveAgentDisplayName({
    displayName: agentConfig.displayName,
    agentName: agentConfig.agentName,
    seedId: agentConfig.seedId,
    fallback: 'Wunderland Agent',
  });
  const personality = agentConfig.personality || {};
  const seed = createWunderlandSeed({
    seedId: String(agentConfig.seedId || 'seed_library'),
    name: displayName,
    description: agentConfig.bio || 'In-process agent runtime',
    hexacoTraits: {
      honesty_humility: Number.isFinite(personality.honesty) ? personality.honesty! : 0.8,
      emotionality: Number.isFinite(personality.emotionality) ? personality.emotionality! : 0.5,
      extraversion: Number.isFinite(personality.extraversion) ? personality.extraversion! : 0.6,
      agreeableness: Number.isFinite(personality.agreeableness) ? personality.agreeableness! : 0.7,
      conscientiousness: Number.isFinite(personality.conscientiousness) ? personality.conscientiousness! : 0.8,
      openness: Number.isFinite(personality.openness) ? personality.openness! : 0.7,
    },
    baseSystemPrompt: typeof agentConfig.systemPrompt === 'string' ? agentConfig.systemPrompt : undefined,
    securityProfile: DEFAULT_SECURITY_PROFILE,
    inferenceHierarchy: DEFAULT_INFERENCE_HIERARCHY,
    stepUpAuthConfig: DEFAULT_STEP_UP_AUTH_CONFIG,
  });

  return buildAgenticSystemPrompt({
    seed,
    policy,
    mode: 'library',
    lazyTools,
    autoApproveToolCalls: false,
    skillsPrompt: skillsPrompt || undefined,
  });
}

// =============================================================================
// Public entrypoint
// =============================================================================

export async function createWunderland(opts: WunderlandOptions = {}): Promise<WunderlandApp> {
  const memory = resolveAgentMemory(opts.memory);
  const baseLogger = consoleLogger();
  const logger: Required<NonNullable<WunderlandOptions['logger']>> = {
    debug: opts.logger?.debug ?? baseLogger.debug,
    info: opts.logger?.info ?? baseLogger.info,
    warn: opts.logger?.warn ?? baseLogger.warn,
    error: opts.logger?.error ?? baseLogger.error,
  };

  const workingDirectory = opts.workingDirectory ? path.resolve(opts.workingDirectory) : process.cwd();
  const loadedAgentConfig = await loadAgentConfig({ agentConfig: opts.agentConfig, configPath: opts.configPath, workingDirectory });
  const {
    agentConfig,
    preset: loadedPreset,
    selectedPersona,
    availablePersonas,
  } = await resolveEffectiveAgentConfig({
    agentConfig: loadedAgentConfig,
    workingDirectory,
    presetId: opts.preset,
    logger,
  });

  const policy = normalizeRuntimePolicy(agentConfig as any);
  const permissions = getPermissionsForSet(policy.permissionSet);

  const workspace: WunderlandWorkspace = {
    agentId: sanitizeAgentWorkspaceId(opts.workspace?.agentId ?? String(agentConfig.seedId || 'seed_local_agent')),
    baseDir: opts.workspace?.baseDir ?? resolveAgentWorkspaceBaseDir(),
  };

  const llm = await resolveLlmConfig({ agentConfig, llm: opts.llm });
  if (!llm.canUseLLM) {
    throw new WunderlandConfigError('No usable LLM credentials configured.', [
      {
        path: 'llm',
        message: `providerId=${llm.providerId} is not configured for use.`,
        hint: llm.providerId === 'openai'
          ? 'Set OPENAI_API_KEY or pass llm.apiKey.'
          : llm.providerId === 'openrouter'
            ? 'Set OPENROUTER_API_KEY or pass llm.apiKey.'
            : llm.providerId === 'anthropic'
              ? 'Set ANTHROPIC_API_KEY or pass llm.apiKey.'
              : llm.providerId === 'gemini'
                ? 'Set GEMINI_API_KEY or pass llm.apiKey.'
                : 'Configure the provider and retry.',
      },
    ]);
  }
  const strictToolNames = resolveStrictToolNames(
    opts.toolCalling?.strictToolNames ?? (agentConfig as any)?.toolCalling?.strictToolNames,
  );

  const approvalsMode: WunderlandApprovalsMode = opts.approvals?.mode ?? 'deny-side-effects';

  // When a preset is loaded, default to 'curated' (eagerly loaded tools).
  // Otherwise default to 'lazy' — meta tools only, agent discovers & enables packs on demand.
  const effectiveTools = opts.tools ?? (loadedPreset ? 'curated' : 'lazy');

  const { toolMap, droppedByPolicy, availability } = await resolveToolMap({
    tools: effectiveTools,
    policy,
    logger,
  });

  // Resolve named extensions → add their tools to toolMap
  const {
    extensionTools,
    mergedOverrides: extensionOverrides,
    getSecret: extensionGetSecret,
    secrets: extensionSecrets,
  } = await resolveExtensionsFromOpts({
    extensions: opts.extensions,
    agentConfig,
    logger,
  });
  for (const t of extensionTools) {
    if (t?.name) toolMap.set(t.name, toToolInstance(t));
  }

  for (const t of createConfiguredRagTools(agentConfig)) {
    if (t?.name) toolMap.set(t.name, toToolInstance(t));
  }

  // Resolve skills → get prompt text + entries for discovery indexing
  const { skillsPrompt, skillEntries, skillNames } = await resolveSkillsFromOpts({
    skills: opts.skills,
    agentConfig,
    logger,
  });

  // Capability discovery — semantic search + graph re-ranking for tool/skill context
  const discoveryOpts: WunderlandDiscoveryConfig = {
    ...buildDiscoveryOptionsFromAgentConfig(agentConfig),
    ...opts.discovery,
    config: {
      ...(buildDiscoveryOptionsFromAgentConfig(agentConfig).config ?? {}),
      ...(opts.discovery?.config ?? {}),
    },
  };
  const discoveryManager = new WunderlandDiscoveryManager(discoveryOpts);
  try {
    await discoveryManager.initialize({
      toolMap,
      skillEntries: skillEntries.length > 0 ? skillEntries : undefined,
      llmConfig: {
        providerId: llm.providerId,
        apiKey: llm.apiKey,
        baseUrl: llm.baseUrl,
      },
    });
    const metaTool = discoveryManager.getMetaTool();
    if (metaTool) {
      toolMap.set(metaTool.name, toToolInstance(metaTool));
    }
  } catch (err) {
    logger.warn?.('[wunderland] Discovery initialization failed (continuing without)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Schema-on-demand meta tools — always in lazy mode, optional in curated mode
  const isLazyMode = effectiveTools === 'lazy';
  if (isLazyMode || effectiveTools === 'curated') {
    try {
      const { createSchemaOnDemandTools } = await import('../cli/openai/schema-on-demand.js');
      const sodTools = createSchemaOnDemandTools({
        toolMap: toolMap as any,
        runtimeDefaults: {
          workingDirectory,
          headlessBrowser: true,
          dangerouslySkipCommandSafety: false,
          agentWorkspace: { agentId: workspace.agentId, baseDir: workspace.baseDir },
        },
        logger,
        secrets: extensionSecrets as any,
        getSecret: extensionGetSecret,
        defaultExtensionOptions: extensionOverrides as Record<string, Record<string, unknown>>,
        onToolsChanged: () => {
          // Best-effort re-index discovery with newly-loaded tools
          discoveryManager.reindex?.({ toolMap }).catch(() => {});
        },
      });
      for (const t of sodTools) {
        if (t?.name) toolMap.set(t.name, toToolInstance(t as any));
      }
    } catch (err) {
      logger.warn?.('[wunderland] Schema-on-demand tools failed to load (continuing without)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const telemetryConfig: WunderlandTaskOutcomeTelemetryConfig = {
    ...(agentConfig.taskOutcomeTelemetry ?? {}),
    ...(opts.taskOutcomeTelemetry ?? {}),
    storage: {
      ...(agentConfig.taskOutcomeTelemetry?.storage ?? {}),
      ...(opts.taskOutcomeTelemetry?.storage ?? {}),
    },
  };
  const adaptiveConfig: WunderlandAdaptiveExecutionConfig = {
    ...(agentConfig.adaptiveExecution ?? {}),
    ...(opts.adaptiveExecution ?? {}),
  };
  const adaptiveRuntime = new WunderlandAdaptiveExecutionRuntime({
    toolFailureMode: opts.toolFailureMode ?? agentConfig.toolFailureMode,
    taskOutcomeTelemetry: telemetryConfig,
    adaptiveExecution: adaptiveConfig,
    logger,
  });
  await adaptiveRuntime.initialize();
  const activePersonaId =
    typeof agentConfig.selectedPersonaId === 'string' && agentConfig.selectedPersonaId.trim()
      ? agentConfig.selectedPersonaId.trim()
      : String(agentConfig.seedId || workspace.agentId);

  const baseToolContext: Record<string, unknown> = {
    agentId: workspace.agentId,
    personaId: activePersonaId,
    securityTier: policy.securityTier,
    permissionSet: policy.permissionSet,
    toolAccessProfile: policy.toolAccessProfile,
    executionMode: 'human-all',
    wrapToolOutputs: policy.wrapToolOutputs,
    strictToolNames,
    ...(policy.folderPermissions ? { folderPermissions: policy.folderPermissions } : null),
    agentWorkspace: { agentId: workspace.agentId, baseDir: workspace.baseDir },
    workingDirectory,
  };

  const systemPrompt = buildLibrarySystemPrompt(agentConfig, policy, skillsPrompt, isLazyMode);

  const sessions = new Map<string, Array<Record<string, unknown>>>();

  /**
   * Stores named message-history snapshots created by {@link WunderlandSession.checkpoint}.
   * Key: opaque checkpoint ID; Value: frozen copy of the message history at checkpoint time.
   */
  const sessionCheckpoints = new Map<string, { messages: Array<Record<string, unknown>>; timestamp: number }>();

  const diagnostics = (): WunderlandDiagnostics => ({
    llm: {
      providerId: llm.providerId,
      model: llm.model,
      baseUrl: llm.baseUrl,
      canUseLLM: llm.canUseLLM,
      openaiFallbackEnabled: llm.openaiFallbackEnabled,
    },
    policy,
    approvals: { mode: approvalsMode },
    tools: {
      count: toolMap.size,
      names: [...toolMap.keys()].sort(),
      droppedByPolicy,
      availability,
    },
    skills: {
      count: skillNames.length,
      names: [...skillNames].sort(),
    },
    workspace: { agentId: workspace.agentId, baseDir: workspace.baseDir, workingDirectory },
    persona: {
      selectedId: activePersonaId !== String(agentConfig.seedId || workspace.agentId) ? activePersonaId : undefined,
      name: selectedPersona?.name,
      availableCount: availablePersonas?.length ?? 0,
    },
    discovery: discoveryManager.getStats(),
  });

  const session = (sessionId?: string): WunderlandSession => {
    const id = sessionId && sessionId.trim() ? sessionId.trim() : randomUUID();

    const getRawHistory = () => {
      const existing = sessions.get(id);
      if (existing) return existing;
      const initial: Array<Record<string, unknown>> = [{ role: 'system', content: systemPrompt }];
      sessions.set(id, initial);
      return initial;
    };

    const messages = () => toPublicMessages(getRawHistory());

    const sendText: WunderlandSession['sendText'] = async (text, sendOpts) => {
      const started = Date.now();
      const history = getRawHistory();
      const userText = String(text ?? '');
      history.push({ role: 'user', content: userText });

      const toolCalls: ToolCallRecord[] = [];
      const toolMessagesStartIdx = history.length;

      const onToolCall = (tool: ToolInstance, args: Record<string, unknown>) => {
        toolCalls.push({
          toolName: tool.name,
          hasSideEffects: tool.hasSideEffects === true,
          args,
          approved: false,
        });
      };

      const askPermission = async (tool: ToolInstance, args: Record<string, unknown>) => {
        const isSideEffect = tool.hasSideEffects === true;
        const preview = safeJsonStringify(args, 1800);
        const req: ToolApprovalRequest = {
          sessionId: id,
          tool: {
            name: tool.name,
            description: tool.description,
            hasSideEffects: tool.hasSideEffects,
            category: tool.category,
            requiredCapabilities: tool.requiredCapabilities,
          },
          args,
          preview,
        };

        let approved = false;
        if (approvalsMode === 'auto-all') {
          approved = true;
        } else if (approvalsMode === 'deny-side-effects') {
          approved = !isSideEffect;
        } else {
          // custom
          approved = !isSideEffect;
          if (isSideEffect && typeof opts.approvals?.onRequest === 'function') {
            approved = await opts.approvals.onRequest(req);
          }
        }

        const record = [...toolCalls].reverse().find((r) => r.toolName === tool.name && r.toolResult === undefined) ?? toolCalls[toolCalls.length - 1];
        if (record) {
          record.approved = approved;
          if (!approved) {
            record.deniedReason =
              approvalsMode === 'deny-side-effects'
                ? 'denied_by_default:side_effect_tool'
                : approvalsMode === 'custom'
                  ? 'denied_by_custom_approver'
                  : 'denied';
          }
        }

        return approved;
      };

      const userId = typeof sendOpts?.userId === 'string' && sendOpts.userId.trim()
        ? sendOpts.userId.trim()
        : (typeof opts.userId === 'string' && opts.userId.trim() ? opts.userId.trim() : 'local-user');

      const toolContext: Record<string, unknown> = {
        ...baseToolContext,
        sessionId: id,
        userContext: { userId },
        permissions,
      };

      const tenantId = typeof sendOpts?.tenantId === 'string' && sendOpts.tenantId.trim()
        ? sendOpts.tenantId.trim()
        : (
          typeof (agentConfig as any)?.organizationId === 'string' && String((agentConfig as any).organizationId).trim()
            ? String((agentConfig as any).organizationId).trim()
            : undefined
        );
      const adaptiveDecision = adaptiveRuntime.resolveTurnDecision({
        scope: {
          sessionId: id,
          userId,
          personaId: activePersonaId,
          tenantId,
        },
        requestedToolFailureMode: sendOpts?.toolFailureMode,
      });
      toolContext['toolFailureMode'] = adaptiveDecision.toolFailureMode;
      toolContext['adaptiveExecution'] = {
        degraded: adaptiveDecision.degraded,
        reason: adaptiveDecision.reason,
        actions: adaptiveDecision.actions,
        kpi: adaptiveDecision.kpi ?? undefined,
      };

      // Capability discovery — inject tiered context for this turn
      let discoveryResult: Awaited<ReturnType<typeof discoveryManager.discoverForTurn>> = null;
      try {
        discoveryResult = await discoveryManager.discoverForTurn(userText);
        if (discoveryResult) {
          // Remove stale discovery context from previous turns
          for (let i = history.length - 1; i >= 1; i--) {
            if (typeof history[i]?.content === 'string' && String(history[i]!.content).startsWith('[Capability Context]')) {
              history.splice(i, 1);
            }
          }
          // Build tiered context string
          const ctxParts: string[] = ['[Capability Context]', discoveryResult.tier0];
          if (discoveryResult.tier1.length > 0) {
            ctxParts.push('Relevant capabilities:\n' + discoveryResult.tier1.map((r) => r.summaryText).join('\n'));
          }
          if (discoveryResult.tier2.length > 0) {
            ctxParts.push(discoveryResult.tier2.map((r) => r.fullText).join('\n'));
          }
          // Insert after system prompt but before conversation history
          history.splice(1, 0, { role: 'system', content: ctxParts.join('\n') });
        }
      } catch {
        // Non-fatal — continue without discovery context
      }

      const baseToolCount = toolMap.size;
      let widenedToolDefsAfterRuntimeToolLoad = false;
      const getTurnToolDefs = () => {
        if (!widenedToolDefsAfterRuntimeToolLoad && toolMap.size !== baseToolCount) {
          widenedToolDefsAfterRuntimeToolLoad = true;
        }
        const plan = planTurnToolDefinitions({
          toolMap,
          discoveryResult,
          requestedMode: sendOpts?.toolSelectionMode,
          strictToolNames,
          forceAllTools:
            adaptiveDecision.actions?.forcedToolSelectionMode === true
            || widenedToolDefsAfterRuntimeToolLoad,
        });
        toolContext['toolSelectionMode'] = plan.mode;
        toolContext['toolSelectionReason'] = plan.reason;
        return plan.toolDefs;
      };

      let reply = '';
      let turnFailed = false;
      let fallbackTriggered = false;
      try {
        reply = await runToolCallingTurn({
          providerId: llm.providerId,
          apiKey: llm.apiKey,
          model: llm.model,
          messages: history,
          toolMap,
          toolContext,
          maxRounds: 8,
          dangerouslySkipPermissions: false,
          strictToolNames,
          askPermission,
          onToolCall,
          onToolResult: (info) => {
            // Mark the tool as approved if it executed (step-up auth approved it)
            if (info.success || info.error) {
              const record = [...toolCalls].reverse().find(
                (r) => r.toolName === info.toolName && r.approved === false && r.toolResult === undefined,
              );
              if (record) {
                record.approved = true;
                record.toolResult = info.error
                  ? JSON.stringify({ error: info.error })
                  : undefined;
              }
            }
          },
          toolFailureMode: adaptiveDecision.toolFailureMode,
          getToolDefs: getTurnToolDefs,
          baseUrl: llm.baseUrl,
          ollamaOptions: buildOllamaRuntimeOptions(agentConfig.ollama),
          fallback: llm.fallback,
          getApiKey: llm.getApiKey,
          onFallback: () => {
            fallbackTriggered = true;
          },
        });
      } catch (error) {
        turnFailed = true;
        throw error;
      } finally {
        try {
          await adaptiveRuntime.recordTurnOutcome({
            scope: {
              sessionId: id,
              userId,
              personaId: activePersonaId,
              tenantId,
            },
            degraded: adaptiveDecision.degraded || fallbackTriggered,
            replyText: reply,
            didFail: turnFailed,
            toolCallCount: toolCalls.length,
          });
        } catch (error) {
          logger.warn?.('[wunderland] failed to record adaptive telemetry outcome', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Attach tool outputs (best-effort, ordered).
      const newToolMsgs = history.slice(toolMessagesStartIdx).filter((m) => m?.role === 'tool') as any[];
      for (let i = 0; i < toolCalls.length && i < newToolMsgs.length; i += 1) {
        toolCalls[i]!.toolResult = typeof newToolMsgs[i]?.content === 'string' ? newToolMsgs[i].content : String(newToolMsgs[i]?.content ?? '');
      }

      return {
        text: reply,
        messages: toPublicMessages(history),
        toolCalls,
        meta: {
          providerId: llm.providerId,
          model: llm.model,
          sessionId: id,
          elapsedMs: Math.max(0, Date.now() - started),
        },
      };
    };

    /**
     * Thin streaming wrapper around {@link sendText}.
     * Executes the turn normally then yields synthetic {@link GraphEvent} objects that mirror
     * the run_start → node_start → text_delta → node_end → run_end lifecycle used by
     * {@link WunderlandApp.streamGraph}, enabling uniform event-driven UI updates.
     */
    const stream: WunderlandSession['stream'] = async function* (text, opts) {
      const startTime = Date.now();
      yield { type: 'run_start' as const, runId: id, graphId: 'session' } as any;
      yield { type: 'node_start' as const, nodeId: 'turn', state: { input: { text } } } as any;
      const result = await sendText(text, opts);
      yield { type: 'text_delta' as const, nodeId: 'turn', content: result.text } as any;
      yield {
        type: 'node_end' as const,
        nodeId: 'turn',
        output: result.text,
        durationMs: Date.now() - startTime,
      } as any;
      yield {
        type: 'run_end' as const,
        runId: id,
        finalOutput: result,
        totalDurationMs: Date.now() - startTime,
      } as any;
    };

    /**
     * Snapshot the current session message history.
     * Returns an opaque checkpoint ID that can be passed to {@link resume}.
     */
    const checkpoint: WunderlandSession['checkpoint'] = async () => {
      const cpId = `session-${id}-${Date.now()}`;
      // Deep-copy the current history so future mutations don't corrupt the snapshot.
      sessionCheckpoints.set(cpId, {
        messages: getRawHistory().map((m) => ({ ...m })),
        timestamp: Date.now(),
      });
      return cpId;
    };

    /**
     * Restore the session message history from a previously saved checkpoint.
     * Throws a descriptive error if the checkpoint ID is not found.
     */
    const resume: WunderlandSession['resume'] = async (checkpointId) => {
      const cp = sessionCheckpoints.get(checkpointId);
      if (!cp) {
        throw new Error(
          `[wunderland] Checkpoint "${checkpointId}" not found. ` +
          'Ensure you called session.checkpoint() before attempting to resume.',
        );
      }
      // Replace the live history with a mutable copy of the saved snapshot.
      const restored = cp.messages.map((m) => ({ ...m }));
      sessions.set(id, restored);
    };

    return { id, messages, sendText, stream, checkpoint, resume };
  };

  const close = async () => {
    await discoveryManager.close();
    await adaptiveRuntime.close();
    sessions.clear();
  };

  const agentGraph: WunderlandApp['agentGraph'] = <TState extends GraphState = GraphState>(
    stateSchema: { input: any; scratch: any; artifacts: any },
    config?: {
      reducers?: StateReducers;
      memoryConsistency?: MemoryConsistencyMode;
      checkpointPolicy?: 'every_node' | 'explicit' | 'none';
    },
  ) => new AgentGraphBuilder<TState>(stateSchema, config);

  const workflow: WunderlandApp['workflow'] = (name) => createWorkflow(name);
  const mission: WunderlandApp['mission'] = (name) => createMission(name);

  const runGraph: WunderlandApp['runGraph'] = async (graph, input, runOpts) => {
    const sessionId =
      typeof runOpts?.sessionId === 'string' && runOpts.sessionId.trim()
        ? runOpts.sessionId.trim()
        : `graph-${randomUUID()}`;
    const userId =
      typeof runOpts?.userId === 'string' && runOpts.userId.trim()
        ? runOpts.userId.trim()
        : (typeof opts.userId === 'string' && opts.userId.trim() ? opts.userId.trim() : 'local-user');
    const tenantId =
      typeof runOpts?.tenantId === 'string' && runOpts.tenantId.trim()
        ? runOpts.tenantId.trim()
        : (
          typeof (agentConfig as any)?.organizationId === 'string' && String((agentConfig as any).organizationId).trim()
            ? String((agentConfig as any).organizationId).trim()
            : undefined
        );

    const toolContext: Record<string, unknown> = {
      ...baseToolContext,
      sessionId,
      userContext: { userId },
      permissions,
      toolFailureMode: runOpts?.toolFailureMode ?? opts.toolFailureMode ?? agentConfig.toolFailureMode,
      orchestrationMode: 'graph-runtime',
      ...(tenantId ? { tenantId } : null),
    };

    const askPermission = async (tool: ToolInstance, args: Record<string, unknown>) => {
      const isSideEffect = tool.hasSideEffects === true;
      const preview = safeJsonStringify(args, 1800);
      const req: ToolApprovalRequest = {
        sessionId,
        tool: {
          name: tool.name,
          description: tool.description,
          hasSideEffects: tool.hasSideEffects,
          category: tool.category,
          requiredCapabilities: tool.requiredCapabilities,
        },
        args,
        preview,
      };

      if (approvalsMode === 'auto-all') return true;
      if (approvalsMode === 'deny-side-effects') return !isSideEffect;
      if (!isSideEffect) return true;
      if (typeof opts.approvals?.onRequest === 'function') {
        return opts.approvals.onRequest(req);
      }
      return false;
    };

    return invokeWunderlandGraph(graph as WunderlandGraphLike, input, {
      llm: {
        providerId: llm.providerId,
        apiKey: llm.apiKey,
        model: llm.model,
        baseUrl: llm.baseUrl,
        fallback: llm.fallback,
        getApiKey: llm.getApiKey,
        ollamaOptions: buildOllamaRuntimeOptions(agentConfig.ollama),
      },
      systemPrompt,
      toolMap,
      toolContext,
      askPermission,
      strictToolNames,
      debug: runOpts?.debug,
    });
  };

  const streamGraph: WunderlandApp['streamGraph'] = (graph, input, runOpts) => {
    const sessionId =
      typeof runOpts?.sessionId === 'string' && runOpts.sessionId.trim()
        ? runOpts.sessionId.trim()
        : `graph-${randomUUID()}`;
    const userId =
      typeof runOpts?.userId === 'string' && runOpts.userId.trim()
        ? runOpts.userId.trim()
        : (typeof opts.userId === 'string' && opts.userId.trim() ? opts.userId.trim() : 'local-user');
    const tenantId =
      typeof runOpts?.tenantId === 'string' && runOpts.tenantId.trim()
        ? runOpts.tenantId.trim()
        : (
          typeof (agentConfig as any)?.organizationId === 'string' && String((agentConfig as any).organizationId).trim()
            ? String((agentConfig as any).organizationId).trim()
            : undefined
        );

    const toolContext: Record<string, unknown> = {
      ...baseToolContext,
      sessionId,
      userContext: { userId },
      permissions,
      toolFailureMode: runOpts?.toolFailureMode ?? opts.toolFailureMode ?? agentConfig.toolFailureMode,
      orchestrationMode: 'graph-runtime',
      ...(tenantId ? { tenantId } : null),
    };

    const askPermission = async (tool: ToolInstance, args: Record<string, unknown>) => {
      const isSideEffect = tool.hasSideEffects === true;
      const preview = safeJsonStringify(args, 1800);
      const req: ToolApprovalRequest = {
        sessionId,
        tool: {
          name: tool.name,
          description: tool.description,
          hasSideEffects: tool.hasSideEffects,
          category: tool.category,
          requiredCapabilities: tool.requiredCapabilities,
        },
        args,
        preview,
      };

      if (approvalsMode === 'auto-all') return true;
      if (approvalsMode === 'deny-side-effects') return !isSideEffect;
      if (!isSideEffect) return true;
      if (typeof opts.approvals?.onRequest === 'function') {
        return opts.approvals.onRequest(req);
      }
      return false;
    };

    return streamWunderlandGraph(graph as WunderlandGraphLike, input, {
      llm: {
        providerId: llm.providerId,
        apiKey: llm.apiKey,
        model: llm.model,
        baseUrl: llm.baseUrl,
        fallback: llm.fallback,
        getApiKey: llm.getApiKey,
        ollamaOptions: buildOllamaRuntimeOptions(agentConfig.ollama),
      },
      systemPrompt,
      toolMap,
      toolContext,
      askPermission,
      strictToolNames,
      debug: runOpts?.debug,
    });
  };

  /**
   * Read a workflow YAML file and return a compiled descriptor that can be executed with
   * {@link WunderlandApp.runGraph} or {@link WunderlandApp.streamGraph}.
   *
   * The YAML is expected to follow the Wunderland workflow schema (nodes + edges).
   * Requires `js-yaml` to be installed at runtime; throws a descriptive error if absent.
   */
  const loadWorkflow: WunderlandApp['loadWorkflow'] = async (yamlPath) => {
    const { readFile } = await import('node:fs/promises');
    let jsYaml: { load: (s: string) => unknown };
    try {
      jsYaml = await import('js-yaml') as any;
    } catch {
      throw new Error('[wunderland] loadWorkflow requires "js-yaml" — run: npm install js-yaml');
    }
    const content = await readFile(yamlPath, 'utf-8');
    const raw = jsYaml.load(content) as Record<string, unknown>;
    return { ...raw, __source: yamlPath, __type: 'workflow' };
  };

  /**
   * Read a mission YAML file and return a compiled descriptor that can be executed with
   * {@link WunderlandApp.runGraph} or {@link WunderlandApp.streamGraph}.
   *
   * Missions are multi-step goal definitions with sub-tasks; they share the same YAML
   * loading pipeline as workflows but carry a different `__type` tag.
   */
  const loadMission: WunderlandApp['loadMission'] = async (yamlPath) => {
    const { readFile } = await import('node:fs/promises');
    let jsYaml: { load: (s: string) => unknown };
    try {
      jsYaml = await import('js-yaml') as any;
    } catch {
      throw new Error('[wunderland] loadMission requires "js-yaml" — run: npm install js-yaml');
    }
    const content = await readFile(yamlPath, 'utf-8');
    const raw = jsYaml.load(content) as Record<string, unknown>;
    return { ...raw, __source: yamlPath, __type: 'mission' };
  };

  /**
   * Discover workflow and mission YAML files under the current working directory.
   * Scans `<workingDirectory>/workflows/` for workflow files and
   * `<workingDirectory>/missions/` for mission files (non-recursive, `.yaml` / `.yml`).
   * Returns synchronously using a pre-scanned cache; safe to call in render loops.
   */
  const listWorkflows: WunderlandApp['listWorkflows'] = () => {
    // Synchronous best-effort scan using require('fs') to keep the API synchronous.
    // Failures (e.g. directory absent) are silently swallowed and return an empty list.
    try {
      const fs = require('node:fs') as typeof import('node:fs');
      const entries: Array<{ name: string; path: string; type: 'workflow' | 'mission' }> = [];

      const scan = (dir: string, type: 'workflow' | 'mission') => {
        try {
          const files = fs.readdirSync(dir);
          for (const file of files) {
            if (file.endsWith('.yaml') || file.endsWith('.yml')) {
              entries.push({ name: path.basename(file, path.extname(file)), path: path.join(dir, file), type });
            }
          }
        } catch {
          // Directory absent — ignore.
        }
      };

      scan(path.join(workingDirectory, 'workflows'), 'workflow');
      scan(path.join(workingDirectory, 'missions'), 'mission');
      return entries;
    } catch {
      return [];
    }
  };

  return { session, diagnostics, agentGraph, workflow, mission, runGraph, streamGraph, loadWorkflow, loadMission, listWorkflows, memory, close };
}

// Convenience re-exports for library consumers (types only).
export type { WunderlandAgentConfig, WunderlandProviderId, WunderlandWorkspace } from '../api/types.js';
export { WunderlandConfigError } from '../config/errors.js';
export type { WunderlandConfigIssue } from '../config/errors.js';
